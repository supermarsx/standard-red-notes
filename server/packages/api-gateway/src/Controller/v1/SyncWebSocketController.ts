import { Request, Response } from 'express'
import { inject, optional } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import { Logger } from 'winston'
import { createLogThrottle, isSyncDeviceId, type LogThrottle } from '@standard-red-notes/websocket-gateway'

import { TYPES } from '../../Bootstrap/Types'
import { ResponseLocals } from '../ResponseLocals'
import {
  SyncWebSocketUnavailableError,
  syncWebSocketAccessService,
  SyncWebSocketAccessService,
} from '../../Service/Sync/SyncWebSocketAccessService'
import { describeUnmetSyncPreconditions } from '../../Service/Sync/SyncWebSocketPreconditions'
import { syncGateDiagnostics, SyncGateDiagnosticsRecorder } from '../../Service/Sync/SyncGateDiagnostics'

@controller('/v1/sockets/sync')
export class SyncWebSocketController extends BaseHttpController {
  /**
   * Refusals here are driven by clients that retry, so they are throttled to one
   * line per distinct cause per minute, each carrying the count it suppressed.
   * The DEFINITIVE statement of why sync is off is logged once at startup by the
   * composition root — these per-request lines exist so an operator who was not
   * watching the boot log can still see the cause while a client is failing.
   */
  private readonly refusalLog: LogThrottle = createLogThrottle()

  private readonly accessService: SyncWebSocketAccessService
  private readonly diagnostics: SyncGateDiagnosticsRecorder

  /**
   * *** EVERY PARAMETER MUST CARRY @inject(). ***
   *
   * This class is bound `toSelf()` and resolved by Inversify PER REQUEST, so the
   * TypeScript default values below are never what production sees — Inversify
   * supplies every argument itself. `emitDecoratorMetadata` is on, so an
   * UNDECORATED parameter makes Inversify read the emitted `design:paramtypes`
   * and treat the parameter's CLASS as a service identifier to resolve. Nothing
   * binds these two classes, so resolution threw
   * `No bindings found for service: "SyncWebSocketAccessService"` before the
   * handler ran, and BOTH routes answered 500 — including `/capabilities`, which
   * is public, static, and must never fail. The defaults look like they cover
   * it and do not: Inversify never reaches them.
   *
   * `@optional()` is what makes an unbound identifier resolve to `undefined`
   * instead of throwing; the `??` fallbacks then reach the module singletons the
   * boot gate late-binds. Tests still construct this class directly and pass
   * fakes positionally.
   */
  constructor(
    @inject(TYPES.ApiGateway_Logger) @optional() private readonly logger?: Logger,
    @inject(TYPES.ApiGateway_SyncWebSocketAccessService)
    @optional()
    accessService?: SyncWebSocketAccessService,
    @inject(TYPES.ApiGateway_SyncGateDiagnostics)
    @optional()
    diagnostics?: SyncGateDiagnosticsRecorder,
  ) {
    super()
    this.accessService = accessService ?? syncWebSocketAccessService
    this.diagnostics = diagnostics ?? syncGateDiagnostics
  }

  /**
   * The boot-time gate record comes from `SyncGateDiagnostics` — the SAME
   * recorder the admin diagnostics panel reads — rather than a second copy held
   * here, so a log line and the panel can never disagree about which
   * precondition is unmet.
   *
   * Never log anything from a precondition beyond its code and remedy: both are
   * compile-time constants naming env VARIABLES, never their contents.
   */
  private logRefusal(event: string, code: string, availabilityRelated: boolean): void {
    const unmetPreconditions = availabilityRelated ? this.diagnostics.report().unmetPreconditions : []
    const reasons = availabilityRelated ? this.accessService.unavailabilityReasons() : []
    const decision = this.refusalLog.consider(
      `${event}:${code}:${unmetPreconditions.map((precondition) => precondition.code).join()}:${reasons.join()}`,
    )
    if (!decision.emit) {
      return
    }

    this.logger?.warn(
      availabilityRelated
        ? `Realtime sync unavailable (${code}): ${describeUnmetSyncPreconditions(unmetPreconditions)}`
        : `Realtime sync refused a request (${code}).`,
      {
        code,
        event,
        ...(availabilityRelated
          ? {
              unmetPreconditions: unmetPreconditions.map((precondition) => precondition.code),
              gatewayReasons: reasons,
            }
          : {}),
        suppressedSinceLastLog: decision.suppressed,
      },
    )
  }

  /**
   * Deliberately unauthenticated: clients negotiate the sync transport before
   * they hold a session, and the payload is the static protocol descriptor
   * (`id`/`version`/`endpoint`), empty while sync is unavailable. Never return
   * anything derived from the request or from a user, vault or subscription
   * here — the allowlist in `Controller/RouteDispatch.spec.ts` pins this route
   * as public on exactly that basis. Access itself is granted by `/ticket`.
   *
   * An empty list is the single most consequential thing this service says: the
   * client silently falls back off the realtime transport. It used to be
   * returned with no server-side trace at all, leaving the operator to discover
   * it in a browser console. It is now logged (throttled) with the cause.
   */
  @httpGet('/capabilities')
  capabilities(_request: Request, response: Response): void {
    const capabilities = this.accessService.capabilities()
    if (capabilities.capabilities.length === 0) {
      this.logRefusal('capabilities', 'EMPTY_CAPABILITY_LIST', true)
    }
    response.status(200).send(capabilities)
  }

  @httpPost('/ticket', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async ticket(request: Request, response: Response): Promise<void> {
    const deviceId = request.body?.deviceId
    if (!isSyncDeviceId(deviceId)) {
      this.logRefusal('ticket', 'INVALID_DEVICE', false)
      response.status(400).send({ error: { code: 'INVALID_DEVICE' } })
      return
    }

    const locals = response.locals as ResponseLocals
    const authorization = request.headers.authorization
    if (
      !locals.user?.uuid ||
      !locals.session?.uuid ||
      typeof authorization !== 'string' ||
      authorization.length === 0
    ) {
      this.logRefusal('ticket', 'AUTH_REJECTED', false)
      response.status(401).send({ error: { code: 'AUTH_REJECTED' } })
      return
    }

    try {
      const ticket = await this.accessService.issueTicket({
        userUuid: locals.user.uuid,
        sessionUuid: locals.session.uuid,
        deviceId,
        authorization,
      })
      response.status(200).send(ticket)
    } catch (error) {
      if (error instanceof SyncWebSocketUnavailableError) {
        this.logRefusal('ticket', 'SYNC_DISABLED', true)
        response.status(503).send({ error: { code: 'SYNC_DISABLED' } })
        return
      }
      throw error
    }
  }
}
