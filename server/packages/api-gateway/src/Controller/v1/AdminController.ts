import { Request, Response } from 'express'
import { inject, optional } from 'inversify'
import { BaseHttpController, controller, httpDelete, httpGet, httpPost, httpPut } from 'inversify-express-utils'
import { RoleName } from '@standardnotes/domain-core'
import { Role } from '@standardnotes/security'
import { TYPES } from '../../Bootstrap/Types'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { AssistantProviderConfig, configuredProviders } from '../../Service/Assistant/providers/factory'
import { UpdateCheckService } from '../../Service/Updates/UpdateCheckService'
import { AdminLogsService } from '../../Service/AdminLogs/AdminLogsService'

/**
 * Standard Red Notes: one entry of the server-status `services` array — a
 * per-service readiness summary. `status` degrades per field so the endpoint
 * itself never 5xxs: 'ok' (readiness 200), 'degraded' (readiness 503 / partial),
 * 'down' (unreachable / unexpected), 'unknown' (service URL not configured).
 */
export type ServiceStatusEntry = {
  name: string
  reachable: boolean
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  detail?: string
}

type AuthReadiness = { reachable: boolean; status?: string; checks?: Record<string, boolean> }

/**
 * Standard Red Notes: minimal fetch shape used by the server-status endpoint to
 * probe the auth server's readiness. Injected-free — the controller uses the
 * runtime's global fetch; the type keeps the handler unit-testable.
 */
export type ReadinessFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown> }>

/**
 * Standard Red Notes: gateway routes for the in-app admin panel. These proxy to
 * the auth server's `/admin` controller. They are protected by the required
 * cross-service token middleware so the auth server receives the decoded roles
 * on `response.locals.roles`, where the controller enforces the
 * INTERNAL_TEAM_USER role. The proxied endpoints themselves only expose the
 * per-user feature-flag setters/getters (never the broader unprotected admin
 * routes).
 */
