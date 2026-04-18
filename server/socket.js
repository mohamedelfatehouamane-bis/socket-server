const path = require('path')
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') })
const http = require('http')
const express = require('express')
const jwt = require('jsonwebtoken')
const { Server } = require('socket.io')
const { createClient } = require('@supabase/supabase-js')
const { telegramService } = require('./telegram-service')

const PORT = Number(process.env.SOCKET_PORT || 3001)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'
const FRONTEND_ORIGIN =
  process.env.SOCKET_CORS_ORIGIN || process.env.CLIENT_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const ORDER_ACTIONS = {
  ACCEPT_ORDER: 'accept_order',
  COMPLETE_ORDER: 'complete_order',
  CANCEL_ORDER: 'cancel_order',
  REPORT_DISPUTE: 'report_dispute',
  VALIDATE_ORDER: 'validate_order',
  TOPUP_REQUEST: 'topup_request',
  WITHDRAW_REQUEST: 'withdraw_request',
}

const ALLOWED_ORDER_ACTION_ROLES = {
  [ORDER_ACTIONS.ACCEPT_ORDER]: ['seller'],
  [ORDER_ACTIONS.COMPLETE_ORDER]: ['seller'],
  [ORDER_ACTIONS.CANCEL_ORDER]: ['customer', 'seller', 'admin'],
  [ORDER_ACTIONS.REPORT_DISPUTE]: ['customer', 'seller'],
  [ORDER_ACTIONS.VALIDATE_ORDER]: ['admin'],
  [ORDER_ACTIONS.TOPUP_REQUEST]: ['customer'],
  [ORDER_ACTIONS.WITHDRAW_REQUEST]: ['seller'],
}

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    'Missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
  )
}

const db = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  path: '/socket.io',
  allowEIO3: true,
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  },
})

function isOrderMessagesTableMissing(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()

  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    (message.includes('order_messages') &&
      (message.includes('schema cache') ||
        message.includes('does not exist') ||
        message.includes('could not find the table')))
  )
}

function getSocketToken(socket) {
  const authToken = socket.handshake?.auth?.token
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken
  }

  const headerToken = socket.handshake?.headers?.authorization
  if (typeof headerToken === 'string' && headerToken.startsWith('Bearer ')) {
    return headerToken.slice(7)
  }

  return null
}

async function getAuthorizedOrder(orderId, user) {
  const { data: order, error } = await db
    .from('orders')
    .select('id, customer_id, assigned_seller_id')
    .eq('id', orderId)
    .single()

  if (error || !order) {
    return { ok: false, error: 'Order not found' }
  }

  const canAccess =
    user?.role === 'admin' || order.customer_id === user?.id || order.assigned_seller_id === user?.id

  if (!canAccess) {
    return { ok: false, error: 'Unauthorized' }
  }

  return { ok: true, order }
}

async function buildFormattedMessage(message, fallbackSender) {
  const senderId = message.sender_id
  const { data: sender } = senderId
    ? await db
        .from('users')
        .select('username, avatar_url')
        .eq('id', senderId)
        .maybeSingle()
    : { data: null }

  return {
    id: message.id,
    content: message.content,
    created_at: message.created_at,
    sender: {
      username: sender?.username || fallbackSender?.username || 'Unknown User',
      avatar_url: sender?.avatar_url || null,
    },
  }
}

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter
// Max RATE_LIMIT_MAX messages per RATE_LIMIT_WINDOW_MS per user.
// Entries are cleaned up on each check and on socket disconnect.
// ---------------------------------------------------------------------------
const MESSAGE_RATE_LIMIT_WINDOW_MS = 10_000
const MESSAGE_RATE_LIMIT_MAX = 10
/** @type {Map<string, number[]>} userId → array of send timestamps */
const messageRateLimits = new Map()

function checkRateLimit(userId) {
  const now = Date.now()
  const windowStart = now - MESSAGE_RATE_LIMIT_WINDOW_MS
  const timestamps = (messageRateLimits.get(userId) ?? []).filter((ts) => ts > windowStart)

  if (timestamps.length >= MESSAGE_RATE_LIMIT_MAX) {
    messageRateLimits.set(userId, timestamps)
    return false
  }

  timestamps.push(now)
  messageRateLimits.set(userId, timestamps)
  return true
}

function clearRateLimit(userId) {
  messageRateLimits.delete(userId)
}

