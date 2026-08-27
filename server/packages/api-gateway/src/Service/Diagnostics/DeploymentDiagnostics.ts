/**
 * Standard Red Notes: what SHAPE of deployment is this, and which configuration
 * items are present — for the admin Diagnostics panel.
 *
 * WHY THIS EXISTS, beyond the boot gate we already report.
 *
 * The gate says WHICH precondition is unmet. It cannot say what to DO about it,
 * because the correct action depends on the topology, and the same code has
 * different — sometimes opposite — answers:
 *
 *   - `SYNCING_SERVER_GRPC_UNBOUND` is fixed by setting `SYNCING_SERVER_GRPC_URL`
 *     ONLY when the gRPC branch of the container is reachable at all. In
 *     `MODE=home-server` the durable backend is called in-process
 *     (`DirectCallServiceProxy`, Container.ts:1038-1046) and no gRPC proxy is
 *     ever constructed, so that variable is never read. In every other mode the
 *     branch is gated on `SERVICE_PROXY_TYPE === 'grpc'` (Container.ts:1048), so
 *     the URL alone still does nothing.
 *   - `REDIS_UNBOUND` names `REDIS_URL`, but this container binds Redis only when
 *     `CACHE_TYPE !== 'memory'` (Container.ts:166) — and `home-server` FORCES
 *     `CACHE_TYPE: 'memory'` through its environment overrides. On that path the
 *     gate reads `REDIS_HOST` instead, from a different boot file.
 *
 * Telling an operator to set a variable that will never be read is worse than
 * saying nothing: it burns a restart and moves the suspicion to the wrong place.
 * So the panel needs the topology, and it needs to know which variables are
 * PRESENT, in order to say "this one is already set and is being ignored".
 *
 * *** SECURITY BOUNDARY — same contract as SyncGateDiagnostics ***
 * Presence, never value. Enforced structurally rather than by convention:
 *   - `presence` is built by `Boolean(read(key)?.trim())`. There is no code path
 *     that puts a read value into the report.
 *   - every other field is a closed union; a value that is not in the union's
 *     allow-list collapses to `'other'`, so an unexpected setting can never
 *     smuggle itself out as free text.
 *   - `DIAGNOSTIC_ENV_KEYS` is a list of VARIABLE NAMES, which are public
 *     (they are documented, and they are in the compose files).
 * Do not add a `string` field to this module. Add a literal-union field instead.
 */

/**
 * `MODE`, as read by `ContainerConfigLoader`. `unset` is the ordinary
 * multi-container deployment; `other` means a value we do not recognise, which
 * behaves like `unset` in the container but should not be reported as if it were
 * deliberate.
 */
export type DeploymentMode = 'home-server' | 'self-hosted' | 'unset' | 'other'

/** `SERVICE_PROXY_TYPE`. Only the exact string `grpc` selects the gRPC branch. */
export type ServiceProxySetting = 'grpc' | 'unset' | 'other'

/**
 * Which service-proxy implementation the container ACTUALLY bound — the branch
 * that ran, not a re-derivation of the conditions. Re-deriving it here is how the
 * boot log and the panel would drift.
 */
export type BoundServiceProxy = 'direct-call' | 'grpc' | 'http'

/** `CACHE_TYPE`. `memory` is what suppresses the Redis binding entirely. */
export type CacheSetting = 'memory' | 'redis' | 'unset' | 'other'

/** `WEBSOCKET_SYNC_ENABLED`. Only the exact string `false` is the kill switch. */
export type SyncSwitchSetting = 'true' | 'false' | 'unset' | 'other'

/**
 * The variables the realtime lane, the files lane and the deployment marker
 * actually depend on. Every name here was verified to be read by this package
 * (`env.get('<NAME>'…)`); a name nobody reads would be a lie of omission in the
 * other direction, implying a knob that does not exist.
 */
export const DIAGNOSTIC_ENV_KEYS = [
  // Realtime transport
  'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
  'WEBSOCKET_SYNC_ALLOWED_ORIGINS',
  'PUBLIC_URL',
  'WEBSOCKET_GATEWAY_INTERNAL_SECRET',
  // Shared state
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  // Durable backend
  'SYNCING_SERVER_GRPC_URL',
  'AUTH_SERVER_GRPC_URL',
  'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET',
  'SYNCING_SERVER_JS_URL',
  // Files lane
  'WEBSOCKET_SYNC_FILES_URL',
  'FILES_SERVER_PROBE_URL',
  'FILES_SERVER_URL',
  'VALET_TOKEN_SECRET',
  'AUTH_JWT_SECRET',
  // Event fan-out
  'SQS_QUEUE_URL',
  'SNS_TOPIC_ARN',
  // Deployment identity
  'SRN_DEPLOY_REVISION',
  'SRN_DEPLOY_VERSION',
] as const

