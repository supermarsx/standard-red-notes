import { DeliveryChannel, DeliveryResult, ReminderDeliveryProvider } from '../Types'

/**
 * Standard Red Notes: Telegram delivery adapter.
 *
 * Sends a reminder via the Telegram Bot HTTP API
 * (`https://api.telegram.org/bot<token>/sendMessage`). The bot token is read from
 * the environment (`TELEGRAM_BOT_TOKEN`). The `destination` is the chat-id the
 * user configured (the chat between them and the bot).
 *
 * NO-OP CONTRACT: when the bot token is absent this adapter returns
 * `{ ok: false, notConfigured: true }` and performs NO network call. It never
 * throws — a transport/HTTP error is mapped to `{ ok: false, reason }`.
 *
 * Uses the Node 22 global `fetch` (no extra dependency), matching the existing
 * WebService proxy in this package.
 */
export class TelegramProvider implements ReminderDeliveryProvider {
  readonly channel: DeliveryChannel = 'telegram'

  constructor(
    private readonly botToken: string | undefined,
    private readonly fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  isConfigured(): boolean {
    return typeof this.botToken === 'string' && this.botToken.trim().length > 0
  }

  async send(destination: string, message: string): Promise<DeliveryResult> {
    if (!this.isConfigured()) {
      return { ok: false, notConfigured: true, reason: 'TELEGRAM_BOT_TOKEN is not set.' }
    }
    const chatId = (destination ?? '').trim()
    if (chatId.length === 0) {
      return { ok: false, reason: 'A Telegram chat id (destination) is required.' }
    }
    if (typeof this.fetchImpl !== 'function') {
      return { ok: false, reason: 'No fetch implementation available for Telegram delivery.' }
    }

    const url = `https://api.telegram.org/bot${this.botToken as string}/sendMessage`
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      })
      if (!res.ok) {
        const detail = await safeText(res)
        return { ok: false, reason: `Telegram API returned ${res.status}${detail ? `: ${detail}` : ''}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `Telegram delivery failed: ${(error as Error).message}` }
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}
