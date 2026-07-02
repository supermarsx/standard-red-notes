import { Request, Response } from 'express'
import { inject } from 'inversify'
import { BaseHttpController, controller, httpGet, httpPost } from 'inversify-express-utils'
import { SettingName } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { TYPES } from '../../Bootstrap/Types'
import { WORKFLOWS_UI_COOKIE_NAME, WorkflowsService } from '../../Service/Workflows/WorkflowsService'

/**
 * Standard Red Notes: WORKFLOWS (n8n-backed automation) session endpoints.
 *
 * Contract (the web client is built against EXACTLY this):
 *   GET  /v1/workflows/status -> { enabled, paired, editorUrl }
 *   POST /v1/workflows/pair   -> { paired: true, editorUrl } (idempotent; 403 when not enabled)
 *   POST /v1/workflows/unpair -> { paired: false }           (idempotent)
 *
 * GATING (two layers, both re-validated server-side on EVERY call — never trust
 * the client):
 *   1. operator env master switch WORKFLOWS_ENABLED (default false),
 *   2. admin-managed per-user WorkflowsEnabled setting, which rides along in the
 *      cross-service token (`workflows_enabled`, emitted only when 'true') and is
 *      projected onto response.locals.settings by AuthMiddleware. Absent => NOT
 *      entitled (fail closed).
 *
 * All routes require a valid session (RequiredCrossServiceTokenMiddleware), so
 * `response.locals.user.uuid` identifies the caller.
 *
 * UI-ACCESS COOKIE: the embedded editor iframe cannot send the Authorization
 * header, so status/pair additionally set a short-lived, HttpOnly, path-scoped
 * cookie (signed JWT) that the /workflows-ui proxy verifies together with the
 * master switch and pairing state. Unpair clears it. See WorkflowsService.
 *
 * AUDIT: the auth service's audit-log writer and `admin.action` webhook
 * dispatcher are internal to auth and NOT reachable from the gateway's HTTP
 * deployment path, so pair/unpair are recorded as structured gateway log lines
 * instead (documented deferral in docs/WORKFLOWS_PLAN.md — Phase 3 moves these
 * onto the canonical audit surfaces).
 */
@controller('/v1/workflows')
export class WorkflowsController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_WorkflowsService) private workflowsService: WorkflowsService,
    @inject(TYPES.ApiGateway_Logger) private logger: Logger,
  ) {
    super()
  }

  /**
   * Feature availability FOR THIS USER: `enabled` = env master switch AND the
   * admin-managed per-user flag. `editorUrl` is non-null only when the user is
   * paired (and enabled, so a stale pairing on a disabled account exposes
   * nothing). Refreshes the editor-proxy cookie when the iframe may be shown.
   */
  @httpGet('/status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async status(_request: Request, response: Response): Promise<void> {
    const enabled = this.workflowsService.isEnabled() && this.userEnabled(response)
    const userUuid = (response.locals.user as { uuid: string }).uuid
    const paired = await this.workflowsService.isPaired(userUuid)

    if (enabled && paired) {
      this.setUiAccessCookie(response, userUuid)
    }

    response.json({
      enabled,
      paired,
      editorUrl: enabled && paired ? this.workflowsService.editorUrl() : null,
    })
  }

  /**
   * Explicit opt-in: records the pairing (idempotent) and arms the editor-proxy
   * cookie. Provisioning of the per-user n8n credential (scoped MCP token) and
   * SRN->n8n webhooks is deferred to Phase 2 — minting an MCP token requires
   * CLIENT-side wrapped key material (see CreateMcpToken), and webhook targets
   * only exist once the user has an n8n workflow with an SRN trigger.
   */
  @httpPost('/pair', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async pair(request: Request, response: Response): Promise<void> {
    if (!this.respondWhenNotEnabled(response)) {
      return
    }

    const userUuid = (response.locals.user as { uuid: string }).uuid
    await this.workflowsService.pair(userUuid)
    this.setUiAccessCookie(response, userUuid)

    // Audit trail (see class docblock for why this is a log line in Phase 1).
    this.logger.info('[workflows] user paired with the workflows engine', {
      action: 'workflows.paired',
      userId: userUuid,
      ip: this.clientIp(request),
    })

    response.json({
      paired: true,
      editorUrl: this.workflowsService.editorUrl(),
    })
  }

  /**
   * Revokes editor access (idempotent): removes the pairing record — the proxy
   * fails closed on the very next request — and expires the UI-access cookie.
   */
  @httpPost('/unpair', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async unpair(request: Request, response: Response): Promise<void> {
    if (!this.respondWhenNotEnabled(response)) {
      return
    }

    const userUuid = (response.locals.user as { uuid: string }).uuid
    const removed = await this.workflowsService.unpair(userUuid)
    this.clearUiAccessCookie(response)

    if (removed) {
      // Audit trail (see class docblock for why this is a log line in Phase 1).
      this.logger.info('[workflows] user unpaired from the workflows engine', {
        action: 'workflows.unpaired',
        userId: userUuid,
        ip: this.clientIp(request),
      })
    }

    response.json({ paired: false })
  }

  /** Emits the 403 contract responses. Returns true when the caller may proceed. */
  private respondWhenNotEnabled(response: Response): boolean {
    if (!this.workflowsService.isEnabled()) {
      response.status(403).json({
        error: {
          tag: 'workflows-disabled',
          message: 'Workflows are disabled on this server.',
        },
      })
      return false
    }

    if (!this.userEnabled(response)) {
      response.status(403).json({
        error: {
          tag: 'workflows-not-allowed',
          message: 'Workflows are not enabled for your account.',
        },
      })
      return false
    }

    return true
  }

  /**
   * Resolve the per-user WorkflowsEnabled flag from the request's settings (the
   * cross-service token channel the AI/OCR gates use). Absent/unresolvable ->
   * NOT allowed: this feature is opt-in per user, so it fails CLOSED.
   */
  private userEnabled(response: Response): boolean {
    const settings = (response.locals as { settings?: Record<string, unknown> }).settings
    if (!settings) {
      return false
    }
    const raw = settings[SettingName.NAMES.WorkflowsEnabled]
    return raw !== undefined && raw !== null && `${raw}`.toLowerCase() === 'true'
  }

  private setUiAccessCookie(response: Response, userUuid: string): void {
    response.cookie(WORKFLOWS_UI_COOKIE_NAME, this.workflowsService.mintUiAccessToken(userUuid), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.workflowsService.cookieSecure,
      // Path-scoped to the proxy so the token never rides on ordinary API calls.
      path: this.workflowsService.uiBasePath,
      maxAge: this.workflowsService.uiTokenTtlSeconds * 1000,
    })
  }

  private clearUiAccessCookie(response: Response): void {
    response.clearCookie(WORKFLOWS_UI_COOKIE_NAME, { path: this.workflowsService.uiBasePath })
  }

  private clientIp(request: Request): string | null {
    return (request.headers['x-forwarded-for'] as string | undefined) ?? request.ip ?? null
  }
}
