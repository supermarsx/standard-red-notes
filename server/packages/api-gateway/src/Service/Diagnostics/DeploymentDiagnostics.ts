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
 *
 * This is why the queue keys are answered by PRESENCE and the launcher outcomes
 * by a closed union: a queue URL can embed an account id, an endpoint and
 * sometimes a credential, and a launcher that one day reported a reason as free
 * text could carry a host or a port out with it. A denylist of forbidden
 * substrings would not hold this boundary — the shape of the report is what
 * holds it, and the spec's poisoned-sentinel sweep proves the shape by feeding
 * this module a distinctive value for EVERY key it reads, whatever that set
 * grows into, and asserting none of them reaches the serialized payload.
 */

/**
 * `MODE`, as read by `ContainerConfigLoader`. The bundled multi-container
 * `server` image exports `MODE=self-hosted` from its entrypoint
 * (`server/docker/docker-entrypoint.sh`), so `self-hosted` is what the shipped
 * compose stack reports. `unset` is the RAW default — a process started outside
 * that entrypoint with no MODE at all (a bare `yarn start`, the standalone e2e
 * harness), not an ordinary deployment. `other` means a value we do not
 * recognise, which behaves like `unset` in the container but should not be
 * reported as if it were deliberate.
 */
export type DeploymentMode = 'home-server' | 'self-hosted' | 'unset' | 'other'

/**
 * `SERVICE_PROXY_TYPE`. Only the exact string `grpc` selects the gRPC branch
 * (`Container.ts:121`, an exact `===` with no trim and no case folding) -- but
 * that is a statement about the BRANCH, not about which settings are deliberate.
 * Three tokens are documented and supported, and all three are read here:
 *
 *   - `grpc`  force the gRPC proxies. The one value `Container.ts` tests for.
 *   - `http`  force the HTTP proxies and leave SYNC_ITEMS closed
 *             (`.env.example`, `scripts/setup.sh`, and the `operator` arm of
 *             `srn_resolve_service_proxy_type`, which exports it verbatim).
 *   - `auto`  let the server container decide at start. This is the value
 *             `scripts/setup.sh` WRITES by default, so it is the single most
 *             common reading in the fleet. The launcher consumes it and either
 *             exports `grpc` or unsets the variable -- in which case the
 *             entrypoint-generated dotenv still holds `auto` and that is what
 *             this reader sees.
 *
 * Admitting only `grpc` reported both of the others as `other (unrecognised)`,
 * i.e. told an operator who had configured the default, or deliberately pinned
 * HTTP, that their value was a typo. `other` is still the answer for anything
 * genuinely outside the set, and no value is ever echoed either way.
 */
export type ServiceProxySetting = 'grpc' | 'http' | 'auto' | 'unset' | 'other'

/**
 * The tokens `ServiceProxySetting` admits, as a value, so the read site and the
 * union cannot drift: a member added to one and not the other is a type error.
 */
const SERVICE_PROXY_TOKENS = ['grpc', 'http', 'auto'] as const satisfies readonly ServiceProxySetting[]

/**
 * `SRN_SERVICE_PROXY_TYPE_DECISION` — WHY the container is on the transport it
 * is on, as decided by `srn_resolve_service_proxy_type`
 * (`server/docker/internal-grpc-lane-env.sh`), which runs as the api-gateway's
 * own supervisord launcher after the backends are up.
 *
 * `serviceProxySetting` says what was CONFIGURED and `boundServiceProxy` says
 * what was BOUND; neither can say why they differ, and on this deployment they
 * differ by design — the shipped default is `auto`, which the launcher resolves.
 * The difference the operator needs is between a deployment where HTTP is the
 * right answer (`not-colocated`: there is no co-located syncing-server to speak
 * gRPC to) and one where something is broken (`syncing-grpc-unreachable`: a dial
 * target was configured and the port did not answer).
 *
 * The launcher recorded this all along and never EXPORTED it, so it was not in
 * the gateway's `process.env` at all and the panel's row could only ever be
 * blank. Both halves had to change; the export alone would have moved the blank
 * one layer along.
 *
 * `unset` means no launcher recorded a decision — an image older than the
 * export, or a gateway started outside `supervisor-server.sh` (a bare
 * `yarn start`, the standalone harness). That is NOT the same as "the reason is
 * undetermined", and the panel must not render it as one.
 */
export type ServiceProxyDecision =
  | 'operator'
  | 'grpc-default'
  | 'not-colocated'
  | 'no-grpc-urls'
  | 'no-secret'
  | 'auth-grpc-unreachable'
  | 'syncing-grpc-unreachable'
  | 'unset'
  | 'other'

/** As above: the tokens the union admits, as a value, so the two cannot drift. */
const SERVICE_PROXY_DECISION_TOKENS = [
  'operator',
  'grpc-default',
  'not-colocated',
  'no-grpc-urls',
  'no-secret',
  'auth-grpc-unreachable',
  'syncing-grpc-unreachable',
] as const satisfies readonly ServiceProxyDecision[]

