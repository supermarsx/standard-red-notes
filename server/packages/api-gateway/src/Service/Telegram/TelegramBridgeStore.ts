import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  hasOnlyKeys,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'

const PAIRING_TTL = 10 * 60_000
const RECEIPT_TTL = 48 * 60 * 60_000
const MAX_USERS = 10_000
const MAX_INBOX = 100
const MAX_RECEIPTS = 4096
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
const validUpdate = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export interface TelegramPrivateIdentity {
  chatType: 'private'
  chatId: string
  senderId: string
}
export interface TelegramInboxMessage {
  updateId: number
  text: string
  receivedAt: number
  /** Delivery uncertainty is terminal until the user checks Telegram; never retry automatically. */
  replyState?: 'sending' | 'sent' | 'uncertain'
}
interface Account {
  pairing?: { hash: string; expiresAt: number }
  binding?: { chatId: string; senderId: string; linkedAt: number }
  inbox: TelegramInboxMessage[]
  receipts: { updateId: number; receivedAt: number; reply?: 'sending' | 'sent' | 'uncertain' }[]
}
type State = Record<string, Account>

function validate(value: unknown): value is State {
  return (
    isJsonObject(value) &&
    Object.keys(value).length <= MAX_USERS &&
    Object.entries(value).every(
      ([user, account]) =>
        isSafeRecordKey(user) &&
        hasOnlyKeys(account, ['pairing', 'binding', 'inbox', 'receipts']) &&
        (account.pairing === undefined ||
          (hasOnlyKeys(account.pairing, ['hash', 'expiresAt']) &&
            typeof account.pairing.hash === 'string' &&
            /^[a-f0-9]{64}$/.test(account.pairing.hash) &&
            isEpochMilliseconds(account.pairing.expiresAt))) &&
        (account.binding === undefined ||
          (hasOnlyKeys(account.binding, ['chatId', 'senderId', 'linkedAt']) &&
            validId(account.binding.chatId) &&
            validId(account.binding.senderId) &&
            account.binding.chatId === account.binding.senderId &&
            isEpochMilliseconds(account.binding.linkedAt))) &&
        Array.isArray(account.inbox) &&
        account.inbox.length <= MAX_INBOX &&
        account.inbox.every(
          (message) =>
            hasOnlyKeys(message, ['updateId', 'text', 'receivedAt']) &&
            validUpdate(message.updateId) &&
            typeof message.text === 'string' &&
            message.text.length > 0 &&
            message.text.length <= 16_384 &&
            isEpochMilliseconds(message.receivedAt),
        ) &&
        Array.isArray(account.receipts) &&
        account.receipts.length <= MAX_RECEIPTS &&
        account.receipts.every(
          (receipt) =>
            hasOnlyKeys(receipt, ['updateId', 'receivedAt', 'reply']) &&
            (receipt.reply === undefined || ['sending', 'sent', 'uncertain'].includes(receipt.reply as string)) &&
            validUpdate(receipt.updateId) &&
            isEpochMilliseconds(receipt.receivedAt),
        ),
    )
  )
}

/** Compare fixed-size digests; missing/malformed secrets always fail closed. */
export function verifyTelegramWebhookSecret(expected: string | undefined, received: unknown): boolean {
  if (!expected || !/^[A-Za-z0-9_-]{32,256}$/.test(expected) || typeof received !== 'string' || received.length > 256) {
    return false
  }
  return timingSafeEqual(Buffer.from(digest(expected), 'hex'), Buffer.from(digest(received), 'hex'))
}

/** Server-readable opt-in inbox, not decrypted note/chat storage. Callers must supply authenticated account IDs. */
export class TelegramBridgeStore {
  private readonly store: SecureJsonFileStore<State>
  constructor(
    filePath: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new SecureJsonFileStore({ filePath, validate, maxBytes: 16 * 1024 * 1024 })
  }

  async createPairing(userUuid: string): Promise<{ code: string; expiresAt: number }> {
    this.assertUser(userUuid)
    const code = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + PAIRING_TTL
    await this.store.update((current) => {
      const state = current ?? {}
      if (!state[userUuid] && Object.keys(state).length >= MAX_USERS) {
        throw new Error('TELEGRAM_ACCOUNT_CAPACITY')
      }
      const account = state[userUuid] ?? { inbox: [], receipts: [] }
      account.pairing = { hash: digest(code), expiresAt }
      state[userUuid] = account
      return state
    })
    return { code, expiresAt }
  }

  async consumePairing(code: string, identity: TelegramPrivateIdentity): Promise<boolean> {
    if (!this.validIdentity(identity) || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
      return false
    }
    let consumed = false
    await this.store.update((current) => {
      const state = current ?? {}
      const hash = digest(code)
      const match = Object.values(state).find(
        (account) => account.pairing?.hash === hash && account.pairing.expiresAt > this.now(),
      )
      if (
        !match ||
        (match.binding !== undefined && match.binding.senderId !== identity.senderId) ||
        Object.values(state).some((account) => account !== match && account.binding?.senderId === identity.senderId)
      ) {
        return state
      }
      // Replacing a different sender requires explicit revocation first. Re-pairing
      // the same sender preserves pending messages and replay receipts.
      match.binding = { chatId: identity.chatId, senderId: identity.senderId, linkedAt: this.now() }
      delete match.pairing
      consumed = true
      return state
    })
    return consumed
  }

