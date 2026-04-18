const RETRYABLE_ERROR_CODES = ['429', '500', '502', '503', '504']

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || ''
}

function normalizeChatId(chatId) {
  if (chatId === null || chatId === undefined) return null

  const value = String(chatId).trim()
  if (!value) return null

  // Telegram chat/user IDs are integer-like values (groups can be negative).
  if (!/^-?\d{5,20}$/.test(value)) return null

  return value
}

async function callTelegram(method, payload) {
  const token = getBotToken()
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing')
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(body)}`)
  }

  return body.result
}

async function sendMessage(chatId, message, options = {}) {
  const normalizedChatId = normalizeChatId(chatId)
  if (!normalizedChatId || !message?.trim()) {
    return { sent: false, reason: 'invalid_chat_or_message' }
  }

  try {
    await callTelegram('sendMessage', {
      chat_id: normalizedChatId,
      text: message,
      parse_mode: options.parseMode ?? 'HTML',
      disable_web_page_preview: options.disableWebPreview ?? true,
    })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error)
    const shouldRetry = RETRYABLE_ERROR_CODES.some((code) => messageText.includes(code))

    if (shouldRetry) {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await callTelegram('sendMessage', {
        chat_id: normalizedChatId,
        text: message,
        parse_mode: options.parseMode ?? 'HTML',
        disable_web_page_preview: options.disableWebPreview ?? true,
      })
      return { sent: true }
    }

    throw error
  }

  return { sent: true }
}

module.exports = {
  telegramService: {
    sendMessage,
    isValidChatId: (chatId) => Boolean(normalizeChatId(chatId)),
  },
}