/**
 * `SRN_INTERNAL_GRPC_SECRET_STATE` — how the durable-command secret the socket
 * SYNC_ITEMS lane needs came to be, as decided by
 * `srn_prepare_internal_grpc_secret` in the same helper. A STATE, never the
 * secret: the tokens are a closed set and none of them carries a value.
 *
 * It is worth reporting because `minted-ephemeral` and `mint-failed` are
 * silently fatal to the lane and look exactly like a working deployment from
 * outside, and because `persisted` vs `supplied` is the difference between a
 * value the operator can rotate in their `.env` and one living on a volume.
 *
 * This variable had the SAME unexported-assignment bug as the decision above,
 * and it hid better: `docker-entrypoint.sh` reads it in the same shell that
 * sourced the helper, so its boot log was correct while no child process — the
 * gateway included — could see the variable at all.
 */
export type InternalGrpcSecretState =
  | 'supplied'
  | 'persisted'
  | 'minted-persisted'
  | 'minted-ephemeral'
  | 'not-colocated'
  | 'mint-failed'
  | 'unset'
  | 'other'

/** As above: the tokens the union admits, as a value, so the two cannot drift. */
const INTERNAL_GRPC_SECRET_STATE_TOKENS = [
  'supplied',
  'persisted',
  'minted-persisted',
  'minted-ephemeral',
  'not-colocated',
  'mint-failed',
] as const satisfies readonly InternalGrpcSecretState[]

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
 * (`env.get('<NAME>'…)`) or, for `API_GATEWAY_SQS_QUEUE_URL`, to be the
 * PROJECTION SOURCE of a name that is — see the note beside it. A name that is
 * neither would be a lie of omission in the other direction, implying a knob
 * that does not exist.
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
  // Event fan-out.
  //
  // `SQS_QUEUE_URL` alone could not answer the question the panel asks of it.
  // The gateway's dotenv is projected from the `API_GATEWAY_` prefix
  // (`printenv | sed -n 's/^API_GATEWAY_//p' > api-gateway/.env`), so a queue
  // the gateway OWNS arrives as `API_GATEWAY_SQS_QUEUE_URL` in the process
  // environment AND as the bare `SQS_QUEUE_URL` in the dotenv, while a queue it
  // merely INHERITED from a sibling arrives bare and alone. With only the bare
  // name on the wire the two are indistinguishable, which is why the panel's
  // "Queue separation" row had nothing to derive from.
  //
  // That is not a hypothetical row. Workers once inherited the gateway's bare
  // `SQS_QUEUE_URL`; a queue delivers each message once, so the two consumers
  // split the traffic instead of each seeing it, and roughly four in five
  // realtime pushes plus revision and e-mail events went to whichever consumer
  // won the race and were then deleted. Nothing logged an error — both halves
  // succeeded, on different messages. The fix was the `API_GATEWAY_SQS_*`
  // prefix, and its PRESENCE is exactly the evidence that the fix is in place.
  //
  // Presence only, as everywhere here: a queue URL can embed an account id, an
  // endpoint and sometimes a credential, and none of that is read. One boolean
  // per name; the names themselves are public (they are in `docker-compose.yml`).
  'SQS_QUEUE_URL',
  'API_GATEWAY_SQS_QUEUE_URL',
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
  /**
   * WHY the launcher settled on the transport it did. A closed union; `unset`
   * means no launcher recorded one, which is a different fact from "the reason
   * could not be determined". See `ServiceProxyDecision`.
   */
  serviceProxyDecision: ServiceProxyDecision
  /**
   * How the durable-command secret the socket SYNC_ITEMS lane needs came to be.
   * A state token, never the secret. See `InternalGrpcSecretState`.
   */
  internalGrpcSecretState: InternalGrpcSecretState
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
    serviceProxySetting: readToken<ServiceProxySetting>(
      read('SERVICE_PROXY_TYPE'),
      SERVICE_PROXY_TOKENS,
      'unset',
      'other',
    ),
    serviceProxyDecision: readToken<ServiceProxyDecision>(
      read('SRN_SERVICE_PROXY_TYPE_DECISION'),
      SERVICE_PROXY_DECISION_TOKENS,
      'unset',
      'other',
    ),
    internalGrpcSecretState: readToken<InternalGrpcSecretState>(
      read('SRN_INTERNAL_GRPC_SECRET_STATE'),
      INTERNAL_GRPC_SECRET_STATE_TOKENS,
      'unset',
      'other',
    ),
    boundServiceProxy: bindings.boundServiceProxy,
    cacheSetting: readToken<CacheSetting>(read('CACHE_TYPE'), ['memory', 'redis'], 'unset', 'other'),
    syncSwitchSetting: readToken<SyncSwitchSetting>(
      read('WEBSOCKET_SYNC_ENABLED'),
      ['true', 'false'],
      'unset',
      'other',
    ),
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
  serviceProxyDecision: 'unset',
  internalGrpcSecretState: 'unset',
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
