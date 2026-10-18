import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import { TYPES } from '../../Bootstrap/Types'
import { TELEGRAM_BRIDGE_SERVICE, TelegramBridgeService } from '../../Service/Telegram/TelegramBridgeService'
import { ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'

@controller('/v1/assistant/telegram')
export class TelegramBridgeController extends BaseHttpController {
  constructor(
    @inject(TELEGRAM_BRIDGE_SERVICE) private readonly service: TelegramBridgeService,
    @inject(TYPES.ApiGateway_ServerSettingsResolver) private readonly settings?: ServerSettingsResolver,
  ) {
    super()
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async status(_request: Request, response: Response): Promise<void> {
    if (!(await this.admit(response))) {
      return
    }
    await this.authenticated(response, (user) => this.service.status(user))
  }
  @httpPost('/pair', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware, TYPES.ApiGateway_UserRateLimitMiddleware)
  async pair(_request: Request, response: Response): Promise<void> {
    if (!(await this.admit(response))) {
      return
    }
    await this.authenticated(response, (user) => this.service.pair(user))
  }
  @httpPost('/revoke', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async revoke(_request: Request, response: Response): Promise<void> {
    await this.authenticated(response, async (user) => {
      await this.service.revoke(user)
      return { ok: true }
    })
  }
  @httpPost('/ack', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async acknowledge(request: Request, response: Response): Promise<void> {
    await this.authenticated(response, async (user) => {
      await this.service.acknowledge(user, request.body?.updateIds)
      return { acknowledged: true }
    })
  }
  @httpPost('/reply', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware, TYPES.ApiGateway_UserRateLimitMiddleware)
  async reply(request: Request, response: Response): Promise<void> {
    if (!(await this.admit(response))) {
      return
    }
    await this.authenticated(response, async (user) => {
      const result = await this.service.reply(user, request.body?.updateId, request.body?.text)
      return { ok: true, ...(result.alreadySent ? { alreadySent: true } : {}) }
    })
  }
  @httpPost('/webhook')
  async webhook(request: Request, response: Response): Promise<void> {
    if (!(await this.admit(response))) {
      return
    }
    try {
      await this.service.webhook(request.headers['x-telegram-bot-api-secret-token'], request.body)
      response.json({ ok: true })
    } catch (error) {
      this.failure(response, error)
    }
  }
  private async admit(response: Response): Promise<boolean> {
    try {
      if (!this.settings) {
        throw new Error('unavailable')
      }
      if (!(await this.settings.resolveAssistantInternetAccessEnabled())) {
        response.status(403).json({ error: { code: 'INTERNET_ACCESS_DISABLED' } })
        return false
      }
      return true
    } catch {
      response.status(503).json({ error: { code: 'INTERNET_ACCESS_POLICY_UNAVAILABLE' } })
      return false
    }
  }
  private async authenticated(response: Response, action: (userUuid: string) => Promise<unknown>): Promise<void> {
    const user = response.locals.user?.uuid
    if (typeof user !== 'string' || !user) {
      response.status(401).json({ error: { code: 'UNAUTHORIZED' } })
      return
    }
    try {
      response.json(await action(user))
    } catch (error) {
      this.failure(response, error)
    }
  }
  private failure(response: Response, error: unknown): void {
    const code = error instanceof Error ? error.message : ''
    const known: Record<string, number> = {
      TELEGRAM_NOT_CONFIGURED: 503,
      TELEGRAM_WEBHOOK_UNAUTHORIZED: 403,
      TELEGRAM_INVALID_UPDATE: 400,
      TELEGRAM_INVALID_MESSAGE: 400,
      TELEGRAM_INVALID_REPLY: 400,
      TELEGRAM_INVALID_ACK: 400,
      TELEGRAM_INVALID_ACCOUNT: 400,
      TELEGRAM_MESSAGE_NOT_FOUND: 404,
      TELEGRAM_REPLY_UNCERTAIN: 409,
      TELEGRAM_INBOX_FULL: 503,
      TELEGRAM_ACCOUNT_CAPACITY: 503,
    }
    response.status(known[code] ?? 503).json({ error: { code: known[code] ? code : 'TELEGRAM_STORAGE_UNAVAILABLE' } })
  }
}
