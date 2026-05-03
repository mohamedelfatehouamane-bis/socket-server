const cors = require('cors')

const ALLOWED_ORIGINS = [
  "https://storeconquerors.com",
  "https://www.storeconquerors.com",
  "https://store-v2.vercel.app",
]
const path = require('path')
try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') })
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') {
    console.warn('dotenv initialization failed:', error)
  }
}
const http = require('http')
const express = require('express')
const jwt = require('jsonwebtoken')
const { Server } = require('socket.io')
const { createClient } = require('@supabase/supabase-js')
const { telegramService } = require('./telegram-service')

const rawPort = process.env.PORT || '3001'
const PORT = Number(rawPort)
if (!Number.isFinite(PORT) || PORT <= 0) {
  throw new Error(`Invalid server port: ${rawPort}`)
}
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
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}))

app.use(express.json({ limit: '256kb' }))

const io = new Server(server, {
  path: '/socket.io',
  allowEIO3: true,
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  },
})

const INTERNAL_EVENT_SECRET = process.env.SOCKET_INTERNAL_EVENT_SECRET || ''
const ADMIN_TELEGRAM_CHAT_ID = process.env.ADMIN_TELEGRAM_ID || process.env.TELEGRAM_ADMIN_CHAT_ID || ''
const TOPUP_STATUSES = new Set(['pending', 'processing', 'approved', 'rejected'])

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTopupAdminTelegramMessage(data) {
  return [
    '<b>New Top-up Request</b>',
    `Top-up ID: <code>${escapeHtml(data.requestId)}</code>`,
    `User ID: <code>${escapeHtml(data.userId)}</code>`,
    `Amount: <b>${Number(data.amount || 0).toLocaleString()} points</b>`,
    `Status: <b>${escapeHtml(data.status || 'pending')}</b>`,
  ].join('\n')
}

