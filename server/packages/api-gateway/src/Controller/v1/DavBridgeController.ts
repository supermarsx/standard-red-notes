import { Request, Response } from 'express'
import { inject, optional } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, httpPut } from 'inversify-express-utils'
import { Role } from '@standardnotes/security'
import { RoleName, SettingName } from '@standardnotes/domain-core'

import { TYPES } from '../../Bootstrap/Types'
import { DavBridgeRefusal, davRefusal } from '../../Service/DavBridge/DavBridgeRefusal'
import { DavBridgeCaller, DavBridgeService } from '../../Service/DavBridge/DavBridgeService'
import { DavRelayAbortedError } from '../../Service/DavBridge/DavRelay'
import { GatewayUserDataPurger } from '../../Service/UserData/GatewayUserDataPurger'

interface DavBridgeControllerLogger {
  error(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
}

/**
 * Who is asking, from the verified session and from nothing else. No route
 * here accepts a user id in a path or a body.
 */
function callerFrom(response: Response): DavBridgeCaller {
  const locals = response.locals as {
    user?: { uuid?: unknown }
    settings?: Record<string, unknown>
    readOnlyAccess?: unknown
    mcpScope?: unknown
  }
  const userUuid = locals.user?.uuid
  if (typeof userUuid !== 'string' || userUuid.length === 0) {
    throw davRefusal.sessionNotPermitted('no-user')
  }
  return {
    userUuid,
    // Only the literal the gateway's own middleware projects for a token that
    // carries `dav_bridge_allowed: true`. Absent, 'false' and anything else
    // are all "not permitted".
    permitted: locals.settings?.[SettingName.NAMES.DavBridgeAllowed] === 'true',
    readOnlySession: locals.readOnlyAccess === true,
    mcpScoped: locals.mcpScope !== undefined && locals.mcpScope !== null,
  }
}

/**
 * Runs a handler and writes its answer, or the refusal it threw.
 *
 * The two kinds of answer are kept apart here once, for every route: a result
 * goes out with the status the handler chose, a `DavBridgeRefusal` goes out
 * with its own status and its `dav-` tag, and anything else is a defect in this
 * server and goes out as a bare 500 with NO `dav-` tag, so that a client cannot
 * mistake "this server broke" for a decision about the user's calendar.
 */
async function respond(
  response: Response,
  logger: DavBridgeControllerLogger | undefined,
  handler: () => Promise<{ status?: number; body: unknown }>,
): Promise<void> {
  // Calendar content and account details must not be kept by any cache.
  response.setHeader('Cache-Control', 'no-store')
  try {
    const { status, body } = await handler()
    response.status(status ?? 200).json(body)
  } catch (error) {
    if (error instanceof DavBridgeRefusal) {
      if (error.retryAfterSeconds !== undefined) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds))
      }
      response.status(error.httpStatus).json(error.toBody())
      return
    }
    if (error instanceof DavRelayAbortedError) {
      // The caller went away mid-request. Nobody is listening; end quietly.
      if (!response.headersSent) {
        response.status(499).end()
      }
      return
    }
    // Only the error's class name: its message can quote a file path that
    // names a user, or text that came from a remote server.
    // Guarded and then called plainly, with no optional chaining on the logger:
    // the repository's safe-logging gate does not recognise an optional-chained
    // call as a log call at all, so one written that way would go unchecked.
    if (logger !== undefined) {
      logger.error('dav bridge request failed', {
        reason: 'internal',
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      })
    }
    response.status(500).json({ error: { message: 'Calendar sync failed on this server.' } })
  }
}

/**
 * Standard Red Notes: two-way calendar and task sync with a user's own
 * Nextcloud or CalDAV account, with this server as the go-between.
 *
 * The app does the syncing; it holds the keys. This API stores an external
 * account's credential (encrypted, never returned), checks every address
 * against the administrator's network policy, and forwards one request at a
 * time. It keeps no copy of calendar content.
 *
 * Every route requires a session (RequiredCrossServiceTokenMiddleware). The
 * two gates, the session rules and the budgets are enforced inside
 * DavBridgeService, not here and not in middleware, so they hold on both
 * deployment shapes and for any route added later.
 *
 * Listing and deleting accounts work with the gates closed: a user must always
 * be able to see and remove what the server holds for them.
 */
