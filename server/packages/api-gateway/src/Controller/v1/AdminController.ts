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
import { REGISTRATION_ASSIGNABLE_ROLES, ServerSettingsResolver } from '../../Service/ServerSettings/ServerSettingsResolver'
import { ServerSettingsPatch } from '../../Service/ServerSettings/ServerSettingsStore'
import {
  PersistedAiProfile,
  PersistedBackendProfile,
  validateAssignmentsPatch,
  validateBackendProfilesPatch,
  validateProfilesPatch,
} from '../../Service/Assistant/profiles'
import { API_GATEWAY_PROGRAM, ServiceAction, ServiceControlService } from '../../Service/ServiceControl/ServiceControlService'
import { DockerServiceControlService } from '../../Service/ServiceControl/DockerServiceControlService'
import { IpAccessListStore, IpAclList } from '../IpAccessList'
import { RateLimitMetricsStore } from '../RateLimitMetrics'

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
  // Standard Red Notes: how long this service's readiness probe took, in ms.
  // Present whenever a probe actually ran (omitted for the gateway itself, which
  // is not probed, and for 'not configured' services with no URL to probe).
  responseTimeMs?: number
}

type AuthReadiness = { reachable: boolean; status?: string; checks?: Record<string, boolean>; responseTimeMs?: number }

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
 * ADMIN_USER role. The proxied endpoints themselves only expose the
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
    // Standard Red Notes: internal probe base URLs for server-status (name ->
    // http://host:port). Bound in the container with single-container defaults
    // (supervisord sibling ports) + env overrides; when absent (unit tests) the
    // per-service URL fields above act as the fallback.
    @inject(TYPES.ApiGateway_SERVICE_PROBE_URLS) @optional() private serviceProbeUrls?: Record<string, string>,
    // Standard Red Notes: runtime server settings (persisted overlay over env,
    // persisted wins). Optional so the settings routes degrade to 503 when the
    // resolver is not bound (never on a production container).
    @inject(TYPES.ApiGateway_ServerSettingsResolver)
    @optional()
    private serverSettingsResolver?: ServerSettingsResolver,
    // Structured audit line for settings changes (setting NAMES only, never
    // values) — the gateway has no reachable audit-log store of its own.
    @inject(TYPES.ApiGateway_Logger) @optional() private logger?: { info(message: string, meta?: unknown): void },
    // Standard Red Notes: service lifecycle control (restart/stop/start of the
    // supervisord-managed sibling processes). Optional so the routes degrade to a
    // clear 503 when the service is not bound, and so the controller still
    // constructs in unit tests without it.
    @inject(TYPES.ApiGateway_ServiceControlService)
    @optional()
    private serviceControlService?: ServiceControlService,
    // Standard Red Notes: anti-abuse admin surface. Both are Redis-backed and only
    // bound when a Redis cache is configured, so they are @optional — the routes
    // degrade to 503 (mutations) / empty (view) when absent.
    @inject(TYPES.ApiGateway_IpAccessListStore) @optional() private ipAccessListStore?: IpAccessListStore,
    @inject(TYPES.ApiGateway_RateLimitMetricsStore) @optional() private rateLimitMetricsStore?: RateLimitMetricsStore,
    // Standard Red Notes: OPT-IN container restart via the docker-socket-proxy
    // sidecar (Redis cache + MariaDB, which run OUTSIDE supervisord). Optional
    // and OFF BY DEFAULT — when unbound / not enabled the container-restart route
    // degrades to a clear 503 and the /services `docker` block reports
    // enabled:false, so the UI simply hides the controls.
    @inject(TYPES.ApiGateway_DockerServiceControlService)
    @optional()
    private dockerServiceControlService?: DockerServiceControlService,
    // Standard Red Notes: forwarded-client-IP config surfaced READ-ONLY on the admin
    // Server tab (both are boot settings — changing them needs a redeploy). trustProxy
    // is the raw Express `trust proxy` spec; clientIpHeader is the optional trusted
    // client-IP header name (empty = off). Appended LAST so positional construction in
    // tests is unaffected. See ClientIp.ts / docs/DEPLOYMENT.md.
    @inject(TYPES.ApiGateway_TRUST_PROXY) @optional() private trustProxy?: string,
    @inject(TYPES.ApiGateway_CLIENT_IP_HEADER) @optional() private clientIpHeader?: string,
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

    return roles.some((role) => role.name === RoleName.NAMES.AdminUser)
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

  // Standard Red Notes: RBAC role management (read all roles with permissions +
  // edit a role's permission assignments). Proxied to the auth admin controller,
  // which re-gates on the ADMIN_USER role.
  @httpGet('/roles/detailed', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listRolesWithPermissions(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/roles/detailed'),
      request.body,
    )
  }

  @httpPut('/roles/:roleUuid/permissions', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setRolePermissions(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'PUT',
        'admin/roles/:roleUuid/permissions',
        request.params.roleUuid as string,
      ),
      request.body,
    )
  }

  // Standard Red Notes: EXTENSIVE RBAC management — the permission CATALOG
  // browser, effective-permissions SIMULATOR, custom-role create/delete and the
  // role-holders INSPECTOR. All proxied to the auth admin controller, which
  // re-gates on the ADMIN_USER role.
  @httpGet('/permissions', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getPermissionCatalog(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('GET', 'admin/permissions'),
      request.body,
    )
  }

  // NOTE: static '/roles/resolve-permissions' — declared before the ':roleUuid'
  // param routes so it is never shadowed by them.
  @httpPost('/roles/resolve-permissions', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async resolveRoleSetPermissions(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'admin/roles/resolve-permissions'),
      request.body,
    )
  }

  @httpPost('/roles', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async createCustomRole(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'admin/roles'),
      request.body,
    )
  }

  @httpGet('/roles/:roleUuid/holders', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getRoleHolders(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'GET',
        'admin/roles/:roleUuid/holders',
        request.params.roleUuid as string,
      ),
      request.body,
    )
  }

  @httpDelete('/roles/:roleUuid', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async deleteCustomRole(request: Request, response: Response): Promise<void> {
    await this.serviceProxy.callAuthServer(
      request,
      response,
      this.endpointResolver.resolveEndpointOrMethodIdentifier(
        'DELETE',
        'admin/roles/:roleUuid',
        request.params.roleUuid as string,
      ),
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

    // Effective assistant config: persisted admin overrides win over env (see
    // ServerSettingsResolver); the env-bound config is the fallback.
    let assistantConfig = this.assistantProviderConfig
    if (this.serverSettingsResolver) {
      try {
        assistantConfig = await this.serverSettingsResolver.resolveAssistantConfig()
      } catch {
        // A broken settings overlay must not take server-status down.
      }
    }
    const assistantProviders = assistantConfig ? configuredProviders(assistantConfig) : []
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
      // Standard Red Notes: read-only forwarded-client-IP config (boot settings). The
      // admin panel shows these so an operator can confirm how the real client IP is
      // resolved for rate limiting / session security. `trustProxy` empty means the
      // built-in default (loopback/linklocal/uniquelocal); `clientIpHeader` empty
      // means no trusted header is read (request.ip only).
      network: {
        trustProxy: this.trustProxy && this.trustProxy.trim() !== '' ? this.trustProxy.trim() : null,
        clientIpHeader: this.clientIpHeader && this.clientIpHeader !== '' ? this.clientIpHeader : null,
      },
      services,
    })
  }

  /**
   * Standard Red Notes: list the supervisord programs the admin panel may control
   * plus whether service control is actually usable on this server. Admin-gated
   * HARD (403 for non-admins). `available` is false on an older image whose
   * supervisord conf lacks the [supervisorctl] socket sections (supervisorctl
   * cannot reach supervisord) — the UI then hides the lifecycle controls. When
   * the service is not bound at all it also degrades to available:false rather
   * than 404, so the whole feature is a single clean signal for the UI.
   */
  @httpGet('/services', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async listControllableServices(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    // Standard Red Notes: the OPT-IN container-restart (docker-socket-proxy)
    // capability rides along in the same response so the UI learns about it in
    // one call. `enabled` = operator set the flag + proxy URL; `available` =
    // enabled AND the proxy is actually reachable. Both false (with an empty
    // allowlist) when the service is unbound / off — the UI then hides the
    // Redis/DB controls entirely.
    const docker = await this.dockerCapability()

    if (!this.serviceControlService) {
      response.json({ available: false, programs: [], docker })

      return
    }

    const available = await this.serviceControlService.isAvailable()

    response.json({ available, programs: this.serviceControlService.getControllablePrograms(), docker })
  }

  /**
   * Standard Red Notes: resolve the docker-restart capability block for the
   * /services response. OFF BY DEFAULT — reports enabled:false/available:false
   * (empty allowlist) when the service is unbound or the operator has not turned
   * it on. Never throws.
   */
  private async dockerCapability(): Promise<{ enabled: boolean; available: boolean; containers: string[] }> {
    if (!this.dockerServiceControlService || !this.dockerServiceControlService.isEnabled()) {
      return { enabled: false, available: false, containers: [] }
    }

    const available = await this.dockerServiceControlService.isAvailable()

    return { enabled: true, available, containers: this.dockerServiceControlService.getAllowedContainers() }
  }

  /**
   * Standard Red Notes: OPT-IN container restart (Redis cache / MariaDB) through
   * the locked-down docker-socket-proxy. Admin-gated HARD (403 for non-admins),
   * allowlist-gated ({cache, db} only — anything else 400 with no HTTP call),
   * and audit-logged on every attempt. OFF BY DEFAULT: when the capability is not
   * enabled it returns 503 (never actually touching Docker); an unreachable proxy
   * likewise degrades to 503. NEVER a 500.
   */
  @httpPost('/containers/:name/restart', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async restartContainer(request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    const name = String(request.params.name ?? '')
    const adminUuid = ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? null
    const audit = (outcome: string): void => {
      this.logger?.info('admin container-control', {
        audit: 'admin.container-control',
        adminUuid,
        container: name,
        action: 'restart',
        outcome,
      })
    }

    if (!this.dockerServiceControlService || !this.dockerServiceControlService.isEnabled()) {
      audit('disabled')
      response.status(503).json({
        error: {
          message: 'Container control is not enabled on this server. Enable the docker-socket-proxy (ops profile).',
        },
      })

      return
    }

    // Reject non-allowlisted names up front — before any HTTP call to the proxy.
    if (!this.dockerServiceControlService.isAllowed(name)) {
      audit('invalid-container')
      response.status(400).json({ error: { message: `Unknown or non-restartable container: ${name}.` } })

      return
    }

    const outcome = await this.dockerServiceControlService.restart(name)
    audit(outcome.kind)

    switch (outcome.kind) {
      case 'ok':
        response.json({ container: outcome.container, action: 'restart', status: 'restarting' })

        return
      case 'disabled':
        response.status(503).json({ error: { message: 'Container control is not enabled on this server.' } })

        return
      case 'invalid-container':
        response
          .status(400)
          .json({ error: { message: `Unknown or non-restartable container: ${outcome.container}.` } })

        return
      case 'unavailable':
        response.status(503).json({ error: { message: outcome.message } })

        return
      case 'error':
        response.status(502).json({ error: { message: outcome.message } })

        return
    }
  }

  /**
   * Standard Red Notes: restart a supervisord-managed program. For the special
   * api-gateway program (the process serving THIS request) a restart requires
   * `?confirmSelfInterrupt=true`; the response is sent (202) BEFORE the restart
   * is fired, since supervisord terminates this process mid-restart and the
   * admin's connection drops for a few seconds.
   */
  @httpPost('/services/:name/restart', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async restartService(request: Request, response: Response): Promise<void> {
    await this.handleServiceControl(request, response, 'restart')
  }

  /**
   * Standard Red Notes: stop a supervisord-managed program. Stopping the
   * api-gateway is FORBIDDEN (it would take the whole server offline and kill the
   * responder) — that returns 409, never actually stopping the gateway.
   */
  @httpPost('/services/:name/stop', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async stopService(request: Request, response: Response): Promise<void> {
    await this.handleServiceControl(request, response, 'stop')
  }

  /** Standard Red Notes: start a stopped supervisord-managed program. */
  @httpPost('/services/:name/start', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async startService(request: Request, response: Response): Promise<void> {
    await this.handleServiceControl(request, response, 'start')
  }

  /**
   * Shared handler for the three lifecycle actions. Admin-gated, allowlist-gated
   * (invalid names 400 BEFORE any process spawn), audit-logged on every attempt
   * (action + target program + outcome, never any secret), and self-interrupt
   * safe for the api-gateway program. Fails soft: an unavailable supervisorctl
   * degrades to 503, an action failure to 502 — never a 500 crash.
   */
  private async handleServiceControl(request: Request, response: Response, action: ServiceAction): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    if (!this.serviceControlService) {
      response.status(503).json({ error: { message: 'Service control is not available on this server.' } })

      return
    }

    const name = String(request.params.name ?? '')
    const confirmSelfInterrupt =
      String((request.query as Record<string, unknown>).confirmSelfInterrupt ?? '') === 'true'
    const adminUuid = ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? null

    const audit = (outcome: string): void => {
      this.logger?.info('admin service-control', {
        audit: 'admin.service-control',
        adminUuid,
        program: name,
        action,
        outcome,
        confirmSelfInterrupt,
      })
    }

    // Reject non-allowlisted names up front — before the gateway self-restart
    // fast path — so a bogus :name can never trigger a real restart.
    if (!this.serviceControlService.isControllable(name)) {
      audit('invalid-program')
      response.status(400).json({ error: { message: `Unknown or non-controllable service: ${name}.` } })

      return
    }

    // api-gateway self-restart: answer FIRST (202), then fire the restart. We do
    // not await it — supervisord kills this process during the restart, so the
    // promise would never resolve to write a response.
    if (name === API_GATEWAY_PROGRAM && action === 'restart') {
      if (!confirmSelfInterrupt) {
        audit('forbidden:requires-confirmation')
        response.status(409).json({
          error: {
            message:
              'Restarting the API gateway will drop your admin connection for a few seconds. Retry with confirmSelfInterrupt=true to proceed.',
          },
          requiresConfirmation: true,
        })

        return
      }

      audit('accepted:self-interrupt')
      response.status(202).json({
        program: name,
        action,
        selfInterrupt: true,
        status: 'restarting',
        message: 'API gateway restart requested. Your connection will drop briefly while it restarts.',
      })

      void this.serviceControlService.control(name, 'restart', { confirmSelfInterrupt: true })

      return
    }

    const outcome = await this.serviceControlService.control(name, action, { confirmSelfInterrupt })
    audit(outcome.kind)

    switch (outcome.kind) {
      case 'ok':
        response.json({ program: outcome.program, action: outcome.action, status: outcome.status })

        return
      case 'invalid-program':
        response.status(400).json({ error: { message: `Unknown or non-controllable service: ${outcome.program}.` } })

        return
      case 'forbidden':
        response
          .status(409)
          .json({ error: { message: outcome.reason }, requiresConfirmation: outcome.requiresConfirmation ?? false })

        return
      case 'unavailable':
        response.status(503).json({ error: { message: outcome.message } })

        return
      case 'error':
        response.status(502).json({ error: { message: outcome.message } })

        return
    }
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
   * Standard Red Notes: runtime server settings (admin pane). Returns the MASKED
   * view — secrets (API keys) are NEVER returned, only `configured` booleans —
   * plus a per-setting source map ('persisted' | 'env' | 'default').
   * PRECEDENCE: persisted (admin-set) wins over env; env is the fallback.
   * Admin-gated HARD (403 for non-admins), like server-status.
   */
  @httpGet('/server-settings', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getServerSettings(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    if (!this.serverSettingsResolver) {
      response.status(503).json({ error: { message: 'Server settings are not available on this deployment.' } })

      return
    }

    response.json(await this.serverSettingsResolver.view())
  }

  /**
   * Standard Red Notes: update runtime server settings. Accepts a PARTIAL body —
   * only the provided keys change. Per key: a concrete value persists an
   * admin override (which WINS over env), an explicit `null` CLEARS the
   * persisted override (falling back to env), and an absent key is untouched.
   * Values are validated (URLs must parse as http/https, the daily limit must
   * be an integer >= 0, keys must be non-empty strings). Changes take effect on
   * next use — consumers read through the ServerSettingsResolver per request.
   * The change is audit-logged as a structured log line carrying setting NAMES
   * only, never values (the gateway has no audit-log store of its own; the
   * auth-side audit log is not reachable from this gateway-local endpoint).
   */
  @httpPut('/server-settings', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async setServerSettings(request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    if (!this.serverSettingsResolver) {
      response.status(503).json({ error: { message: 'Server settings are not available on this deployment.' } })

      return
    }

    // Read the raw persisted profiles first so the validator can preserve a
    // profile's (and a backend profile's) write-only key when the UI resubmits
    // it without the secret.
    let existingProfiles: PersistedAiProfile[] | undefined
    let existingBackendProfiles: PersistedBackendProfile[] | undefined
    try {
      existingProfiles = await this.serverSettingsResolver.getPersistedAiProfiles()
    } catch {
      existingProfiles = undefined
    }
    try {
      existingBackendProfiles = await this.serverSettingsResolver.getPersistedBackendProfiles()
    } catch {
      existingBackendProfiles = undefined
    }

    const parsed = this.parseServerSettingsBody(request.body, existingProfiles, existingBackendProfiles)
    if ('error' in parsed) {
      response.status(400).json({ error: { message: parsed.error } })

      return
    }
    if (parsed.changedSettings.length === 0) {
      response.status(400).json({ error: { message: 'No recognized settings provided.' } })

      return
    }

    await this.serverSettingsResolver.applyPatch(parsed.patch)

    // Audit: setting NAMES only — never values, never key material.
    const adminUuid = ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? null
    this.logger?.info('admin server-settings updated', {
      audit: 'admin.server-settings.update',
      adminUuid,
      changedSettings: parsed.changedSettings,
    })

    response.json(await this.serverSettingsResolver.view())
  }

  /**
   * Validates a PUT /server-settings body into a store patch. Returns the patch
   * plus the dot-path names of every setting it changes (for the audit line),
   * or a human-readable validation error. `null` means CLEAR, a value means
   * SET, an absent key means leave untouched.
   */
  private parseServerSettingsBody(
    body: unknown,
    existingProfiles?: PersistedAiProfile[],
    existingBackendProfiles?: PersistedBackendProfile[],
  ): { patch: ServerSettingsPatch; changedSettings: string[] } | { error: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: 'Request body must be a JSON object.' }
    }
    const root = body as Record<string, unknown>
    const patch: ServerSettingsPatch = {}
    const changedSettings: string[] = []

    const secret = (value: unknown, name: string): string | null | { error: string } => {
      if (value === null) {
        return null
      }
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim()
      }

      return { error: `${name} must be a non-empty string, or null to clear it.` }
    }
    const url = (value: unknown, name: string): string | null | { error: string } => {
      if (value === null) {
        return null
      }
      if (typeof value === 'string' && value.trim() !== '') {
        try {
          const parsedUrl = new URL(value.trim())
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return { error: `${name} must be an http(s) URL.` }
          }

          return value.trim()
        } catch {
          return { error: `${name} must be a valid URL.` }
        }
      }

      return { error: `${name} must be a URL string, or null to clear it.` }
    }

    if (root.ai !== undefined) {
      if (!root.ai || typeof root.ai !== 'object' || Array.isArray(root.ai)) {
        return { error: 'ai must be an object.' }
      }
      const ai = root.ai as Record<string, unknown>
      patch.ai = {}

      for (const key of ['anthropicApiKey', 'openaiApiKey'] as const) {
        if (ai[key] !== undefined) {
          const value = secret(ai[key], `ai.${key}`)
          if (value !== null && typeof value === 'object') {
            return value
          }
          patch.ai[key] = value
          changedSettings.push(`ai.${key}`)
        }
      }
      for (const key of ['openaiBaseUrl', 'ollamaUrl'] as const) {
        if (ai[key] !== undefined) {
          const value = url(ai[key], `ai.${key}`)
          if (value !== null && typeof value === 'object') {
            return value
          }
          patch.ai[key] = value
          changedSettings.push(`ai.${key}`)
        }
      }
      if (ai.dailyRequestLimit !== undefined) {
        if (ai.dailyRequestLimit === null) {
          patch.ai.dailyRequestLimit = null
        } else if (typeof ai.dailyRequestLimit === 'number' && Number.isInteger(ai.dailyRequestLimit) && ai.dailyRequestLimit >= 0) {
          patch.ai.dailyRequestLimit = ai.dailyRequestLimit
        } else {
          return { error: 'ai.dailyRequestLimit must be an integer >= 0, or null to clear it.' }
        }
        changedSettings.push('ai.dailyRequestLimit')
      }

      // Standard Red Notes: per-user rolling-window TOKEN limits. Same shape as
      // dailyRequestLimit: integer >= 0 (0 = unlimited), or null to clear.
      for (const key of ['fiveHourTokenLimit', 'weeklyTokenLimit'] as const) {
        if (ai[key] !== undefined) {
          if (ai[key] === null) {
            patch.ai[key] = null
          } else if (typeof ai[key] === 'number' && Number.isInteger(ai[key]) && (ai[key] as number) >= 0) {
            patch.ai[key] = ai[key] as number
          } else {
            return { error: `ai.${key} must be an integer >= 0, or null to clear it.` }
          }
          changedSettings.push(`ai.${key}`)
        }
      }

      // Standard Red Notes: MULTIPLE named profiles + a default selector. The
      // heavy validation (provider kinds, URLs, write-only key preservation)
      // lives in the Assistant subsystem's validateProfilesPatch.
      if (ai.profiles !== undefined || ai.defaultProfileId !== undefined) {
        const validated = validateProfilesPatch(ai.profiles, ai.defaultProfileId, existingProfiles)
        if ('error' in validated) {
          return { error: validated.error }
        }
        if (validated.profiles !== undefined) {
          patch.ai.profiles = validated.profiles
          changedSettings.push('ai.profiles')
        }
        if (validated.defaultProfileId !== undefined) {
          patch.ai.defaultProfileId = validated.defaultProfileId
          changedSettings.push('ai.defaultProfileId')
        }
      }

      // Standard Red Notes: DECOUPLED backend (provider/connection) profiles.
      // Same write-only key preservation as assistant profiles (by backend id).
      if (ai.backendProfiles !== undefined) {
        const validated = validateBackendProfilesPatch(ai.backendProfiles, existingBackendProfiles)
        if ('error' in validated) {
          return { error: validated.error }
        }
        if (validated.backendProfiles !== undefined) {
          patch.ai.backendProfiles = validated.backendProfiles
          changedSettings.push('ai.backendProfiles')
        }
      }

      // Standard Red Notes: assistant-profile assignments (user/role -> profile).
      if (ai.assignments !== undefined) {
        const validated = validateAssignmentsPatch(ai.assignments)
        if ('error' in validated) {
          return { error: validated.error }
        }
        if (validated.assignments !== undefined) {
          patch.ai.assignments = validated.assignments
          changedSettings.push('ai.assignments')
        }
      }
    }

    if (root.updateCheck !== undefined) {
      if (!root.updateCheck || typeof root.updateCheck !== 'object' || Array.isArray(root.updateCheck)) {
        return { error: 'updateCheck must be an object.' }
      }
      const updateCheck = root.updateCheck as Record<string, unknown>
      if (updateCheck.url !== undefined) {
        const value = url(updateCheck.url, 'updateCheck.url')
        if (value !== null && typeof value === 'object') {
          return value
        }
        patch.updateCheck = { url: value }
        changedSettings.push('updateCheck.url')
      }
    }

    if (root.nextcloudBackups !== undefined) {
      if (!root.nextcloudBackups || typeof root.nextcloudBackups !== 'object' || Array.isArray(root.nextcloudBackups)) {
        return { error: 'nextcloudBackups must be an object.' }
      }
      const nextcloudBackups = root.nextcloudBackups as Record<string, unknown>
      if (nextcloudBackups.enabled !== undefined) {
        if (nextcloudBackups.enabled !== null && typeof nextcloudBackups.enabled !== 'boolean') {
          return { error: 'nextcloudBackups.enabled must be a boolean, or null to clear it.' }
        }
        patch.nextcloudBackups = { enabled: nextcloudBackups.enabled }
        changedSettings.push('nextcloudBackups.enabled')
      }
    }

    // Standard Red Notes: PROOF-OF-WORK anti-bot knobs. The gateway only
    // PERSISTS these (admin pane); the AUTH server reads the same overlay file
    // and does the actual gating. Booleans (or null to clear); difficulties are
    // integers 0..32; the adaptive threshold is an integer 0..100; signInMode is
    // 'always' | 'adaptive' (or null to clear).
    if (root.security !== undefined) {
      if (!root.security || typeof root.security !== 'object' || Array.isArray(root.security)) {
        return { error: 'security must be an object.' }
      }
      const security = root.security as Record<string, unknown>
      if (security.proofOfWork !== undefined) {
        if (!security.proofOfWork || typeof security.proofOfWork !== 'object' || Array.isArray(security.proofOfWork)) {
          return { error: 'security.proofOfWork must be an object.' }
        }
        const pow = security.proofOfWork as Record<string, unknown>
        patch.security = { proofOfWork: {} }
        const powPatch = patch.security.proofOfWork as Record<string, unknown>

        for (const key of ['registerEnabled', 'signInEnabled'] as const) {
          if (pow[key] !== undefined) {
            if (pow[key] !== null && typeof pow[key] !== 'boolean') {
              return { error: `security.proofOfWork.${key} must be a boolean, or null to clear it.` }
            }
            powPatch[key] = pow[key]
            changedSettings.push(`security.proofOfWork.${key}`)
          }
        }

        const boundedInt = (
          key: 'registerDifficulty' | 'signInDifficulty' | 'signInAdaptiveThreshold',
          max: number,
        ): { error: string } | undefined => {
          if (pow[key] === undefined) {
            return undefined
          }
          if (pow[key] === null) {
            powPatch[key] = null
          } else if (typeof pow[key] === 'number' && Number.isInteger(pow[key]) && (pow[key] as number) >= 0 && (pow[key] as number) <= max) {
            powPatch[key] = pow[key] as number
          } else {
            return { error: `security.proofOfWork.${key} must be an integer between 0 and ${max}, or null to clear it.` }
          }
          changedSettings.push(`security.proofOfWork.${key}`)

          return undefined
        }

        for (const [key, max] of [
          ['registerDifficulty', 32],
          ['signInDifficulty', 32],
          ['signInAdaptiveThreshold', 100],
        ] as const) {
          const invalid = boundedInt(key, max)
          if (invalid) {
            return invalid
          }
        }

        if (pow.signInMode !== undefined) {
          if (pow.signInMode !== null && pow.signInMode !== 'always' && pow.signInMode !== 'adaptive') {
            return { error: "security.proofOfWork.signInMode must be 'always' or 'adaptive', or null to clear it." }
          }
          powPatch.signInMode = pow.signInMode
          changedSettings.push('security.proofOfWork.signInMode')
        }
      }

      // Standard Red Notes: RATE-LIMIT tier knobs. Enforced by the gateway itself
      // (RateLimitMiddleware reads the resolved config per request). enabled /
      // adaptiveEscalation are booleans; window/max knobs are bounded integers so
      // a bad value can never silently disable protection. `null` clears any.
      if (security.rateLimit !== undefined) {
        if (!security.rateLimit || typeof security.rateLimit !== 'object' || Array.isArray(security.rateLimit)) {
          return { error: 'security.rateLimit must be an object.' }
        }
        const rl = security.rateLimit as Record<string, unknown>
        patch.security = patch.security ?? {}
        patch.security.rateLimit = {}
        const rlPatch = patch.security.rateLimit as Record<string, unknown>

        for (const key of ['enabled', 'adaptiveEscalation'] as const) {
          if (rl[key] !== undefined) {
            if (rl[key] !== null && typeof rl[key] !== 'boolean') {
              return { error: `security.rateLimit.${key} must be a boolean, or null to clear it.` }
            }
            rlPatch[key] = rl[key]
            changedSettings.push(`security.rateLimit.${key}`)
          }
        }

        const rlBoundedInt = (
          key: 'windowSeconds' | 'loginMax' | 'registrationMax' | 'userWindowSeconds' | 'userMax',
          min: number,
          max: number,
        ): { error: string } | undefined => {
          if (rl[key] === undefined) {
            return undefined
          }
          if (rl[key] === null) {
            rlPatch[key] = null
          } else if (
            typeof rl[key] === 'number' &&
            Number.isInteger(rl[key]) &&
            (rl[key] as number) >= min &&
            (rl[key] as number) <= max
          ) {
            rlPatch[key] = rl[key] as number
          } else {
            return { error: `security.rateLimit.${key} must be an integer between ${min} and ${max}, or null to clear it.` }
          }
          changedSettings.push(`security.rateLimit.${key}`)

          return undefined
        }

        for (const [key, min, max] of [
          ['windowSeconds', 1, 3600],
          ['loginMax', 0, 100000],
          ['registrationMax', 0, 100000],
          ['userWindowSeconds', 1, 3600],
          ['userMax', 0, 100000],
        ] as const) {
          const invalid = rlBoundedInt(key, min, max)
          if (invalid) {
            return invalid
          }
        }
      }
    }

    // Standard Red Notes: REGISTRATION policy (default role + email-domain policy).
    // The gateway only PERSISTS these; the AUTH server reads the same overlay file
    // and ENFORCES them in Register. defaultRole must be an assignable (canonical
    // non-admin) role; domainMode is off|allowlist|blocklist; domainList is an
    // array of non-empty domain strings. `null` clears any of them.
    if (root.registration !== undefined) {
      if (!root.registration || typeof root.registration !== 'object' || Array.isArray(root.registration)) {
        return { error: 'registration must be an object.' }
      }
      const registration = root.registration as Record<string, unknown>
      patch.registration = {}

      if (registration.defaultRole !== undefined) {
        if (registration.defaultRole === null) {
          patch.registration.defaultRole = null
        } else if (
          typeof registration.defaultRole === 'string' &&
          REGISTRATION_ASSIGNABLE_ROLES.includes(registration.defaultRole)
        ) {
          patch.registration.defaultRole = registration.defaultRole
        } else {
          return {
            error: `registration.defaultRole must be one of ${REGISTRATION_ASSIGNABLE_ROLES.join(', ')}, or null to clear it.`,
          }
        }
        changedSettings.push('registration.defaultRole')
      }

      if (registration.domainMode !== undefined) {
        if (
          registration.domainMode !== null &&
          registration.domainMode !== 'off' &&
          registration.domainMode !== 'allowlist' &&
          registration.domainMode !== 'blocklist'
        ) {
          return { error: "registration.domainMode must be 'off', 'allowlist' or 'blocklist', or null to clear it." }
        }
        patch.registration.domainMode = registration.domainMode as 'off' | 'allowlist' | 'blocklist' | null
        changedSettings.push('registration.domainMode')
      }

      if (registration.domainList !== undefined) {
        if (registration.domainList === null) {
          patch.registration.domainList = null
        } else if (
          Array.isArray(registration.domainList) &&
          registration.domainList.every((entry) => typeof entry === 'string')
        ) {
          const cleaned = (registration.domainList as string[])
            .map((entry) => entry.trim().toLowerCase().replace(/^[@.]+/, ''))
            .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index)
          patch.registration.domainList = cleaned
        } else {
          return { error: 'registration.domainList must be an array of domain strings, or null to clear it.' }
        }
        changedSettings.push('registration.domainList')
      }

      // Standard Red Notes: EMAIL CONFIRMATION (part 2). Enforced auth-side; the
      // gateway only persists these. Enabled is a boolean; gating is
      // block_signin|warn; subject/body/baseUrl are strings (base URL must be an
      // absolute http(s) URL when non-empty). `null` clears any of them.
      if (registration.emailConfirmationEnabled !== undefined) {
        if (
          registration.emailConfirmationEnabled !== null &&
          typeof registration.emailConfirmationEnabled !== 'boolean'
        ) {
          return { error: 'registration.emailConfirmationEnabled must be a boolean, or null to clear it.' }
        }
        patch.registration.emailConfirmationEnabled = registration.emailConfirmationEnabled as boolean | null
        changedSettings.push('registration.emailConfirmationEnabled')
      }

      if (registration.emailConfirmationGating !== undefined) {
        if (
          registration.emailConfirmationGating !== null &&
          registration.emailConfirmationGating !== 'block_signin' &&
          registration.emailConfirmationGating !== 'warn'
        ) {
          return { error: "registration.emailConfirmationGating must be 'block_signin' or 'warn', or null to clear it." }
        }
        patch.registration.emailConfirmationGating = registration.emailConfirmationGating as
          | 'block_signin'
          | 'warn'
          | null
        changedSettings.push('registration.emailConfirmationGating')
      }

      for (const key of ['emailConfirmationSubject', 'emailConfirmationBody'] as const) {
        if (registration[key] !== undefined) {
          const value = registration[key]
          const maxLength = key === 'emailConfirmationSubject' ? 1000 : 20000
          if (value !== null && (typeof value !== 'string' || value.length > maxLength)) {
            return { error: `registration.${key} must be a string of at most ${maxLength} characters, or null to clear it.` }
          }
          patch.registration[key] = value as string | null
          changedSettings.push(`registration.${key}`)
        }
      }

      if (registration.emailConfirmationBaseUrl !== undefined) {
        const value = registration.emailConfirmationBaseUrl
        if (value === null) {
          patch.registration.emailConfirmationBaseUrl = null
        } else if (typeof value === 'string' && (value.trim() === '' || /^https?:\/\/.+/i.test(value.trim()))) {
          patch.registration.emailConfirmationBaseUrl = value.trim()
        } else {
          return {
            error: 'registration.emailConfirmationBaseUrl must be an absolute http(s) URL, empty, or null to clear it.',
          }
        }
        changedSettings.push('registration.emailConfirmationBaseUrl')
      }
    }

    // Standard Red Notes: OCR knobs. serverEnabled/clientEnabled are booleans;
    // the languages are tesseract codes ([a-zA-Z] groups joined by _ or +);
    // maxPages/maxImageBytes are bounded integers. Enforced gateway-side (server
    // OCR) or surfaced via /v1/ocr/config (browser OCR). `null` clears any.
    if (root.ocr !== undefined) {
      if (!root.ocr || typeof root.ocr !== 'object' || Array.isArray(root.ocr)) {
        return { error: 'ocr must be an object.' }
      }
      const ocr = root.ocr as Record<string, unknown>
      patch.ocr = {}
      const ocrPatch = patch.ocr as Record<string, unknown>

      for (const key of ['serverEnabled', 'clientEnabled'] as const) {
        if (ocr[key] !== undefined) {
          if (ocr[key] !== null && typeof ocr[key] !== 'boolean') {
            return { error: `ocr.${key} must be a boolean, or null to clear it.` }
          }
          ocrPatch[key] = ocr[key]
          changedSettings.push(`ocr.${key}`)
        }
      }

      for (const key of ['defaultLanguage', 'clientDefaultLanguage'] as const) {
        if (ocr[key] !== undefined) {
          if (ocr[key] === null) {
            ocrPatch[key] = null
          } else if (
            typeof ocr[key] === 'string' &&
            /^[a-zA-Z]{2,}([_+][a-zA-Z]{2,})*$/.test((ocr[key] as string).trim())
          ) {
            ocrPatch[key] = (ocr[key] as string).trim()
          } else {
            return { error: `ocr.${key} must be a tesseract language code (e.g. "eng" or "eng+deu"), or null to clear it.` }
          }
          changedSettings.push(`ocr.${key}`)
        }
      }

      for (const [key, min, max] of [
        ['maxPages', 1, 1000],
        ['maxImageBytes', 1024, 200 * 1024 * 1024],
      ] as const) {
        if (ocr[key] !== undefined) {
          if (ocr[key] === null) {
            ocrPatch[key] = null
          } else if (
            typeof ocr[key] === 'number' &&
            Number.isInteger(ocr[key]) &&
            (ocr[key] as number) >= min &&
            (ocr[key] as number) <= max
          ) {
            ocrPatch[key] = ocr[key] as number
          } else {
            return { error: `ocr.${key} must be an integer between ${min} and ${max}, or null to clear it.` }
          }
          changedSettings.push(`ocr.${key}`)
        }
      }
    }

    // Standard Red Notes: WORKFLOWS (n8n) knobs. enabled is a boolean; n8nUrl is
    // an http(s) URL; uiBasePath is an absolute path (restart-bound Express mount);
    // uiTokenTtlSeconds is a bounded integer. `null` clears any.
    if (root.workflows !== undefined) {
      if (!root.workflows || typeof root.workflows !== 'object' || Array.isArray(root.workflows)) {
        return { error: 'workflows must be an object.' }
      }
      const workflows = root.workflows as Record<string, unknown>
      patch.workflows = {}
      const wfPatch = patch.workflows as Record<string, unknown>

      if (workflows.enabled !== undefined) {
        if (workflows.enabled !== null && typeof workflows.enabled !== 'boolean') {
          return { error: 'workflows.enabled must be a boolean, or null to clear it.' }
        }
        wfPatch.enabled = workflows.enabled
        changedSettings.push('workflows.enabled')
      }

      if (workflows.n8nUrl !== undefined) {
        const value = url(workflows.n8nUrl, 'workflows.n8nUrl')
        if (value !== null && typeof value === 'object') {
          return value
        }
        wfPatch.n8nUrl = value
        changedSettings.push('workflows.n8nUrl')
      }

      if (workflows.uiBasePath !== undefined) {
        if (workflows.uiBasePath === null) {
          wfPatch.uiBasePath = null
        } else if (
          typeof workflows.uiBasePath === 'string' &&
          /^\/[A-Za-z0-9/_-]*$/.test(workflows.uiBasePath.trim())
        ) {
          wfPatch.uiBasePath = workflows.uiBasePath.trim()
        } else {
          return { error: 'workflows.uiBasePath must be an absolute path (e.g. "/workflows-ui"), or null to clear it.' }
        }
        changedSettings.push('workflows.uiBasePath')
      }

      if (workflows.uiTokenTtlSeconds !== undefined) {
        if (workflows.uiTokenTtlSeconds === null) {
          wfPatch.uiTokenTtlSeconds = null
        } else if (
          typeof workflows.uiTokenTtlSeconds === 'number' &&
          Number.isInteger(workflows.uiTokenTtlSeconds) &&
          workflows.uiTokenTtlSeconds >= 60 &&
          workflows.uiTokenTtlSeconds <= 7 * 24 * 60 * 60
        ) {
          wfPatch.uiTokenTtlSeconds = workflows.uiTokenTtlSeconds
        } else {
          return { error: 'workflows.uiTokenTtlSeconds must be an integer between 60 and 604800, or null to clear it.' }
        }
        changedSettings.push('workflows.uiTokenTtlSeconds')
      }
    }

    // Standard Red Notes: PLUGINS gallery repo base URL. An http(s) URL (the base
    // directory — the index is fetched at `<repoUrl>/packages.json`), or null to
    // clear (fall back to PLUGINS_REPO_URL env, then the Standard Notes default).
    if (root.plugins !== undefined) {
      if (!root.plugins || typeof root.plugins !== 'object' || Array.isArray(root.plugins)) {
        return { error: 'plugins must be an object.' }
      }
      const plugins = root.plugins as Record<string, unknown>
      if (plugins.repoUrl !== undefined) {
        const value = url(plugins.repoUrl, 'plugins.repoUrl')
        if (value !== null && typeof value === 'object') {
          return value
        }
        patch.plugins = { repoUrl: value }
        changedSettings.push('plugins.repoUrl')
      }
    }

    return { patch, changedSettings }
  }

  /**
   * Standard Red Notes: anti-abuse LIVE view for the admin Security tab. Returns
   * the effective (resolved) rate-limit tier config, the admin-managed IP
   * allow/block lists, and best-effort throttle telemetry (per-tier hit counts,
   * total IP-block hits, a recent-events ring). Admin-gated HARD (403 for
   * non-admins). Read-only, so no audit entry. Degrades field-by-field when the
   * Redis-backed stores are absent (in-memory cache deployment) — never 5xx.
   */
  @httpGet('/anti-abuse', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async getAntiAbuse(_request: Request, response: Response): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }

    let config = null
    if (this.serverSettingsResolver) {
      try {
        config = await this.serverSettingsResolver.resolveRateLimitConfig()
      } catch {
        // a broken overlay must not take the view down.
      }
    }

    let allow: string[] = []
    let block: string[] = []
    if (this.ipAccessListStore) {
      try {
        ;[allow, block] = await Promise.all([
          this.ipAccessListStore.list('allow'),
          this.ipAccessListStore.list('block'),
        ])
      } catch {
        // degrade to empty lists on a Redis error.
      }
    }

    const metrics = this.rateLimitMetricsStore
      ? await this.rateLimitMetricsStore.view()
      : { tierHits: {}, blockHits: 0, recent: [] }

    response.json({
      available: this.ipAccessListStore !== undefined,
      config,
      ipLists: { allow, block },
      metrics,
    })
  }

  @httpPost('/anti-abuse/ip-block', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async blockIp(request: Request, response: Response): Promise<void> {
    await this.mutateIpList(request, response, 'block', 'add')
  }

  @httpPost('/anti-abuse/ip-unblock', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async unblockIp(request: Request, response: Response): Promise<void> {
    await this.mutateIpList(request, response, 'block', 'remove')
  }

  @httpPost('/anti-abuse/ip-allow', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async allowIp(request: Request, response: Response): Promise<void> {
    await this.mutateIpList(request, response, 'allow', 'add')
  }

  @httpPost('/anti-abuse/ip-unallow', TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
  async unallowIp(request: Request, response: Response): Promise<void> {
    await this.mutateIpList(request, response, 'allow', 'remove')
  }

  /**
   * Shared handler for the four IP-list mutations. Admin-gated, validated (the
   * entry must be a valid IPv4 / IPv4-CIDR / IPv6 — nothing else is ever stored,
   * so there is no injection surface), and audit-logged on every attempt (list +
   * action + the canonical entry + outcome). Uses the request BODY for the entry
   * (not the path) so CIDR slashes and IPv6 colons are carried safely.
   */
  private async mutateIpList(
    request: Request,
    response: Response,
    list: IpAclList,
    action: 'add' | 'remove',
  ): Promise<void> {
    if (!this.requestorIsAdmin(response)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })

      return
    }
    if (!this.ipAccessListStore) {
      response.status(503).json({ error: { message: 'IP access lists are not available on this deployment.' } })

      return
    }

    const body = (request.body ?? {}) as Record<string, unknown>
    const entry = body.entry
    if (typeof entry !== 'string' || entry.trim() === '') {
      response.status(400).json({ error: { message: 'entry must be a non-empty IP or CIDR string.' } })

      return
    }

    const result =
      action === 'add' ? await this.ipAccessListStore.add(list, entry) : await this.ipAccessListStore.remove(list, entry)
    if (!result.ok) {
      response.status(400).json({ error: { message: result.error } })

      return
    }

    const adminUuid = ((response.locals as { user?: { uuid?: string } }).user ?? {}).uuid ?? null
    this.logger?.info('admin anti-abuse ip-list update', {
      audit: 'admin.anti-abuse.ip-list',
      adminUuid,
      list,
      action,
      entry: result.value,
    })

    const [allow, block] = await Promise.all([
      this.ipAccessListStore.list('allow'),
      this.ipAccessListStore.list('block'),
    ])
    response.json({ list, action, entry: result.value, ipLists: { allow, block } })
  }

  /**
   * Standard Red Notes: build the server-status `services` array — the gateway
   * itself, the auth server (from the readiness probe already taken), and each
   * of the other backend services probed for /healthcheck/readiness in parallel.
   */
  private async probeServices(auth: AuthReadiness): Promise<ServiceStatusEntry[]> {
    // Probe bases come from the SERVICE_PROBE_URLS map (single-container
    // defaults to the supervisord sibling ports; env-overridable), falling back
    // to the raw service-URL fields when the map is not bound (unit tests).
    // NOTE: files deliberately has NO filesServerUrl fallback beyond the map —
    // FILES_SERVER_URL is the PUBLIC files URL in this fork's entrypoint and is
    // not reachable from inside the container.
    const targets: Array<[string, string | undefined]> = [
      ['syncing-server', this.serviceProbeUrls?.['syncing-server'] ?? this.syncingServerUrl],
      ['files', this.serviceProbeUrls?.['files'] ?? this.filesServerUrl],
      ['revisions', this.serviceProbeUrls?.['revisions'] ?? this.revisionsServerUrl],
      // No websocket gateway runs in the single-container image, so it keeps
      // reporting 'unknown' (not configured) unless WEB_SOCKET_SERVER_URL is set.
      ['websocket-gateway', this.serviceProbeUrls?.['websocket-gateway'] ?? this.webSocketServerUrl],
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
      return { name: 'auth', reachable: false, status: 'down', detail: 'unreachable', responseTimeMs: auth.responseTimeMs }
    }

    const checks = auth.checks ?? {}
    const allChecksOk = Object.values(checks).every(Boolean)
    const ready = auth.status === undefined || auth.status === 'ready'

    return {
      name: 'auth',
      reachable: true,
      status: ready && allChecksOk ? 'ok' : 'degraded',
      responseTimeMs: auth.responseTimeMs,
    }
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

    // Standard Red Notes (task #66): time the readiness probe. The probe already
    // runs; we just measure the wall-clock ms around it and surface it so the UI
    // can warn on a slow/failing service. Cheap — no extra I/O.
    const started = Date.now()
    const elapsed = (): number => Date.now() - started
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const readinessResponse = await fetchFn(`${url}/healthcheck/readiness`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (readinessResponse.status === 200) {
        return { name, reachable: true, status: 'ok', responseTimeMs: elapsed() }
      }
      if (readinessResponse.status === 503) {
        return {
          name,
          reachable: true,
          status: 'degraded',
          detail: 'readiness reported unavailable',
          responseTimeMs: elapsed(),
        }
      }
      if (readinessResponse.status === 404) {
        // Standard Red Notes: builds whose service predates the readiness route
        // 404 here while being perfectly healthy. Fall back to the plain
        // /healthcheck liveness probe and report honestly that only liveness
        // was verified, instead of a false 'down'.
        const livenessResponse = await fetchFn(`${url}/healthcheck`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (livenessResponse.status === 200) {
          return { name, reachable: true, status: 'ok', detail: 'liveness only', responseTimeMs: elapsed() }
        }

        return {
          name,
          reachable: true,
          status: 'down',
          detail: `unexpected status ${livenessResponse.status}`,
          responseTimeMs: elapsed(),
        }
      }

      return {
        name,
        reachable: true,
        status: 'down',
        detail: `unexpected status ${readinessResponse.status}`,
        responseTimeMs: elapsed(),
      }
    } catch {
      return { name, reachable: false, status: 'down', detail: 'unreachable', responseTimeMs: elapsed() }
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
  ): Promise<AuthReadiness> {
    // Same probe-base resolution as the services array: probe map (defaults to
    // the supervisord sibling port) first, raw AUTH_SERVER_URL as fallback.
    const authProbeUrl = this.serviceProbeUrls?.['auth'] ?? this.authServerUrl
    if (!authProbeUrl) {
      return { reachable: false }
    }

    // Standard Red Notes (task #66): time the auth readiness probe too.
    const started = Date.now()
    const elapsed = (): number => Date.now() - started
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const readinessResponse = await fetchFn(`${authProbeUrl}/healthcheck/readiness`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (readinessResponse.status !== 200 && readinessResponse.status !== 503) {
        return { reachable: false, responseTimeMs: elapsed() }
      }
      const body = (await readinessResponse.json()) as { status?: string; checks?: Record<string, boolean> }

      return { reachable: true, status: body.status, checks: body.checks, responseTimeMs: elapsed() }
    } catch {
      return { reachable: false, responseTimeMs: elapsed() }
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