// ---------------------------------------------------------------------------
// Room presence: orderId → Map<userId, Set<socketId>>
// Handles users with multiple tabs open — a user is "online" while any of
// their sockets are present in the room.
// ---------------------------------------------------------------------------
/** @type {Map<string, Map<string, Set<string>>>} */
const roomPresence = new Map()

/** @returns {boolean} true when this is the user's first socket in the room */
function joinRoomPresence(orderId, userId, socketId) {
  if (!roomPresence.has(orderId)) roomPresence.set(orderId, new Map())
  const room = roomPresence.get(orderId)
  if (!room.has(userId)) room.set(userId, new Set())
  const sockets = room.get(userId)
  sockets.add(socketId)
  return sockets.size === 1
}

/** @returns {boolean} true when this was the user's last socket in the room */
function leaveRoomPresence(orderId, userId, socketId) {
  const room = roomPresence.get(orderId)
  if (!room) return false
  const sockets = room.get(userId)
  if (!sockets) return false
  sockets.delete(socketId)
  if (sockets.size === 0) {
    room.delete(userId)
    if (room.size === 0) roomPresence.delete(orderId)
    return true
  }
  return false
}

function getRoomOnlineUserIds(orderId) {
  const room = roomPresence.get(orderId)
  if (!room) return []
  return Array.from(room.keys())
}

function isUserOnlineInRoom(orderId, userId) {
  const room = roomPresence.get(orderId)
  if (!room) return false
  const sockets = room.get(userId)
  return Boolean(sockets && sockets.size > 0)
}

// Cooldown to avoid duplicate Telegram notifications for bursts of messages.
const TELEGRAM_NOTIFY_COOLDOWN_MS = 30_000
/** @type {Map<string, number>} key: `${orderId}:${receiverUserId}` */
const lastTelegramNotifyAt = new Map()

function canSendTelegramNotify(orderId, receiverUserId) {
  const key = `${orderId}:${receiverUserId}`
  const now = Date.now()
  const lastSent = lastTelegramNotifyAt.get(key) ?? 0
  if (now - lastSent < TELEGRAM_NOTIFY_COOLDOWN_MS) {
    return false
  }

  lastTelegramNotifyAt.set(key, now)
  return true
}

