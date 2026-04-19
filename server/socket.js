const path = require('path')
try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') })
} catch {}

const http = require('http')
const express = require('express')
const { Server } = require('socket.io')
const { createClient } = require('@supabase/supabase-js')
const { telegramService } = require('./telegram-service')

// ================= ENV =================
const PORT = Number(process.env.PORT || process.env.SOCKET_PORT || 3001)

const FRONTEND_ORIGIN =
  process.env.SOCKET_CORS_ORIGIN ||
  process.env.CLIENT_URL ||
  'http://localhost:3000'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing Supabase ENV')
}

const db = createClient(supabaseUrl, supabaseServiceRoleKey)

// ================= SERVER =================
const app = express()
app.use(express.json())

const server = http.createServer(app)

const io = new Server(server, {
  path: '/socket.io',
  cors: {
    origin: [
      "http://localhost:3000",
      "https://www.storeconquerors.com",
      "https://storeconquerors.com"
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

// ================= AUTH (FIXED) =================
function getSocketToken(socket) {
  return socket.handshake?.auth?.token || null
}

io.use((socket, next) => {
  try {
    const token = getSocketToken(socket)
    if (!token) return next(new Error('Unauthorized'))

    // ✅ decode Supabase token
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString()
    )

    if (!payload?.sub) {
      return next(new Error('Unauthorized'))
    }

    socket.user = {
      id: payload.sub,
      email: payload.email,
      username: payload.user_metadata?.username || 'User',
      role: payload.role || 'user',
    }

    next()
  } catch (err) {
    console.error('Auth error:', err)
    next(new Error('Unauthorized'))
  }
})

// ================= SOCKET =================
io.on('connection', (socket) => {
  console.log('User connected:', socket.id)

  // 🔥 USER ROOM
  if (socket.user?.id) {
    socket.join(`user_${socket.user.id}`)
    console.log('Joined:', `user_${socket.user.id}`)
  }

  // 🔥 ADMIN ROOM
  if (socket.user?.role === 'admin') {
    socket.join('admin')
  }

  // 🔥 JOIN ORDER
  socket.on('join_order', (orderId) => {
    socket.join(`order_${orderId}`)
  })

  // 💬 CHAT
  socket.on('send_message', (data) => {
    io.to(`order_${data.orderId}`).emit('new_message', data)
  })

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id)
  })
})

// ================= TOPUP EVENTS =================
const INTERNAL_EVENT_SECRET = process.env.SOCKET_INTERNAL_EVENT_SECRET || ''

app.post('/events/topups', (req, res) => {
  const secret = req.headers['x-internal-event-secret']

  if (INTERNAL_EVENT_SECRET && secret !== INTERNAL_EVENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { event, data } = req.body

  if (!data?.userId) {
    return res.status(400).json({ error: 'Invalid data' })
  }

  if (event === 'topup_request') {
    io.to('admin').emit('new_topup_request', data)
  }

  if (event === 'topup_update') {
    io.to(`user_${data.userId}`).emit('topup_status', data)
    io.to('admin').emit('topup_status', data)
  }

  res.json({ ok: true })
})

// ================= HEALTH =================
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

// ================= START =================
server.listen(PORT, () => {
  console.log(`Socket server running on port ${PORT}`)
})