export type DiagnosticEnvKey = (typeof DIAGNOSTIC_ENV_KEYS)[number]

export type DeploymentDiagnosticsReport = {
  /**
   * False when nothing has been recorded — a build without the recorder wired,
   * or a request that lands before the container finished configuring. The panel
   * must then withhold every topology-conditional remedy rather than guess,
   * because a remedy chosen against an assumed topology is exactly the confidently
   * wrong advice this module exists to prevent.
   */
  recorded: boolean
  mode: DeploymentMode
  serviceProxySetting: ServiceProxySetting
  boundServiceProxy: BoundServiceProxy
  cacheSetting: CacheSetting
  syncSwitchSetting: SyncSwitchSetting
  /** The gRPC syncing-server proxy is bound in this container. */
  grpcSyncingProxyBound: boolean
  /**
   * Whether a gRPC proxy CAN be bound in this topology by configuration alone.
   * False in `home-server`, where the branch that constructs it is unreachable —
   * this is the single field that stops the panel recommending
   * `SYNCING_SERVER_GRPC_URL` where it would never be read.
   */
  grpcProxyBindableInThisMode: boolean
  /** A Redis client is bound in this container. */
  redisBound: boolean
  /** Presence only. True means "set to a non-empty value". */
  presence: Record<string, boolean>
}

export type DeploymentBindings = {
  boundServiceProxy: BoundServiceProxy
  grpcSyncingProxyBound: boolean
  redisBound: boolean
}

type EnvReader = (key: string) => string | undefined

const readToken = <T extends string>(value: string | undefined, allowed: readonly T[], unset: T, other: T): T => {
  if (value === undefined || value.trim() === '') {
    return unset
  }
  const found = allowed.find((candidate) => candidate === value)

  return found ?? other
}

/**
 * Build the report from the SAME env reader the container makes its binding
 * decisions with, plus the branches it actually took.
 *
 * The reader is a parameter rather than `process.env` on purpose: `home-server`
 * supplies `MODE` and `CACHE_TYPE` through constructor OVERRIDES that never reach
 * `process.env` (`buildHomeServerEnvironmentOverrides`), so a module reading the
 * process environment directly would report the bundled deployment as an
 * ordinary multi-container one and then hand out the wrong remedy.
 */
export function observeDeployment(read: EnvReader, bindings: DeploymentBindings): DeploymentDiagnosticsReport {
  const mode = readToken<DeploymentMode>(read('MODE'), ['home-server', 'self-hosted'], 'unset', 'other')
  const presence: Record<string, boolean> = {}
  for (const key of DIAGNOSTIC_ENV_KEYS) {
    presence[key] = Boolean(read(key)?.trim())
  }

  return {
    recorded: true,
    mode,
    serviceProxySetting: readToken<ServiceProxySetting>(read('SERVICE_PROXY_TYPE'), ['grpc'], 'unset', 'other'),
    boundServiceProxy: bindings.boundServiceProxy,
    cacheSetting: readToken<CacheSetting>(read('CACHE_TYPE'), ['memory', 'redis'], 'unset', 'other'),
    syncSwitchSetting: readToken<SyncSwitchSetting>(read('WEBSOCKET_SYNC_ENABLED'), ['true', 'false'], 'unset', 'other'),
    grpcSyncingProxyBound: bindings.grpcSyncingProxyBound,
    // Container.ts:1038 — the gRPC construction block is the `else` of
    // `isConfiguredForHomeServer`, so home-server can never reach it.
    grpcProxyBindableInThisMode: mode !== 'home-server',
    redisBound: bindings.redisBound,
    presence,
  }
}

const NOT_RECORDED: DeploymentDiagnosticsReport = Object.freeze({
  recorded: false,
  mode: 'unset',
  serviceProxySetting: 'unset',
  boundServiceProxy: 'http',
  cacheSetting: 'unset',
  syncSwitchSetting: 'unset',
  grpcSyncingProxyBound: false,
  grpcProxyBindableInThisMode: false,
  redisBound: false,
  presence: Object.freeze({}) as Record<string, boolean>,
})

/**
 * Late-bound like `SyncGateDiagnosticsRecorder`: the controller is registered
 * before the container finishes configuring, and both boot paths route through
 * `ContainerConfigLoader.load()`, so recording there covers the bundled
 * home-server and the standalone api-gateway with one call site.
 */
export class DeploymentDiagnosticsRecorder {
  private report_?: DeploymentDiagnosticsReport

  record(report: DeploymentDiagnosticsReport): void {
    this.report_ = report
  }

  clear(): void {
    this.report_ = undefined
  }

  report(): DeploymentDiagnosticsReport {
    return this.report_ ?? { ...NOT_RECORDED, presence: {} }
  }
}

export const deploymentDiagnostics = new DeploymentDiagnosticsRecorder()