  async enqueue(
    identity: TelegramPrivateIdentity,
    updateId: number,
    text: string,
  ): Promise<'accepted' | 'duplicate' | 'unlinked'> {
    if (
      !this.validIdentity(identity) ||
      !validUpdate(updateId) ||
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > 16_384
    ) {
      throw new Error('TELEGRAM_INVALID_MESSAGE')
    }
    let result: 'accepted' | 'duplicate' | 'unlinked' = 'unlinked'
    await this.store.update((current) => {
      const state = current ?? {}
      const account = Object.values(state).find(
        (entry) => entry.binding?.senderId === identity.senderId && entry.binding.chatId === identity.chatId,
      )
      if (!account) {
        return state
      }
      const now = this.now()
      account.receipts = account.receipts.filter(
        (entry) =>
          entry.receivedAt > now - RECEIPT_TTL || account.inbox.some((message) => message.updateId === entry.updateId),
      )
      if (
        account.receipts.some((entry) => entry.updateId === updateId) ||
        account.inbox.some((entry) => entry.updateId === updateId)
      ) {
        result = 'duplicate'
        return state
      }
      if (account.inbox.length >= MAX_INBOX || account.receipts.length >= MAX_RECEIPTS) {
        throw new Error('TELEGRAM_INBOX_FULL')
      }
      account.inbox.push({ updateId, text, receivedAt: now })
      account.receipts.push({ updateId, receivedAt: now })
      result = 'accepted'
      return state
    })
    return result
  }

  async poll(userUuid: string): Promise<TelegramInboxMessage[]> {
    this.assertUser(userUuid)
    const account = (await this.store.read())?.[userUuid]
    return (
      account?.inbox.map((message) => {
        const replyState = account.receipts.find((entry) => entry.updateId === message.updateId)?.reply
        return { ...message, ...(replyState ? { replyState } : {}) }
      }) ?? []
    )
  }

  async isLinked(userUuid: string): Promise<boolean> {
    this.assertUser(userUuid)
    return Boolean((await this.store.read())?.[userUuid]?.binding)
  }

  /** A persisted sending state never automatically expires: a crashed sender may have delivered. */
  async claimReply(userUuid: string, updateId: number): Promise<{ chatId: string } | { alreadySent: true }> {
    this.assertUser(userUuid)
    let result: { chatId: string } | { alreadySent: true } | undefined
    await this.store.update((current) => {
      const state = current ?? {}
      const account = state[userUuid]
      const receipt = account?.receipts.find((entry) => entry.updateId === updateId)
      if (!account?.binding || !receipt) {
        throw new Error('TELEGRAM_MESSAGE_NOT_FOUND')
      }
      if (receipt.reply === 'sent') {
        result = { alreadySent: true }
        return state
      }
      if (receipt.reply) {
        throw new Error('TELEGRAM_REPLY_UNCERTAIN')
      }
      if (!account.inbox.some((entry) => entry.updateId === updateId)) {
        throw new Error('TELEGRAM_MESSAGE_NOT_FOUND')
      }
      receipt.reply = 'sending'
      result = { chatId: account.binding.chatId }
      return state
    })
    return result!
  }

  async finishReply(userUuid: string, updateId: number, status: 'sent' | 'uncertain'): Promise<void> {
    this.assertUser(userUuid)
    await this.store.update((current) => {
      const state = current ?? {}
      const receipt = state[userUuid]?.receipts.find((entry) => entry.updateId === updateId)
      if (receipt?.reply === 'sending') {
        receipt.reply = status
        if (status === 'sent') {
          state[userUuid].inbox = state[userUuid].inbox.filter((entry) => entry.updateId !== updateId)
        }
      }
      return state
    })
  }

  async acknowledge(userUuid: string, updateIds: number[]): Promise<void> {
    this.assertUser(userUuid)
    if (!Array.isArray(updateIds) || updateIds.length > MAX_INBOX || !updateIds.every(validUpdate)) {
      throw new Error('TELEGRAM_INVALID_ACK')
    }
    await this.store.update((current) => {
      const state = current ?? {}
      if (state[userUuid]) {
        state[userUuid].inbox = state[userUuid].inbox.filter((entry) => !updateIds.includes(entry.updateId))
      }
      return state
    })
  }

  async revoke(userUuid: string): Promise<void> {
    this.assertUser(userUuid)
    await this.store.update((current) => {
      const state = current ?? {}
      delete state[userUuid]
      return state
    })
  }

  private assertUser(userUuid: string): void {
    if (!isSafeRecordKey(userUuid)) {
      throw new Error('TELEGRAM_INVALID_ACCOUNT')
    }
  }
  private validIdentity(identity: TelegramPrivateIdentity): boolean {
    return (
      identity?.chatType === 'private' &&
      validId(identity.chatId) &&
      validId(identity.senderId) &&
      identity.chatId === identity.senderId
    )
  }
}
