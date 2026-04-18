const http = require('http')
const express = require('express')
const jwt = require('jsonwebtoken')
const { Server } = require('socket.io')
const { createClient } = require('@supabase/supabase-js')
const { telegramService } = require('./telegram-service')

// ENV VARIABLES (Render provides them automatically)
const PORT = Number(process.env.PORT || process.env.SOCKET_PORT || 3001)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

const FRONTEND_ORIGIN =
  process.env.SOCKET_CORS_ORIGIN ||
  process.env.CLIENT_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'http://localhost:3000'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

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
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

// ================= AUTH =================
function getSocketToken(socket) {
  const authToken = socket.handshake?.auth?.token
  if (authToken) return authToken

  const headerToken = socket.handshake?.headers?.authorization
  if (headerToken?.startsWith('Bearer ')) {
    return headerToken.slice(7)
  }

  return null
}

io.use((socket, next) => {
  try {
    const token = getSocketToken(socket)
    if (!token) return next(new Error('Unauthorized'))

    const payload = jwt.verify(token, JWT_SECRET)
    socket.user = payload
    next()
  } catch {
    next(new Error('Unauthorized'))
  }
})

// ================= SOCKET =================
io.on('connection', (socket) => {
  console.log('User connected:', socket.id)

  socket.on('join_order', (orderId) => {
    socket.join(`order_${orderId}`)
  })

  socket.on('send_message', async (data) => {
    io.to(`order_${data.orderId}`).emit('new_message', data)
  })

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id)
  })
})

// ================= HEALTH CHECK =================
app.get('/health', (req, res) => {
  res.json({ ok: true })
})

// ================= START SERVER =================
server.listen(PORT, () => {
  console.log(`Socket server running on port ${PORT}`)
})
