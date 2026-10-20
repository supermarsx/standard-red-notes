import 'reflect-metadata'
import { Request, Response } from 'express'
import { TelegramBridgeController } from './TelegramBridgeController'
import { TelegramBridgeService } from '../../Service/Telegram/TelegramBridgeService'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

describe('TelegramBridgeController', () => {
  let service: jest.Mocked<TelegramBridgeService>
  let resolver: { resolveAssistantInternetAccessEnabled: jest.Mock }
  let response: Response
  let json: jest.Mock
  let status: jest.Mock
  beforeEach(() => {
    service = {
      status: jest.fn().mockResolvedValue({ linked: false }),
      pair: jest.fn(),
      revoke: jest.fn(),
      acknowledge: jest.fn(),
      reply: jest.fn().mockResolvedValue({ sent: true }),
      webhook: jest.fn(),
    } as unknown as jest.Mocked<TelegramBridgeService>
    resolver = { resolveAssistantInternetAccessEnabled: jest.fn().mockResolvedValue(true) }
    json = jest.fn()
    status = jest.fn(() => response)
    response = { locals: { user: { uuid: 'alice' } }, json, status } as unknown as Response
  })
  const controller = () => new TelegramBridgeController(service, resolver as unknown as ServerSettingsResolver)
  it('uses authenticated principal, never caller supplied account or destination', async () => {
    await controller().reply(
      { body: { userUuid: 'bob', chatId: '456', updateId: 2, text: 'hello' } } as Request,
      response,
    )
    expect(service.reply).toHaveBeenCalledWith('alice', 2, 'hello')
    expect(json).toHaveBeenCalledWith({ ok: true })
  })
  it('rejects missing authentication before service calls', async () => {
    response.locals = {}
    await controller().pair({} as Request, response)
    expect(status).toHaveBeenCalledWith(401)
    expect(service.pair).not.toHaveBeenCalled()
  })
  it('gates Internet methods but permits revocation while policy disabled', async () => {
    resolver.resolveAssistantInternetAccessEnabled.mockResolvedValue(false)
    await controller().status({} as Request, response)
    await controller().pair({} as Request, response)
    await controller().reply({ body: {} } as Request, response)
    await controller().webhook({ headers: {} } as Request, response)
    expect(service.status).not.toHaveBeenCalled()
    expect(service.reply).not.toHaveBeenCalled()
    expect(service.webhook).not.toHaveBeenCalled()
    await controller().revoke({} as Request, response)
    expect(service.revoke).toHaveBeenCalledWith('alice')
  })
  it('fails closed when policy resolver is unavailable', async () => {
    await new TelegramBridgeController(service).pair({} as Request, response)
    expect(status).toHaveBeenCalledWith(503)
    expect(service.pair).not.toHaveBeenCalled()
  })
  it('forwards webhook secret and returns explicit capacity failure for retry', async () => {
    service.webhook.mockRejectedValue(new Error('TELEGRAM_INBOX_FULL'))
    await controller().webhook(
      { headers: { 'x-telegram-bot-api-secret-token': 'secret' }, body: { update_id: 1 } } as Request,
      response,
    )
    expect(service.webhook).toHaveBeenCalledWith('secret', { update_id: 1 })
    expect(status).toHaveBeenCalledWith(503)
    expect(json).toHaveBeenCalledWith({ error: { code: 'TELEGRAM_INBOX_FULL' } })
  })
  it('returns forbidden when the webhook service rejects its separate credential', async () => {
    response.locals = {}
    service.webhook.mockRejectedValue(new Error('TELEGRAM_WEBHOOK_UNAUTHORIZED'))
    await controller().webhook({ headers: {}, body: { update_id: 1 } } as Request, response)
    expect(service.webhook).toHaveBeenCalledWith(undefined, { update_id: 1 })
    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith({ error: { code: 'TELEGRAM_WEBHOOK_UNAUTHORIZED' } })
  })
  it('redacts unexpected filesystem/provider errors', async () => {
    service.pair.mockRejectedValue(new Error('/private/path/token-secret'))
    await controller().pair({} as Request, response)
    expect(json).toHaveBeenCalledWith({ error: { code: 'TELEGRAM_STORAGE_UNAVAILABLE' } })
  })
})