function buildOfflineChatTelegramMessage({ orderId, senderLabel, senderUsername, content }) {
  const trimmed = String(content ?? '').trim()
  const preview = trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed

  return [
    `💬 New message about your order #${orderId}`,
    `From: ${senderLabel}${senderUsername ? ` (${senderUsername})` : ''}`,
    `Message: ${preview}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Typing indicator — server auto-broadcasts typing_stop after silence
// ---------------------------------------------------------------------------
/** @type {Map<string, ReturnType<typeof setTimeout>>} key: `${orderId}:${userId}` */
const typingTimeouts = new Map()
const TYPING_TIMEOUT_MS = 4000

function scheduleTypingStop(io, orderId, userId) {
  const key = `${orderId}:${userId}`
  const existing = typingTimeouts.get(key)
  if (existing !== undefined) clearTimeout(existing)
  const t = setTimeout(() => {
    typingTimeouts.delete(key)
    io.to(`order_${orderId}`).emit('typing_stop', { orderId, userId })
  }, TYPING_TIMEOUT_MS)
  typingTimeouts.set(key, t)
}

function clearTypingForSocket(socket) {
  if (!socket.joinedOrderIds) return
  for (const orderId of socket.joinedOrderIds) {
    const key = `${orderId}:${socket.user.id}`
    const t = typingTimeouts.get(key)
    if (t !== undefined) {
      clearTimeout(t)
      typingTimeouts.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// order_message_reads table-missing guard (table added in migration 15)
// ---------------------------------------------------------------------------
function isMessageReadsTableMissing(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    (message.includes('order_message_reads') &&
      (message.includes('schema cache') ||
        message.includes('does not exist') ||
        message.includes('could not find the table')))
  )
}

io.use((socket, next) => {
  try {
    const token = getSocketToken(socket)
    if (!token) {
      return next(new Error('Unauthorized'))
    }

    const payload = jwt.verify(token, JWT_SECRET)
    if (!payload || typeof payload !== 'object' || !payload.id) {
      return next(new Error('Unauthorized'))
    }

    socket.user = {
      id: payload.id,
      email: payload.email,
      username: payload.username,
      role: payload.role,
      seller_id: payload.seller_id,
    }

    next()
  } catch {
    next(new Error('Unauthorized'))
  }
})

io.on('connection', (socket) => {
  console.log('User connected:', socket.id)

  /** @type {Set<string>} order IDs this socket has joined */
  socket.joinedOrderIds = new Set()

  if (socket.user?.role === 'admin') {
    socket.join('admin')
  }

  socket.on('join_order', async (orderId, ack) => {
    try {
      if (!orderId || typeof orderId !== 'string') {
        ack?.({ success: false, error: 'Invalid order id' })
        return
      }

      const access = await getAuthorizedOrder(orderId, socket.user)
      if (!access.ok) {
        ack?.({ success: false, error: access.error })
        return
      }

      socket.join(`order_${orderId}`)
      socket.joinedOrderIds.add(orderId)

      const isFirstSocket = joinRoomPresence(orderId, socket.user.id, socket.id)
      if (isFirstSocket) {
        socket.to(`order_${orderId}`).emit('user_online', {
          orderId,
          userId: socket.user.id,
          username: socket.user.username || 'Unknown User',
        })
      }

      ack?.({ success: true, onlineUserIds: getRoomOnlineUserIds(orderId) })
    } catch (error) {
      console.error('join_order error:', error)
      ack?.({ success: false, error: 'Unable to join order room' })
    }
  })

  socket.on('leave_order', (orderId) => {
    if (!orderId || typeof orderId !== 'string') {
      return
    }

    socket.leave(`order_${orderId}`)
    socket.joinedOrderIds.delete(orderId)

    const wasLast = leaveRoomPresence(orderId, socket.user.id, socket.id)
    if (wasLast) {
      socket.to(`order_${orderId}`).emit('user_offline', {
        orderId,
        userId: socket.user.id,
      })
    }
  })

  socket.on('order_action', async (payload, ack) => {
    try {
      const orderId = payload?.orderId
      const action = payload?.action
      const data = payload?.data

      if (!orderId || typeof orderId !== 'string') {
        ack?.({ success: false, error: 'Invalid order id' })
        return
      }

      if (!action || typeof action !== 'string') {
        ack?.({ success: false, error: 'Invalid action type' })
        return
      }

      const access = await getAuthorizedOrder(orderId, socket.user)
      if (!access.ok) {
        ack?.({ success: false, error: access.error })
        return
      }

      if (!socket.joinedOrderIds.has(orderId)) {
        ack?.({ success: false, error: 'Socket has not joined this order room' })
        return
      }

      const allowedRoles = ALLOWED_ORDER_ACTION_ROLES[action]
      if (!allowedRoles) {
        ack?.({ success: false, error: 'Unsupported order action' })
        return
      }

      if (!allowedRoles.includes(socket.user.role)) {
        ack?.({ success: false, error: 'Unauthorized to perform this action' })
        return
      }

      const eventPayload = {
        orderId,
        action,
        data,
        userId: socket.user.id,
        username: socket.user.username || 'Unknown User',
        created_at: new Date().toISOString(),
      }

      io.to(`order_${orderId}`).emit('order_action', eventPayload)
      io.to('admin').emit('order_action', eventPayload)

      ack?.({ success: true })
    } catch (error) {
      console.error('order_action error:', error)
      ack?.({ success: false, error: 'Unable to perform order action' })
    }
  })

  socket.on('send_message', async (payload, ack) => {
    try {
      const orderId = payload?.orderId
      const content = typeof payload?.message === 'string' ? payload.message.trim() : ''

      if (!orderId || typeof orderId !== 'string') {
        ack?.({ success: false, error: 'Invalid order id' })
        return
      }

      if (!content) {
        ack?.({ success: false, error: 'Message cannot be empty' })
        return
      }

      if (content.length > 1000) {
        ack?.({ success: false, error: 'Message cannot exceed 1000 characters' })
        return
      }

      if (!checkRateLimit(socket.user.id)) {
        ack?.({ success: false, error: 'Rate limit exceeded. Please slow down.' })
        return
      }

      const access = await getAuthorizedOrder(orderId, socket.user)
      if (!access.ok) {
        ack?.({ success: false, error: access.error })
        return
      }

      const { data: inserted, error: insertError } = await db
        .from('order_messages')
        .insert({
          order_id: orderId,
          sender_id: socket.user.id,
          content,
        })
        .select('id, sender_id, content, created_at')
        .single()

      if (insertError || !inserted) {
        if (isOrderMessagesTableMissing(insertError)) {
          ack?.({
            success: false,
            code: 'CHAT_NOT_CONFIGURED',
            error: 'Order chat is not configured yet. Please contact support.',
          })
          return
        }

        console.error('send_message insert error:', insertError)
        ack?.({ success: false, error: 'Unable to save message' })
        return
      }

      const formattedMessage = await buildFormattedMessage(inserted, socket.user)

      io.to(`order_${orderId}`).emit('new_message', formattedMessage)
      ack?.({ success: true, message: formattedMessage })

      // Telegram fallback: notify the other order participant only when offline.
      // This runs after ACK and broadcast, and is intentionally non-blocking.
      const order = access.order
      const receiverUserId =
        socket.user.id === order.customer_id ? order.assigned_seller_id : order.customer_id

      if (!receiverUserId || receiverUserId === socket.user.id) {
        return
      }

      if (isUserOnlineInRoom(orderId, receiverUserId)) {
        return
      }

      if (!canSendTelegramNotify(orderId, receiverUserId)) {
        return
      }

      const { data: receiver, error: receiverError } = await db
        .from('users')
        .select('telegram_id, username')
        .eq('id', receiverUserId)
        .maybeSingle()

      if (receiverError || !receiver?.telegram_id) {
        return
      }

      if (!telegramService.isValidChatId(receiver.telegram_id)) {
        return
      }

      const senderLabel =
        socket.user.id === order.assigned_seller_id
          ? 'Seller'
          : socket.user.id === order.customer_id
            ? 'Customer'
            : 'Admin'

      const telegramMessage = buildOfflineChatTelegramMessage({
        orderId,
        senderLabel,
        senderUsername: formattedMessage.sender?.username || socket.user.username,
        content: formattedMessage.content,
      })

      void telegramService.sendMessage(receiver.telegram_id, telegramMessage).catch((telegramError) => {
        console.error('Offline chat Telegram notification failed:', telegramError)
      })
    } catch (error) {
      console.error('send_message error:', error)
      ack?.({ success: false, error: 'Unable to send message' })
    }
  })

  // Client emits 'typing' when the user is typing.
  // Server relays it to the room and schedules a typing_stop after silence.
  socket.on('typing', (payload) => {
    const orderId = payload?.orderId
    if (!orderId || typeof orderId !== 'string') return
    // Only allow if the socket has actually joined this room
    if (!socket.joinedOrderIds.has(orderId)) return

    socket.to(`order_${orderId}`).emit('typing', {
      orderId,
      userId: socket.user.id,
      username: socket.user.username || 'Unknown User',
    })

    scheduleTypingStop(io, orderId, socket.user.id)
  })

  socket.on('mark_seen', async (payload, ack) => {
    try {
      const orderId = payload?.orderId
      const lastReadMessageId = payload?.lastReadMessageId

      if (!orderId || typeof orderId !== 'string') {
        ack?.({ success: false, error: 'Invalid order id' })
        return
      }

      if (!lastReadMessageId || typeof lastReadMessageId !== 'string') {
        ack?.({ success: false, error: 'Invalid message id' })
        return
      }

      const access = await getAuthorizedOrder(orderId, socket.user)
      if (!access.ok) {
        ack?.({ success: false, error: access.error })
        return
      }

      const { error: upsertError } = await db
        .from('order_message_reads')
        .upsert(
          {
            order_id: orderId,
            user_id: socket.user.id,
            last_read_message_id: lastReadMessageId,
            read_at: new Date().toISOString(),
          },
          { onConflict: 'order_id,user_id' }
        )

      if (upsertError) {
        if (isMessageReadsTableMissing(upsertError)) {
          // Migration 15 not yet run — silently succeed so UI is not broken
          ack?.({ success: true })
          return
        }
        console.error('mark_seen upsert error:', upsertError)
        ack?.({ success: false, error: 'Unable to mark messages as seen' })
        return
      }

      io.to(`order_${orderId}`).emit('messages_seen', {
        orderId,
        userId: socket.user.id,
        lastReadMessageId,
      })

      ack?.({ success: true })
    } catch (error) {
      console.error('mark_seen error:', error)
      ack?.({ success: false, error: 'Unable to mark messages as seen' })
    }
  })

  socket.on('disconnect', () => {
    clearRateLimit(socket.user.id)
    clearTypingForSocket(socket)

    for (const orderId of socket.joinedOrderIds) {
      const wasLast = leaveRoomPresence(orderId, socket.user.id, socket.id)
      if (wasLast) {
        socket.to(`order_${orderId}`).emit('user_offline', {
          orderId,
          userId: socket.user.id,
        })
      }
    }

    socket.joinedOrderIds.clear()
    console.log('User disconnected:', socket.id)
  })
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'socket-server' })
})

server.listen(PORT, () => {
  console.log(`Socket server listening on port ${PORT}`)
})
