/**
 * Telegram Service - Comprehensive notification system for sellers
 *
 * Features:
 * - Send messages to individual sellers
 * - Send messages to sellers group
 * - Cooldown system to prevent spam
 * - Rate limiting and retry logic
 * - Error handling that doesn't break main flows
 */

const MIN_CHAT_INTERVAL_MS = 250;
const RETRYABLE_ERROR_CODES = ['429', '500', '502', '503', '504'];
const TELEGRAM_NOTIFY_COOLDOWN_MS = 30_000; // 30 seconds between notifications per order:user

const lastMessageAtByChat = new Map(); // Track rate limiting per chat
const lastTelegramNotifyAt = new Map(); // Track cooldown: "orderId:userId"

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

function normalizeChatId(chatId) {
  if (chatId === null || chatId === undefined) return null;

  const value = String(chatId).trim();
  if (!value) return null;

  // Telegram chat/user IDs are integer-like values (groups can be negative).
  if (!/^-?\d{5,20}$/.test(value)) return null;

  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Low-level Telegram API call
 * @param {string} method - Telegram API method (sendMessage, etc.)
 * @param {Record<string, any>} payload - Request payload
 * @returns {Promise<any>} API response result
 */
async function callTelegram(method, payload) {
  const token = getBotToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.result;
}

/**
 * Send message to a chat with rate limiting and retry logic
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} message - Message text
 * @param {object} options - Send options (parseMode, disableWebPreview, replyMarkup)
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendMessage(chatId, message, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId || !message?.trim()) {
    return { sent: false, reason: 'invalid_chat_or_message' };
  }

  // Rate limiting: enforce min interval between messages to same chat
  const lastSentAt = lastMessageAtByChat.get(normalizedChatId) ?? 0;
  const now = Date.now();
  const waitFor = Math.max(0, MIN_CHAT_INTERVAL_MS - (now - lastSentAt));
  if (waitFor > 0) {
    await sleep(waitFor);
  }

  try {
    await callTelegram('sendMessage', {
      chat_id: normalizedChatId,
      text: message,
      parse_mode: options.parseMode ?? 'HTML',
      disable_web_page_preview: options.disableWebPreview ?? true,
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
    lastMessageAtByChat.set(normalizedChatId, Date.now());
    return { sent: true };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const shouldRetry = RETRYABLE_ERROR_CODES.some((code) => messageText.includes(code));

    if (shouldRetry) {
      try {
        await sleep(350);
        await callTelegram('sendMessage', {
          chat_id: normalizedChatId,
          text: message,
          parse_mode: options.parseMode ?? 'HTML',
          disable_web_page_preview: options.disableWebPreview ?? true,
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        });
        lastMessageAtByChat.set(normalizedChatId, Date.now());
        return { sent: true };
      } catch (retryError) {
        console.error(
          '[TelegramService] sendMessage retry failed:',
          retryError instanceof Error ? retryError.message : String(retryError)
        );
        return { sent: false, reason: 'telegram_api_error' };
      }
    }

    console.error('[TelegramService] sendMessage failed:', messageText);
    return { sent: false, reason: 'telegram_api_error' };
  }
}

/**
 * Send message to a specific seller
 * @param {string} sellerId - Seller user ID
 * @param {string} message - Message text
 * @param {object} options - Send options
 * @param {object} db - Supabase client
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendToSeller(sellerId, message, options = {}, db) {
  if (!sellerId || !message?.trim()) {
    return { sent: false, reason: 'invalid_seller_or_message' };
  }

  try {
    const { data: seller, error } = await db
      .from('users')
      .select('telegram_id')
      .eq('id', sellerId)
      .maybeSingle();

    if (error || !seller?.telegram_id) {
      return { sent: false, reason: 'seller_not_found_or_no_telegram_id' };
    }

    return await sendMessage(seller.telegram_id, message, options);
  } catch (error) {
    console.error('[TelegramService] sendToSeller error:', error);
    return { sent: false, reason: 'database_error' };
  }
}

/**
 * Send message to sellers group
 * @param {string} message - Message text
 * @param {object} options - Send options
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendToGroup(message, options = {}) {
  const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID;

  if (!groupChatId) {
    console.warn('[TelegramService] TELEGRAM_GROUP_CHAT_ID not configured');
    return { sent: false, reason: 'group_not_configured' };
  }

  if (!message?.trim()) {
    return { sent: false, reason: 'invalid_message' };
  }

  return await sendMessage(groupChatId, message, options);
}

/**
 * Check if notification can be sent (respects cooldown)
 * Prevents duplicate notifications for rapid message bursts
 * @param {string} orderId - Order ID
 * @param {string} userId - User ID (seller receiving notification)
 * @returns {boolean}
 */
function canSendNotification(orderId, userId) {
  const key = `${orderId}:${userId}`;
  const now = Date.now();
  const lastSent = lastTelegramNotifyAt.get(key) ?? 0;

  if (now - lastSent < TELEGRAM_NOTIFY_COOLDOWN_MS) {
    return false;
  }

  lastTelegramNotifyAt.set(key, now);
  return true;
}

/**
 * Format message for new exclusive order
 * @param {string} orderId - Order ID
 * @param {string} productName - Product name
 * @returns {string}
 */
function formatExclusiveOrderMessage(orderId, productName) {
  return `📦 <b>New Order on Your Product</b>\n\n📦 <b>${productName}</b>\n🆔 Order: <code>#${orderId}</code>\n⏰ Status: Pending\n\n✨ Click link to view details`;
}

/**
 * Format message for new public order
 * @param {string} orderId - Order ID
 * @param {string} productName - Product name
 * @returns {string}
 */
function formatPublicOrderMessage(orderId, productName) {
  return `🔥 <b>New Order Available</b>\n\n📦 <b>${productName}</b>\n🆔 Order: <code>#${orderId}</code>\n⚡ First seller can accept\n\n⏱️ Limited time - be quick!`;
}

/**
 * Format message for offline chat notification
 * @param {object} params - { orderId, senderLabel, senderUsername, content }
 * @returns {string}
 */
function formatOfflineChatMessage({ orderId, senderLabel, senderUsername, content }) {
  const trimmed = String(content ?? '').trim();
  const preview = trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;

  return [
    `💬 <b>New message about your order #${orderId}</b>`,
    `From: <b>${senderLabel}</b>${senderUsername ? ` (${senderUsername})` : ''}`,
    `Message: <i>${preview}</i>`,
  ].join('\n');
}

/**
 * Format message for order status update
 * @param {string} orderId - Order ID
 * @param {string} status - New status
 * @returns {string}
 */
function formatOrderStatusMessage(orderId, status) {
  const statusEmoji = {
    'in_progress': '⚙️',
    'completed': '✅',
    'cancelled': '❌',
    'disputed': '⚠️',
  }[status] || '📋';

  return `${statusEmoji} <b>Order #${orderId} Status Update</b>\n\nNew Status: <b>${status.toUpperCase()}</b>`;
}

/**
 * Check if a chat ID is valid
 * @param {string|number} chatId - Chat ID to validate
 * @returns {boolean}
 */
function isValidChatId(chatId) {
  return Boolean(normalizeChatId(chatId));
}

/**
 * Send admin alert (e.g., for disputes, issues)
 * @param {string} message - Message text
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendToAdmin(message) {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!adminChatId) {
    console.warn('[TelegramService] TELEGRAM_ADMIN_CHAT_ID not configured');
    return { sent: false, reason: 'admin_not_configured' };
  }

  return await sendMessage(adminChatId, message, { parseMode: 'HTML' });
}

/**
 * Send admin alert for disputes
 * @param {string} orderId - Order ID
 * @param {string} reason - Dispute reason
 * @param {string} openedBy - User ID who opened dispute
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendDisputeAlert(orderId, reason, openedBy) {
  const message = `⚠️ <b>DISPUTE OPENED</b>\n\nOrder: <code>#${orderId}</code>\nOpened By: ${openedBy}\nReason: ${reason}`;
  return await sendToAdmin(message);
}

module.exports = {
  telegramService: {
    // Core functions
    sendMessage,
    sendToSeller,
    sendToGroup,
    sendToAdmin,
    callTelegram,

    // Utility functions
    isValidChatId,
    canSendNotification,
    normalizeChatId,

    // Message formatters
    formatExclusiveOrderMessage,
    formatPublicOrderMessage,
    formatOfflineChatMessage,
    formatOrderStatusMessage,

    // Message builders (for compatibility)
    orderCreatedMessage: (orderId) => `✅ Order Created\nID: #${orderId}\nStatus: Pending`,
    orderUpdatedMessage: (orderId, status) => `🔄 Order #${orderId}\nStatus: ${status}`,
    pointsTransactionMessage: (change, total) => {
      const sign = change >= 0 ? '+' : '';
      return `💰 Points Update\nChange: ${sign}${change}\nTotal: ${total}`;
    },
    sellerAssignedMessage: (orderId, productName, customerUsername) =>
      `📦 New Order\nOrder ID: #${orderId}\nProduct: ${productName}\nCustomer: ${customerUsername}`,

    // Dispute alert
    sendDisputeAlert,
  },
};