@controller('/v1/admin')
export class AdminController extends BaseHttpController {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) private serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_EndpointResolver) private endpointResolver: EndpointResolverInterface,
    // Standard Red Notes: read-only server-status dependencies (all pre-existing
    // bindings). Optional so tests can construct the controller without them and
    // the endpoint degrades field-by-field when one is absent.
    @inject(TYPES.ApiGateway_OCR_SERVER_ENABLED) @optional() private ocrServerEnabled?: boolean,
    @inject(TYPES.ApiGateway_WORKFLOWS_ENABLED) @optional() private workflowsEnabled?: boolean,
    @inject(TYPES.ApiGateway_UpdateCheckService) @optional() private updateCheckService?: UpdateCheckService,
    @inject(TYPES.ApiGateway_ASSISTANT_PROVIDER_CONFIG)
    @optional()
    private assistantProviderConfig?: AssistantProviderConfig,
    @inject(TYPES.ApiGateway_AUTH_SERVER_URL) @optional() private authServerUrl?: string,
    // Redis is only bound when a Redis cache is configured; its absence is
    // reported as "not configured" (null) rather than unhealthy.
    @inject(TYPES.ApiGateway_Redis) @optional() private redis?: { ping(): Promise<string> },
    // Standard Red Notes: internal URLs of the other backend services, probed by
    // the extended server-status endpoint for their /healthcheck/readiness.
    // Optional so the controller constructs in tests and degrades to 'unknown'
    // (not configured) when a URL is absent.
    @inject(TYPES.ApiGateway_SYNCING_SERVER_JS_URL) @optional() private syncingServerUrl?: string,
    @inject(TYPES.ApiGateway_FILES_SERVER_URL) @optional() private filesServerUrl?: string,
    @inject(TYPES.ApiGateway_REVISIONS_SERVER_URL) @optional() private revisionsServerUrl?: string,
    @inject(TYPES.ApiGateway_WEB_SOCKET_SERVER_URL) @optional() private webSocketServerUrl?: string,
    // Standard Red Notes: server-log tailing for the admin Logs tab. Optional so
    // the endpoint degrades to an empty result when logs are not file-based.
    @inject(TYPES.ApiGateway_AdminLogsService) @optional() private adminLogsService?: AdminLogsService,
  ) {
    super()
  }

  /**
   * Standard Red Notes: same admin gate the auth server enforces, applied at the
   * gateway for the gateway-LOCAL server-status endpoint (which never reaches
   * the auth admin controller). The roles come from the verified cross-service
   * token that the required auth middleware placed on response.locals.
   */
  private requestorIsAdmin(response: Response): boolean {
    const roles = ((response.locals as { roles?: Role[] }).roles ?? []) as Role[]

    return roles.some((role) => role.name === RoleName.NAMES.InternalTeamUser)
  }

  @httpGet('/lookup-user/:email', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async lookupUser(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/lookup-user/:email',
        request.params.email as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:userUuid/feature-flags', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserFeatureFlags(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:userUuid/feature-flags',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpPut('/users/:userUuid/feature-flags', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setUserFeatureFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/users/:userUuid/feature-flags',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:email/ban-status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserBanStatus(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:email/ban-status',
        request.params.email as string,
      ),
      request.body,
    )
  }

  @httpPut('/users/:userUuid/ban-status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setUserBanStatus(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/users/:userUuid/ban-status',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/registration', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getRegistrationFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/registration'),
      request.body,
    )
  }

  @httpPut('/registration', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setRegistrationFlag(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('PUT', 'admin/registration'),
      request.body,
    )
  }

  @httpGet('/audit-log', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getAuditLog(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/audit-log'),
      request.body,
    )
  }

  // Standard Red Notes: paginated + filtered admin user list. Pure pass-through
  // to the auth admin controller (which enforces the admin role); query params
  // (limit/offset/sort/filters) ride along via the proxy's `params: query`.
  @httpGet('/users', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listUsers(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/users'),
      request.body,
    )
  }

  @httpGet('/roles', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getAvailableRoles(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/roles'),
      request.body,
    )
  }

  @httpGet('/groups', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listGroups(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/groups'),
      request.body,
    )
  }

  @httpPost('/groups', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async createGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'admin/groups'),
      request.body,
    )
  }

  @httpDelete('/groups/:groupUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async deleteGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'admin/groups/:groupUuid',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpPut('/groups/:groupUuid/roles', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setGroupRoles(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/groups/:groupUuid/roles',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/groups/:groupUuid/members', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listGroupMembers(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/groups/:groupUuid/members',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpPost('/groups/:groupUuid/members', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async addUserToGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'POST',
        'admin/groups/:groupUuid/members',
        request.params.groupUuid as string,
      ),
      request.body,
    )
  }

  @httpDelete('/groups/:groupUuid/members/:userUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async removeUserFromGroup(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'admin/groups/:groupUuid/members/:userUuid',
        request.params.groupUuid as string,
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpGet('/users/:userUuid/effective-permissions', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getUserEffectivePermissions(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/users/:userUuid/effective-permissions',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpPut('/users/:userUuid/admin-role', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setUserAdminRole(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/users/:userUuid/admin-role',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpDelete('/users/:userUuid/mfa-secret', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async resetUserMFA(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'admin/users/:userUuid/mfa-secret',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  @httpPost('/users/:userUuid/fix-quota', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async fixUserQuota(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'POST',
        'admin/users/:userUuid/fix-quota',
        request.params.userUuid as string,
      ),
      request.body,
    )
  }

  /**
   * Standard Red Notes: gateway-LOCAL read-only server status for the admin
   * panel's Server tab. Admin-gated (403 for non-admins, mirroring the auth
   * admin controller) because it reveals deployment/topology detail. Returns:
   *   - masterSwitches: which env-gated operator features are on at the gateway
   *     (server OCR, workflows, assistant providers, update check). The
   *     auth-held switches (NEXTCLOUD_BACKUPS_ENABLED, DISABLE_USER_REGISTRATION)
   *     ride along on GET /v1/admin/registration instead.
   *   - health: the gateway's own Redis reachability (null = no Redis
   *     configured) plus the auth server's /healthcheck/readiness (DB + Redis),
   *     probed server-side under a short timeout. Every failure degrades to a
   *     field value — this endpoint itself always answers 200 for admins.
   */
  @httpGet('/server-status', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getServerStatus(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    const assistantProviders = this.assistantProviderConfig ? configuredProviders(this.assistantProviderConfig) : []
    // Never throws; unset UPDATE_CHECK_URL reports { configured: false }.
    const updateCheck = this.updateCheckService ? await this.updateCheckService.getStatus(false) : null

    let gatewayRedis: boolean | null = null
    if (this.redis) {
      try {
        await this.withTimeout(this.redis.ping(), 2000)
        gatewayRedis = true
      } catch {
        gatewayRedis = false
      }
    }

    const auth = await this.probeAuthReadiness()

    // Standard Red Notes: per-service readiness for EVERY backend service, probed
    // in parallel over the internal network under a short timeout. Degrades per
    // field (never 5xx).
    const services = await this.probeServices(auth)

    response.json({
      masterSwitches: {
        ocrServerEnabled: this.ocrServerEnabled ?? false,
        workflowsEnabled: this.workflowsEnabled ?? false,
        assistantConfigured: assistantProviders.length > 0,
        assistantProviders,
        updateCheckConfigured: updateCheck?.configured ?? false,
        currentVersion: updateCheck?.currentVersion ?? null,
      },
      health: {
        gateway: { redis: gatewayRedis },
        auth,
      },
      services,
    })
  }

  /**
   * Standard Red Notes: tail recent server logs for the admin panel's Logs tab.
   * Admin-gated HARD (403 for non-admins). Read-only, so no audit entry. Reads
   * the container's supervisord per-service log files through AdminLogsService;
   * when logs are not file-based/available it degrades to an empty result.
   * Query params: limit (default 200, MAX 500), service (filter), level (filter).
   */
  @httpGet('/logs', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getLogs(request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    if (!this.adminLogsService) {
      response.json({ entries: [], truncated: false })

      return
    }

    const query = request.query as Record<string, string | undefined>

    const MAX_LIMIT = 500
    let limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : 200
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 200
    }
    limit = Math.min(limit, MAX_LIMIT)

    const result = await this.adminLogsService.tail({
      limit,
      service: query.service !== undefined && query.service.trim() !== '' ? query.service.trim() : undefined,
      level: query.level !== undefined && query.level.trim() !== '' ? query.level.trim() : undefined,
    })

    response.json(result)
  }

  /**
   * Standard Red Notes: build the server-status `services` array — the gateway
   * itself, the auth server (from the readiness probe already taken), and each
   * of the other backend services probed for /healthcheck/readiness in parallel.
   */
  private async probeServices(auth: AuthReadiness): Promise<ServiceStatusEntry[]> {
    const targets: Array<[string, string | undefined]> = [
      ['syncing-server', this.syncingServerUrl],
      ['files', this.filesServerUrl],
      ['revisions', this.revisionsServerUrl],
      ['websocket-gateway', this.webSocketServerUrl],
    ]

    const probed = await Promise.all(targets.map(([name, url]) => this.probeServiceReadiness(name, url)))

    return [{ name: 'api-gateway', reachable: true, status: 'ok' }, this.authServiceEntry(auth), ...probed]
  }

  /**
   * Map the auth readiness probe (already taken for the `health` block) onto a
   * services-array entry so the array is a complete view of every service.
   */
  private authServiceEntry(auth: AuthReadiness): ServiceStatusEntry {
    if (!auth.reachable) {
      return { name: 'auth', reachable: false, status: 'down', detail: 'unreachable' }
    }

    const checks = auth.checks ?? {}
    const allChecksOk = Object.values(checks).every(Boolean)
    const ready = auth.status === undefined || auth.status === 'ready'

    return { name: 'auth', reachable: true, status: ready && allChecksOk ? 'ok' : 'degraded' }
  }

  /**
   * Probe a single backend service's /healthcheck/readiness under a short (2.5s)
   * timeout. Never throws — every failure mode degrades to a status value.
   */
  private async probeServiceReadiness(
    name: string,
    url: string | undefined,
    fetchFn: ReadinessFetchLike = globalThis.fetch.bind(globalThis) as unknown as ReadinessFetchLike,
  ): Promise<ServiceStatusEntry> {
    if (!url) {
      return { name, reachable: false, status: 'unknown', detail: 'not configured' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const readinessResponse = await fetchFn(`${url}/healthcheck/readiness`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (readinessResponse.status === 200) {
        return { name, reachable: true, status: 'ok' }
      }
      if (readinessResponse.status === 503) {
        return { name, reachable: true, status: 'degraded', detail: 'readiness reported unavailable' }
      }

      return { name, reachable: true, status: 'down', detail: `unexpected status ${readinessResponse.status}` }
    } catch {
      return { name, reachable: false, status: 'down', detail: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Probe the auth server's /healthcheck/readiness (DB `SELECT 1` + Redis PING)
   * server-side. A 503 from the endpoint still carries the per-check states, so
   * both 200 and 503 bodies are surfaced; anything else degrades to
   * { reachable: false }.
   */
  private async probeAuthReadiness(
    fetchFn: ReadinessFetchLike = globalThis.fetch.bind(globalThis) as unknown as ReadinessFetchLike,
  ): Promise<{ reachable: boolean; status?: string; checks?: Record<string, boolean> }> {
    if (!this.authServerUrl) {
      return { reachable: false }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const readinessResponse = await fetchFn(`${this.authServerUrl}/healthcheck/readiness`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (readinessResponse.status !== 200 && readinessResponse.status !== 503) {
        return { reachable: false }
      }
      const body = (await readinessResponse.json()) as { status?: string; checks?: Record<string, boolean> }

      return { reachable: true, status: body.status, checks: body.checks }
    } catch {
      return { reachable: false }
    } finally {
      clearTimeout(timer)
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs)
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