async function emitTopupRequest(data) {
  io.to('admin').emit('new_topup_request', data)

  if (!ADMIN_TELEGRAM_CHAT_ID) {
    return
  }

  try {
    await telegramService.sendMessage(ADMIN_TELEGRAM_CHAT_ID, formatTopupAdminTelegramMessage(data), {
      parseMode: 'HTML',
      disableWebPreview: true,
      replyMarkup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve_${data.requestId}` },
          { text: '❌ Reject', callback_data: `reject_${data.requestId}` },
        ]],
      },
    })
  } catch (error) {
    console.error('Top-up admin Telegram notification failed:', error)
  }
}

function emitTopupStatus(data) {
  console.log('Sending to:', `user_${data.userId}`)
  io.to(`user_${data.userId}`).emit('topup_status', data)
  io.to('admin').emit('topup_status', data)
}

function normalizeTopupPayload(input) {
  const requestId = String(input?.requestId || '').trim()
  const userId = String(input?.userId || '').trim()
  const amount = Number(input?.amount ?? 0)
  const status = String(input?.status || '').trim().toLowerCase()

  if (!requestId || !userId || !Number.isFinite(amount) || amount <= 0) {
    return null
  }

  if (!TOPUP_STATUSES.has(status)) {
    return null
  }

  return {
    requestId,
    userId,
    amount,
    status,
    created_at: new Date().toISOString(),
  }
}

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

function emitUserOffline(orderId, userId, reason) {
  io.to(`order_${orderId}`).emit('user_offline', {
    orderId,
    userId,
    reason,
  })
}

function isSocketActive(socketId) {
  return io.sockets.sockets.has(socketId)
}

function pruneStaleRoomPresence(orderId, { emitOffline = false } = {}) {
  const room = roomPresence.get(orderId)
  if (!room) return []

  const offlineUserIds = []

  for (const [userId, sockets] of room.entries()) {
    for (const socketId of Array.from(sockets)) {
      if (!isSocketActive(socketId)) {
        sockets.delete(socketId)
      }
    }

    if (sockets.size === 0) {
      room.delete(userId)
      offlineUserIds.push(userId)
    }
  }

  if (room.size === 0) {
    roomPresence.delete(orderId)
  }

  if (emitOffline) {
    for (const userId of offlineUserIds) {
      emitUserOffline(orderId, userId, 'stale_socket_pruned')
    }
  }

  return offlineUserIds
}

/** @returns {boolean} true when this is the user's first socket in the room */
function joinRoomPresence(orderId, userId, socketId) {
  pruneStaleRoomPresence(orderId)

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
  pruneStaleRoomPresence(orderId)

  const room = roomPresence.get(orderId)
  if (!room) return []
  return Array.from(room.keys())
}

function isUserOnlineInRoom(orderId, userId) {
  pruneStaleRoomPresence(orderId)

  const room = roomPresence.get(orderId)
  if (!room) return false
  const sockets = room.get(userId)
  const online = Boolean(sockets && sockets.size > 0)
  console.log(`[presence] isUserOnline order=${orderId} user=${userId} online=${online} sockets=${sockets ? sockets.size : 0}`)
  return online
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

  if (socket.user?.id) {
    socket.join(`user_${socket.user.id}`)
    console.log('Joined room:', `user_${socket.user.id}`)
  }

  if (socket.user?.role === 'admin') {
    socket.join('admin')
    console.log('Joined room:', 'admin')
  }

  socket.on('topup_request', async (payload, ack) => {
    try {
      const data = normalizeTopupPayload(payload)
      if (!data) {
        ack?.({ success: false, error: 'Invalid top-up payload' })
        return
      }

      const isAdmin = socket.user?.role === 'admin'
      const isOwner = socket.user?.id === data.userId
      if (!isAdmin && !isOwner) {
        ack?.({ success: false, error: 'Unauthorized' })
        return
      }

      await emitTopupRequest(data)
      ack?.({ success: true })
    } catch (error) {
      console.error('topup_request error:', error)
      ack?.({ success: false, error: 'Unable to process top-up request event' })
    }
  })

  socket.on('topup_update', (payload, ack) => {
    try {
      if (socket.user?.role !== 'admin') {
        ack?.({ success: false, error: 'Only admins can publish top-up updates' })
        return
      }

      const data = normalizeTopupPayload(payload)
      if (!data) {
        ack?.({ success: false, error: 'Invalid top-up payload' })
        return
      }

      emitTopupStatus(data)
      ack?.({ success: true })
    } catch (error) {
      console.error('topup_update error:', error)
      ack?.({ success: false, error: 'Unable to process top-up update event' })
    }
  })

  socket.on('join_order', async (orderId, ack) => {
    try {
      if (!orderId || typeof orderId !== 'string') {
        ack?.({ success: false, error: 'Invalid order id' })
        return
      }

      console.log(`[presence] join_order start order=${orderId} user=${socket.user.id} socket=${socket.id}`)

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

      console.log(
        `[presence] join_order done order=${orderId} user=${socket.user.id} socket=${socket.id} onlineUsers=${getRoomOnlineUserIds(orderId).join(',') || 'none'}`
      )

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

    console.log(`[presence] leave_order order=${orderId} user=${socket.user.id} socket=${socket.id}`)
    socket.leave(`order_${orderId}`)
    socket.joinedOrderIds.delete(orderId)

    const wasLast = leaveRoomPresence(orderId, socket.user.id, socket.id)
    if (wasLast) {
      emitUserOffline(orderId, socket.user.id, 'leave_order')
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

      const receiverIsOnline = isUserOnlineInRoom(orderId, receiverUserId)
      console.log(
        `[presence] send_message order=${orderId} sender=${socket.user.id} receiver=${receiverUserId} receiverOnline=${receiverIsOnline}`
      )

      if (receiverIsOnline) {
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
      console.log(`[presence] disconnect order=${orderId} user=${socket.user.id} socket=${socket.id}`)
      const wasLast = leaveRoomPresence(orderId, socket.user.id, socket.id)
      if (wasLast) {
        emitUserOffline(orderId, socket.user.id, 'disconnect')
      }
    }

    socket.joinedOrderIds.clear()
    console.log('User disconnected:', socket.id)
  })
})

const PRESENCE_SWEEP_INTERVAL_MS = 15_000
const presenceSweepTimer = setInterval(() => {
  for (const orderId of roomPresence.keys()) {
    pruneStaleRoomPresence(orderId, { emitOffline: true })
  }
}, PRESENCE_SWEEP_INTERVAL_MS)

if (typeof presenceSweepTimer.unref === 'function') {
  presenceSweepTimer.unref()
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'socket-server' })
})

app.get('/api/test', (_req, res) => {
  res.json({ status: 'API working' })
})

// ---------------------------------------------------------------------------
// Telegram webhook — handles callback_query from inline keyboard buttons
// ---------------------------------------------------------------------------
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''
const TOPUP_REQUESTS_TABLE = process.env.TOPUP_REQUESTS_TABLE || 'topup_requests'

app.post('/telegram/webhook', async (req, res) => {
  // Validate the secret token sent by Telegram (if configured)
  if (TELEGRAM_WEBHOOK_SECRET) {
    const incoming = String(req.headers['x-telegram-bot-api-secret-token'] || '')
    if (incoming !== TELEGRAM_WEBHOOK_SECRET) {
      res.status(403).json({ ok: false })
      return
    }
  }

  // Respond immediately so Telegram doesn't retry
  res.sendStatus(200)

  const update = req.body
  const callbackQuery = update?.callback_query
  if (!callbackQuery) return

  const callbackQueryId = String(callbackQuery.id || '')
  const callbackData = String(callbackQuery.data || '')
  const chatId = callbackQuery.message?.chat?.id
  const messageId = callbackQuery.message?.message_id

  let newStatus
  let requestId
  if (callbackData.startsWith('approve_')) {
    newStatus = 'approved'
    requestId = callbackData.slice('approve_'.length)
  } else if (callbackData.startsWith('reject_')) {
    newStatus = 'rejected'
    requestId = callbackData.slice('reject_'.length)
  } else {
    return
  }

  if (!requestId) return

  // Answer the callback query to remove the loading spinner on the button
  try {
    await telegramService.callTelegram('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: newStatus === 'approved' ? '✅ Approved!' : '❌ Rejected!',
    })
  } catch (err) {
    console.error('[TelegramWebhook] answerCallbackQuery failed:', err)
  }

  // Fetch the topup request from the database
  let topupRequest
  try {
    const { data, error } = await db
      .from(TOPUP_REQUESTS_TABLE)
      .select('id, user_id, amount, status, created_at')
      .eq('id', requestId)
      .maybeSingle()

    if (error || !data) {
      console.error('[TelegramWebhook] topup request not found:', requestId, error)
      return
    }
    topupRequest = data
  } catch (err) {
    console.error('[TelegramWebhook] DB fetch error:', err)
    return
  }

  // Skip if already processed
  if (topupRequest.status === 'approved' || topupRequest.status === 'rejected') {
    console.log('[TelegramWebhook] Request already processed:', requestId, topupRequest.status)
    return
  }

  // Update the status in the database
  try {
    const { error: updateError } = await db
      .from(TOPUP_REQUESTS_TABLE)
      .update({ status: newStatus })
      .eq('id', requestId)

    if (updateError) {
      console.error('[TelegramWebhook] Failed to update topup status:', updateError)
      return
    }
  } catch (err) {
    console.error('[TelegramWebhook] DB update error:', err)
    return
  }

  // Notify connected clients via socket
  const statusData = {
    requestId,
    userId: topupRequest.user_id,
    amount: topupRequest.amount,
    status: newStatus,
    created_at: topupRequest.created_at ?? new Date().toISOString(),
  }
  emitTopupStatus(statusData)

  // Edit the original Telegram message to remove the buttons and show the outcome
  if (chatId && messageId) {
    try {
      const updatedText =
        formatTopupAdminTelegramMessage({
          requestId,
          userId: topupRequest.user_id,
          amount: topupRequest.amount,
          status: newStatus,
        }) +
        '\n\n' +
        (newStatus === 'approved' ? '✅ <b>Approved</b>' : '❌ <b>Rejected</b>')

      await telegramService.callTelegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: updatedText,
        parse_mode: 'HTML',
      })
    } catch (err) {
      // Non-fatal: message may have already been edited or deleted
      console.error('[TelegramWebhook] editMessageText failed:', err)
    }
  }
})

// ---------------------------------------------------------------------------
// Register Telegram webhook URL on startup (when TELEGRAM_WEBHOOK_URL is set)
// ---------------------------------------------------------------------------
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || ''
if (TELEGRAM_WEBHOOK_URL) {
  const webhookPayload = { url: TELEGRAM_WEBHOOK_URL }
  if (TELEGRAM_WEBHOOK_SECRET) {
    webhookPayload.secret_token = TELEGRAM_WEBHOOK_SECRET
  }
  telegramService
    .callTelegram('setWebhook', webhookPayload)
    .then(() => console.log('[Telegram] Webhook registered:', TELEGRAM_WEBHOOK_URL))
    .catch((err) => console.error('[Telegram] Failed to register webhook:', err))
}

app.post('/events/topups', async (req, res) => {
  try {
    const incomingSecret = String(req.headers['x-internal-event-secret'] || '')
    if (INTERNAL_EVENT_SECRET && incomingSecret !== INTERNAL_EVENT_SECRET) {
      res.status(401).json({ success: false, error: 'Unauthorized internal event' })
      return
    }

    const event = String(req.body?.event || '').trim()
    const data = normalizeTopupPayload(req.body?.data)
    if (!data) {
      res.status(400).json({ success: false, error: 'Invalid top-up event payload' })
      return
    }

    if (event === 'topup_request') {
      await emitTopupRequest(data)
      res.json({ success: true })
      return
    }

    if (event === 'topup_update') {
      emitTopupStatus(data)
      res.json({ success: true })
      return
    }

    res.status(400).json({ success: false, error: 'Unsupported top-up event type' })
  } catch (error) {
    console.error('Internal top-up event error:', error)
    res.status(500).json({ success: false, error: 'Unable to process top-up event' })
  }
})

server.listen(PORT, () => {
  console.log(`Socket server listening on port ${PORT}`)
})
