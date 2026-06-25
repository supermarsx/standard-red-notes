import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost } from 'inversify-express-utils'
import { SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import { CaldavService } from '../../Service/Caldav/CaldavService'

/**
 * Standard Red Notes: management API for scoped, revocable CalDAV access tokens.
 *
 * These tokens are the Basic-auth credential stock CalDAV clients use to read
 * the user's PUBLISHED reminders feed (see CaldavService / createCaldavRouter).
 * They are NOT the account password and are read-only calendar scope.
 *
 * GATING (off by default, two gates):
 *   1. env master switch CALDAV_ENABLED (service.isEnabled()),
 *   2. per-user opt-in: the CALDAV_ENABLED setting must be 'true' for THIS user
 *      before a token can be issued. The setting is read from the request's
 *      resolved settings (same opportunistic channel the AI/OCR proxies use);
 *      when absent it fails CLOSED.
 *
 * All routes require a valid session (RequiredCrossServiceTokenMiddleware), so
 * `response.locals.user.uuid` identifies the owner.
 *
 * `/config` reports whether the feature is available FOR THIS USER so the client
 * can decide whether to show the CalDAV settings UI.
 */
@controller('/v1/caldav/tokens')
export class CaldavTokensController extends BaseHttpController {
  constructor(@inject(TYPES.ApiGateway_CaldavService) private caldavService: CaldavService) {
    super()
  }

  @httpGet('/config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async config(_request: Request, response: Response): Promise<void> {
    const enabled = this.caldavService.isEnabled()
    const allowed = this.userAllowed(response)
    response.json({
      caldavEnabled: enabled,
      allowed,
      available: enabled && allowed,
    })
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async list(_request: Request, response: Response): Promise<void> {
    if (!this.caldavService.isEnabled()) {
      this.respondDisabled(response)
      return
    }
    const userUuid = (response.locals.user as { uuid: string }).uuid
    const tokens = await this.caldavService.listTokens(userUuid)
    response.json({ tokens })
  }

  @httpPost('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async create(request: Request, response: Response): Promise<void> {
    if (!this.caldavService.isEnabled()) {
      this.respondDisabled(response)
      return
    }
    if (!this.userAllowed(response)) {
      response.status(403).json({
        error: {
          tag: 'caldav-not-allowed',
          message: 'CalDAV access is not enabled for your account.',
        },
      })
      return
    }

    const userUuid = (response.locals.user as { uuid: string }).uuid
    const label = typeof (request.body as { label?: unknown })?.label === 'string'
      ? (request.body as { label: string }).label
      : ''

    try {
      const created = await this.caldavService.createToken(userUuid, label)
      // The plaintext token is returned exactly once here.
      response.status(201).json({ token: created })
    } catch (error) {
      response.status(400).json({ error: { message: (error as Error).message } })
    }
  }

  @httpDelete('/:tokenUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async revoke(request: Request, response: Response): Promise<void> {
    if (!this.caldavService.isEnabled()) {
      this.respondDisabled(response)
      return
    }
    const userUuid = (response.locals.user as { uuid: string }).uuid
    const tokenUuid = request.params.tokenUuid as string
    const removed = await this.caldavService.revokeToken(userUuid, tokenUuid)
    if (!removed) {
      response.status(404).json({ error: { message: 'CalDAV token not found.' } })
      return
    }
    response.status(200).json({ revoked: true })
  }

  private respondDisabled(response: Response): void {
    response.status(403).json({
      error: {
        tag: 'caldav-disabled',
        message: 'CalDAV is disabled on this server.',
      },
    })
  }

  private userAllowed(response: Response): boolean {
    const settings = (response.locals as { settings?: Record<string, unknown> }).settings
    if (!settings) {
      return false
    }
    const raw = settings[SettingName.NAMES.CaldavEnabled]
    return raw !== undefined && raw !== null && `${raw}`.toLowerCase() === 'true'
  }
}
