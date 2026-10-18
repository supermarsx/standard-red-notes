import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TelegramBridgeStore } from './TelegramBridgeStore'
import { TelegramBridgeService } from './TelegramBridgeService'

describe('TelegramBridgeService', () => {
  let directory: string
  let store: TelegramBridgeStore
  let service: TelegramBridgeService
  let send: jest.Mock
  const secret = 's'.repeat(32)
  const update = (id: number, text: string) => ({
    update_id: id,
    message: { chat: { type: 'private', id: 123 }, from: { id: 123, is_bot: false }, text },
  })
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-service-'))
    store = new TelegramBridgeStore(path.join(directory, 'state.json'))
    send = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    service = new TelegramBridgeService(store, { botToken: '123:secret', webhookSecret: secret }, send)
  })
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })
  const pair = async () => {
    const { code } = await service.pair('alice')
    await service.webhook(secret, update(1, `/start ${code}`))
  }
  it('pairs only from authenticated private webhook and never dispatches a model or message automatically', async () => {
    const { code } = await service.pair('alice')
    await expect(service.webhook('wrong', update(1, `/start ${code}`))).rejects.toThrow('TELEGRAM_WEBHOOK_UNAUTHORIZED')
    const group = update(1, `/start ${code}`)
    group.message.chat.type = 'group'
    await service.webhook(secret, group)
    expect((await service.status('alice')).linked).toBe(false)
    await service.webhook(secret, update(1, `/start ${code}`))
    await service.webhook(secret, update(2, 'hello'))
    expect(await service.status('alice')).toMatchObject({
      configured: true,
      linked: true,
      messages: [{ updateId: 2, text: 'hello' }],
    })
    expect(send).not.toHaveBeenCalled()
  })
  it('sends only to bound destination and durably suppresses repeat replies', async () => {
    await pair()
    await service.webhook(secret, update(2, 'hello'))
    expect(await service.reply('alice', 2, 'response')).toEqual({ sent: true })
    expect((await service.status('alice')).messages).toEqual([])
    expect(await service.reply('alice', 2, 'response')).toEqual({ sent: true, alreadySent: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('https://api.telegram.org/bot123:secret/sendMessage')
    expect(send.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      body: JSON.stringify({ chat_id: '123', text: 'response', link_preview_options: { is_disabled: true } }),
    })
    await expect(service.reply('bob', 2, 'response')).rejects.toThrow('TELEGRAM_MESSAGE_NOT_FOUND')
  })
  it('an ambiguous network failure is redacted and never blindly retried', async () => {
    await pair()
    await service.webhook(secret, update(2, 'hello'))
    send.mockRejectedValue(new Error('https://api.telegram.org/bot123:secret/sendMessage'))
    await expect(service.reply('alice', 2, 'response')).rejects.toThrow(/^TELEGRAM_REPLY_UNCERTAIN$/)
    await expect(service.reply('alice', 2, 'response')).rejects.toThrow('TELEGRAM_REPLY_UNCERTAIN')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('serializes concurrent reply claims', async () => {
    await pair()
    await service.webhook(secret, update(2, 'hello'))
    await Promise.allSettled([service.reply('alice', 2, 'response'), service.reply('alice', 2, 'response')])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not replay a reply after a process died with a persisted sending claim', async () => {
    await pair()
    await service.webhook(secret, update(2, 'hello'))
    await store.claimReply('alice', 2)
    const restarted = new TelegramBridgeService(
      new TelegramBridgeStore(path.join(directory, 'state.json')),
      { botToken: '123:secret', webhookSecret: secret },
      send,
    )
    await expect(restarted.reply('alice', 2, 'response')).rejects.toThrow('TELEGRAM_REPLY_UNCERTAIN')
    expect((await restarted.status('alice')).messages[0].replyState).toBe('sending')
    expect(send).not.toHaveBeenCalled()
  })

  it('an HTTP-success API refusal is not marked delivered', async () => {
    await pair()
    await service.webhook(secret, update(2, 'hello'))
    send.mockResolvedValue({ ok: true, json: async () => ({ ok: false }) })
    await expect(service.reply('alice', 2, 'response')).rejects.toThrow('TELEGRAM_REPLY_UNCERTAIN')
    expect((await service.status('alice')).messages[0].replyState).toBe('uncertain')
  })
  it('requires configuration and keeps revocation available after configuration removed', async () => {
    await pair()
    const disabled = new TelegramBridgeService(store, {}, send)
    await expect(disabled.pair('alice')).rejects.toThrow('TELEGRAM_NOT_CONFIGURED')
    await disabled.revoke('alice')
    expect((await disabled.status('alice')).linked).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('rejects oversized replies and sender spoofing before network access', async () => {
    await expect(service.reply('alice', 2, 'x'.repeat(4097))).rejects.toThrow('TELEGRAM_INVALID_REPLY')
    const spoof = update(2, 'hi')
    spoof.message.from.id = 456
    await expect(service.webhook(secret, spoof)).rejects.toThrow('TELEGRAM_INVALID_UPDATE')
    expect(send).not.toHaveBeenCalled()
  })
})
