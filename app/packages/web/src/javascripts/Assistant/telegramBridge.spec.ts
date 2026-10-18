import type { WebApplication } from '@/Application/WebApplication'
import { telegramBridgeRequest } from './telegramBridge'

it('uses authenticated reads and sends only explicitly supplied reply data', async () => {
  const app = {
    serverGetJsonRequest: jest.fn().mockResolvedValue({ ok: true, data: { linked: true, messages: [] } }),
    serverJsonRequest: jest.fn().mockResolvedValue({ ok: true, data: { ok: true } }),
  } as unknown as WebApplication
  await telegramBridgeRequest(app, 'inbox')
  expect(app.serverGetJsonRequest).toHaveBeenCalledWith('/v1/assistant/telegram', undefined)
  await telegramBridgeRequest(app, 'reply', { updateId: 2, text: 'Approved reply' })
  expect(app.serverJsonRequest).toHaveBeenCalledWith(
    '/v1/assistant/telegram/reply',
    { updateId: 2, text: 'Approved reply' },
    undefined,
  )
})

it('does not retry uncertain delivery and reports actionable error', async () => {
  const send = jest
    .fn()
    .mockResolvedValue({ ok: false, status: 409, data: { error: { code: 'TELEGRAM_REPLY_UNCERTAIN' } } })
  const result = await telegramBridgeRequest({ serverJsonRequest: send } as unknown as WebApplication, 'reply', {})
  expect(result.error).toMatch(/may already have been sent/)
  expect(send).toHaveBeenCalledTimes(1)
})

it('honors internet lockdown but permits disconnect and cleanup', async () => {
  const send = jest.fn().mockResolvedValue({ ok: true, data: { ok: true } })
  const app = { getPreference: () => false, serverJsonRequest: send } as unknown as WebApplication
  expect(await telegramBridgeRequest(app, 'reply')).toMatchObject({ cancelled: true })
  expect(send).not.toHaveBeenCalled()
  await telegramBridgeRequest(app, 'revoke')
  await telegramBridgeRequest(app, 'ack', { updateIds: [] })
  expect(send).toHaveBeenCalledTimes(2)
})
