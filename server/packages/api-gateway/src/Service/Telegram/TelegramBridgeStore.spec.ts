import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TelegramBridgeStore, verifyTelegramWebhookSecret } from './TelegramBridgeStore'

describe('TelegramBridgeStore', () => {
  let directory: string
  let file: string
  let store: TelegramBridgeStore
  let now: number
  const identity = { chatType: 'private' as const, chatId: '12345', senderId: '12345' }
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-bridge-'))
    file = path.join(directory, 'bridge.json')
    now = 1_800_000_000_000
    store = new TelegramBridgeStore(file, () => now)
  })
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })
  const pair = async () => {
    const { code } = await store.createPairing('alice')
    expect(await store.consumePairing(code, identity)).toBe(true)
  }

  it('persists only a hash, expires after ten minutes and replaces earlier codes', async () => {
    const first = await store.createPairing('alice')
    expect(await fs.readFile(file, 'utf8')).not.toContain(first.code)
    const second = await store.createPairing('alice')
    expect(second.code).toHaveLength(43)
    expect(second.expiresAt - now).toBe(600_000)
    expect(await store.consumePairing(first.code, identity)).toBe(false)
    now += 600_000
    expect(await store.consumePairing(second.code, identity)).toBe(false)
  })

  it('consumes once across concurrent instances and rejects group or mismatched sender', async () => {
    const { code } = await store.createPairing('alice')
    expect(await store.consumePairing(code, { ...identity, chatType: 'group' as 'private' })).toBe(false)
    expect(await store.consumePairing(code, { ...identity, senderId: '9876' })).toBe(false)
    const other = new TelegramBridgeStore(file, () => now)
    expect(
      (await Promise.all([store.consumePairing(code, identity), other.consumePairing(code, identity)])).sort(),
    ).toEqual([false, true])
  })

  it('cannot bind one Telegram sender to another account', async () => {
    await pair()
    const { code } = await store.createPairing('bob')
    expect(await store.consumePairing(code, identity)).toBe(false)
    await store.enqueue(identity, 1, 'hello')
    expect(await store.poll('bob')).toEqual([])
    await store.acknowledge('bob', [1])
    expect(await store.poll('alice')).toHaveLength(1)
  })

  it('durably deduplicates concurrent inbox arrivals and acknowledged updates', async () => {
    await pair()
    const other = new TelegramBridgeStore(file, () => now)
    expect(
      (await Promise.all([store.enqueue(identity, 5, 'hello'), other.enqueue(identity, 5, 'hello')])).sort(),
    ).toEqual(['accepted', 'duplicate'])
    expect(await other.poll('alice')).toEqual([{ updateId: 5, text: 'hello', receivedAt: now }])
    await other.acknowledge('alice', [5])
    expect(await store.enqueue(identity, 5, 'hello')).toBe('duplicate')
    expect(await store.poll('alice')).toEqual([])
  })

  it('preserves pending messages when pairing the same sender and requires revocation to change sender', async () => {
    await pair()
    await store.enqueue(identity, 1, 'keep this')
    const { code } = await store.createPairing('alice')
    expect(await store.consumePairing(code, { chatType: 'private', chatId: '6789', senderId: '6789' })).toBe(false)
    expect(await store.consumePairing(code, identity)).toBe(true)
    expect(await store.poll('alice')).toHaveLength(1)
    expect(await store.enqueue(identity, 1, 'keep this')).toBe('duplicate')
  })

  it('rejects overflow without dropping earlier messages; acknowledgement frees capacity', async () => {
    await pair()
    for (let i = 0; i < 100; i++) {
      await store.enqueue(identity, i, `message ${i}`)
    }
    await expect(store.enqueue(identity, 101, 'overflow')).rejects.toThrow('TELEGRAM_INBOX_FULL')
    expect(await store.poll('alice')).toHaveLength(100)
    await store.acknowledge('alice', [0])
    expect(await store.enqueue(identity, 101, 'retry')).toBe('accepted')
  })

  it('revocation deletes queued plaintext and pairing, refusing subsequent messages', async () => {
    await pair()
    await store.enqueue(identity, 1, 'sensitive message')
    const { code } = await store.createPairing('alice')
    await store.revoke('alice')
    expect(await store.consumePairing(code, identity)).toBe(false)
    expect(await store.enqueue(identity, 2, 'ignored')).toBe('unlinked')
    expect(await fs.readFile(file, 'utf8')).not.toContain('sensitive')
  })

  it('fails closed on corrupt saved data and invalid input', async () => {
    await fs.writeFile(file, '{bad json')
    await expect(store.poll('alice')).rejects.toThrow()
    await expect(store.createPairing('__proto__')).rejects.toThrow('TELEGRAM_INVALID_ACCOUNT')
    await expect(store.enqueue(identity, -1, 'hello')).rejects.toThrow('TELEGRAM_INVALID_MESSAGE')
  })

  it('checks webhook secrets without accepting missing, malformed or arrays', () => {
    const secret = 'a'.repeat(32)
    expect(verifyTelegramWebhookSecret(secret, secret)).toBe(true)
    expect(verifyTelegramWebhookSecret(secret, 'b'.repeat(32))).toBe(false)
    expect(verifyTelegramWebhookSecret(undefined, undefined)).toBe(false)
    expect(verifyTelegramWebhookSecret('short', 'short')).toBe(false)
    expect(verifyTelegramWebhookSecret(secret, [secret])).toBe(false)
  })
})
