import { isJsonObject } from '../../Infra/SecureJsonFileStore'
import { TelegramBridgeStore, TelegramPrivateIdentity, verifyTelegramWebhookSecret } from './TelegramBridgeStore'

export const TELEGRAM_BRIDGE_SERVICE = Symbol.for('ApiGateway_TelegramBridgeService')
export interface TelegramBridgeConfig {
  botToken?: string
  webhookSecret?: string
}

/** An opt-in transport inbox. It never runs a model or reads encrypted notes. */
export class TelegramBridgeService {
  constructor(
    private readonly store: TelegramBridgeStore,
    private readonly config: TelegramBridgeConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.botToken &&
      /^\d+:[A-Za-z0-9_-]+$/.test(this.config.botToken) &&
      verifyTelegramWebhookSecret(this.config.webhookSecret, this.config.webhookSecret),
    )
  }
  async status(userUuid: string) {
    return {
      configured: this.isConfigured(),
      linked: await this.store.isLinked(userUuid),
      messages: await this.store.poll(userUuid),
    }
  }
  async pair(userUuid: string) {
    this.requireConfigured()
    return this.store.createPairing(userUuid)
  }
  async revoke(userUuid: string): Promise<void> {
    await this.store.revoke(userUuid)
  }
  async acknowledge(userUuid: string, updateIds: number[]): Promise<void> {
    await this.store.acknowledge(userUuid, updateIds)
  }

  async webhook(secret: unknown, update: unknown): Promise<void> {
    this.requireConfigured()
    if (!verifyTelegramWebhookSecret(this.config.webhookSecret, secret)) {
      throw new Error('TELEGRAM_WEBHOOK_UNAUTHORIZED')
    }
    if (!isJsonObject(update) || !Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) {
      throw new Error('TELEGRAM_INVALID_UPDATE')
    }
    const message = update.message
    if (
      !isJsonObject(message) ||
      !isJsonObject(message.chat) ||
      !isJsonObject(message.from) ||
      message.chat.type !== 'private' ||
      message.from.is_bot === true ||
      typeof message.text !== 'string'
    ) {
      return
    }
    if (
      !Number.isSafeInteger(message.chat.id) ||
      !Number.isSafeInteger(message.from.id) ||
      message.chat.id !== message.from.id ||
      (message.chat.id as number) <= 0
    ) {
      throw new Error('TELEGRAM_INVALID_UPDATE')
    }
    const identity: TelegramPrivateIdentity = {
      chatType: 'private',
      chatId: String(message.chat.id),
      senderId: String(message.from.id),
    }
    const pairing = /^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{43})$/.exec(message.text)
    if (pairing) {
      await this.store.consumePairing(pairing[1], identity)
      return
    }
    if (/^\/start(?:\s|$)/.test(message.text)) {
      return
    }
    await this.store.enqueue(identity, update.update_id as number, message.text)
  }

  async reply(userUuid: string, updateId: number, text: string): Promise<{ sent: true; alreadySent?: true }> {
    this.requireConfigured()
    if (
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 4096
    ) {
      throw new Error('TELEGRAM_INVALID_REPLY')
    }
    const claim = await this.store.claimReply(userUuid, updateId)
    if ('alreadySent' in claim) {
      return { sent: true, alreadySent: true }
    }
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: claim.chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      // Do not read upstream bodies/errors: they can contain credentials/content.
      if (!response.ok) {
        throw new Error('TELEGRAM_SEND_FAILED')
      }
      const result: unknown = await response.json()
      if (!isJsonObject(result) || result.ok !== true) {
        throw new Error('TELEGRAM_SEND_FAILED')
      }
      await this.store.finishReply(userUuid, updateId, 'sent')
      return { sent: true }
    } catch {
      await this.store.finishReply(userUuid, updateId, 'uncertain')
      throw new Error('TELEGRAM_REPLY_UNCERTAIN')
    }
  }
  private requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error('TELEGRAM_NOT_CONFIGURED')
    }
  }
}
