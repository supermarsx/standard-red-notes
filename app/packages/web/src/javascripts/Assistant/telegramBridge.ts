import type { WebApplication } from '@/Application/WebApplication'
import { assistantInternetAccessEnabled } from './assistantInternetAccess'

export const TELEGRAM_BRIDGE_ROUTE = '/v1/assistant/telegram'
export async function telegramBridgeRequest(
  application: WebApplication,
  action: 'inbox' | 'pair' | 'revoke' | 'reply' | 'ack',
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (action !== 'revoke' && action !== 'ack' && !assistantInternetAccessEnabled(application)) {
    return { error: 'Internet access is disabled in Assistant settings.', cancelled: true }
  }
  try {
    const result =
      action === 'inbox'
        ? await application.serverGetJsonRequest<Record<string, unknown>>(TELEGRAM_BRIDGE_ROUTE, signal)
        : await application.serverJsonRequest<Record<string, unknown>>(
            `${TELEGRAM_BRIDGE_ROUTE}/${action}`,
            body,
            signal,
          )
    if (!result.ok) {
      const code = (result.data?.error as { code?: string } | undefined)?.code
      const messages: Record<string, string> = {
        TELEGRAM_NOT_CONFIGURED: 'Ask your administrator to configure the Assistant Telegram bot and webhook.',
        TELEGRAM_REPLY_UNCERTAIN:
          'This reply may already have been sent. Check Telegram; it will not be sent again automatically.',
        TELEGRAM_INBOX_FULL: 'Telegram inbox is full. Review and acknowledge older messages before receiving more.',
        INTERNET_ACCESS_DISABLED: 'Internet access is disabled by this server.',
        TELEGRAM_MESSAGE_NOT_FOUND: 'That Telegram message is no longer pending or the chat is disconnected.',
      }
      return {
        error: code && messages[code] ? messages[code] : 'Telegram bridge is unavailable.',
        ...(result.status === 401 || result.status === 403 ? { cancelled: true } : {}),
        ...(result.status === 429 ? { rateLimited: true } : {}),
      }
    }
    return result.data
  } catch {
    return {
      error:
        'Telegram bridge could not be reached. An interrupted reply may already have been sent; check Telegram before retrying.',
    }
  }
}