@controller('/v1/dav-bridge')
export class DavBridgeController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_DavBridgeService) private davBridgeService: DavBridgeService,
    @inject(TYPES.ApiGateway_Logger) @optional() private logger?: DavBridgeControllerLogger,
  ) {
    super()
  }

  @httpGet('/config', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async config(_request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => ({
      body: await this.davBridgeService.config(callerFrom(response)),
    }))
  }

  @httpGet('/accounts', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listAccounts(_request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => ({
      body: { accounts: await this.davBridgeService.listAccounts(callerFrom(response)) },
    }))
  }

  @httpPost('/accounts', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async createAccount(request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => ({
      status: 201,
      body: { account: await this.davBridgeService.createAccount(callerFrom(response), request.body) },
    }))
  }

  @httpDelete('/accounts', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async deleteAllAccounts(_request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => ({
      body: { deleted: await this.davBridgeService.deleteAllAccounts(callerFrom(response)) },
    }))
  }

  @httpDelete('/accounts/:accountId', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async deleteAccount(request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => {
      await this.davBridgeService.deleteAccount(callerFrom(response), String(request.params.accountId))
      return { body: { deleted: true } }
    })
  }

  @httpPut('/accounts/:accountId/secret', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async replaceSecret(request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => ({
      body: {
        account: await this.davBridgeService.replaceSecret(
          callerFrom(response),
          String(request.params.accountId),
          request.body,
        ),
      },
    }))
  }

  @httpPut('/accounts/:accountId/pin', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setPin(request: Request, response: Response): Promise<void> {
    await respond(response, this.logger, async () => ({
      body: {
        account: await this.davBridgeService.setPin(
          callerFrom(response),
          String(request.params.accountId),
          request.body,
        ),
      },
    }))
  }

  /**
   * One JSON envelope in, one JSON envelope out. A remote answer is always
   * HTTP 200 with a `remote` object; a refusal is never 200.
   */
  @httpPost('/accounts/:accountId/relay', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async relay(request: Request, response: Response): Promise<void> {
    // Stop the outbound request when the caller goes away, so an abandoned tab
    // does not keep a socket to somebody else's server open for 30 seconds.
    const abort = new AbortController()
    const onClose = (): void => {
      if (!response.writableEnded) {
        abort.abort()
      }
    }
    response.on('close', onClose)
    try {
      await respond(response, this.logger, async () => ({
        body: await this.davBridgeService.relay(
          callerFrom(response),
          String(request.params.accountId),
          request.body,
          abort.signal,
        ),
      }))
    } finally {
      response.off('close', onClose)
    }
  }
}

/**
 * Standard Red Notes: the administrator's side of the DAV bridge.
 *
 * The switch, the mode, who may use it, which private origins users may
 * connect to, and purging what the server holds. ADMIN_USER only, refused
 * here (the session middleware has already verified the roles).
 *
 * What an administrator can see per user is: how many accounts, each account's
 * origin and kind, the class of its last result and a request count. Not a
 * username, not a path, not content.
 */
@controller('/v1/admin/dav-bridge')
export class AdminDavBridgeController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_DavBridgeService) private davBridgeService: DavBridgeService,
    @inject(TYPES.ApiGateway_Logger) @optional() private logger?: DavBridgeControllerLogger,
    @inject(TYPES.ApiGateway_GatewayUserDataPurger) @optional() private userDataPurger?: GatewayUserDataPurger,
  ) {
    super()
  }

  /**
   * The view, plus how many DELETED accounts still have gateway data waiting
   * to be removed (a purge that failed, or a deletion the next sweep has not
   * reached yet). Zero is the normal state; a number that stays above zero is
   * something an administrator should see, and so is `null`, which means the
   * gateway cannot read its record and does not know.
   */
  private async viewBody(): Promise<Record<string, unknown>> {
    const view = await this.davBridgeService.adminView()
    const pendingAccountPurges = this.userDataPurger === undefined ? 0 : await this.userDataPurger.pendingCount()
    return { ...view, pendingAccountPurges }
  }

  private requestorIsAdmin(response: Response): boolean {
    const roles = ((response.locals as { roles?: Role[] }).roles ?? []) as Role[]

    return roles.some((role) => role.name === RoleName.NAMES.AdminUser)
  }

  private refuseNonAdmin(response: Response): boolean {
    if (this.requestorIsAdmin(response)) {
      return false
    }
    response.status(403).json({ error: { message: 'Admin role required.' } })

    return true
  }

  @httpGet('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async view(_request: Request, response: Response): Promise<void> {
    if (this.refuseNonAdmin(response)) {
      return
    }
    await respond(response, this.logger, async () => ({ body: await this.viewBody() }))
  }

  @httpPut('/', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async update(request: Request, response: Response): Promise<void> {
    if (this.refuseNonAdmin(response)) {
      return
    }
    await respond(response, this.logger, async () => {
      const changedSettings = await this.davBridgeService.adminUpdate(request.body)
      // Audit: setting NAMES only, never values (an origin list is topology).
      if (this.logger !== undefined) {
        this.logger.info('admin dav-bridge settings updated', {
          audit: 'admin.dav-bridge.update',
          adminUuid: ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? null,
          changedSettings,
        })
      }
      return { body: await this.viewBody() }
    })
  }

  @httpPost('/purge', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async purge(request: Request, response: Response): Promise<void> {
    if (this.refuseNonAdmin(response)) {
      return
    }
    await respond(response, this.logger, async () => {
      const body = (request.body ?? {}) as { scope?: unknown; userUuid?: unknown; confirm?: unknown }
      const adminUuid = ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? null

      if (body.scope === 'user') {
        if (typeof body.userUuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(body.userUuid)) {
          throw davRefusal.invalidInput('userUuid')
        }
        const result = await this.davBridgeService.purgeUser(body.userUuid)
        if (this.logger !== undefined) {
          this.logger.info('admin dav-bridge purge', {
            audit: 'admin.dav-bridge.purge',
            adminUuid,
            scope: 'user',
            purgedAccounts: result.purgedAccounts,
          })
        }
        return { body: result }
      }

      if (body.scope === 'all') {
        // Typed out by the caller, so that one stray request cannot remove
        // every user's connected accounts.
        if (body.confirm !== 'purge-all') {
          throw davRefusal.invalidInput('confirm', 'Send confirm: "purge-all" to remove every stored account.')
        }
        const result = await this.davBridgeService.purgeAll()
        if (this.logger !== undefined) {
          this.logger.info('admin dav-bridge purge', {
            audit: 'admin.dav-bridge.purge',
            adminUuid,
            scope: 'all',
            purgedUsers: result.purgedUsers,
            purgedAccounts: result.purgedAccounts,
          })
        }
        return { body: result }
      }

      throw davRefusal.invalidInput('scope', 'scope must be "user" or "all".')
    })
  }
}
