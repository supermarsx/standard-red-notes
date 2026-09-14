import { DEFAULT_CONTROLLABLE_PROGRAMS, ServiceControlService } from '../ServiceControl/ServiceControlService'
import { DeploymentIdentity, verifiedDeploymentIdentity } from './DeploymentIdentity'
import { ReadinessState } from './ReadinessState'

export type ReadinessFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number }>

/**
 * Standard Red Notes (C9): what the in-process realtime gateway says about
 * itself. Structurally identical to the websocket-gateway package's
 * `GatewayHealth` (`AttachedGateway.health()`); mirrored here so readiness
 * compiles against a host that has not rebuilt that package, and so the shape
 * this endpoint publishes is pinned in THIS module. Nothing in it is secret or
 * per-user. INFORMATIONAL ONLY — it never gates `status`: a Redis blip on the
 * push bridge must not restart the container.
 */
export type RealtimeGatewayHealth = {
  attached: true
  /** Which push transport attached: Redis pub/sub, an in-process bridge, or none. */
  pushBridge: 'redis' | 'in-process' | 'none'
  /** The push subscriber's client currently reports `ready`. */
  pushBridgeReady: boolean
  /** The SQS consumer loop was started and has not been stopped. */
  sqsConsumerRunning: boolean
  /** The collaboration relay subscription is established. */
  collaborationRelayHealthy: boolean
  /** Whether `/sockets/sync` would admit a client right now. */
  syncLane: 'up' | 'down'
  /** Push messages handed to the local connection registry since attach. */
  pushesDispatched: number
}

/** `{ attached: false }` when the provider is wired but no gateway is attached (or it threw). */
export type RealtimeReadinessReport = RealtimeGatewayHealth | { attached: false }

export type AggregateReadinessChecks = {
  gateway: { redis: boolean; runtime: boolean; realtime?: RealtimeReadinessReport }
  services: Record<string, boolean>
  programs?: Record<string, boolean>
}

export type AggregateReadinessReport = {
  status: 'ready' | 'unavailable'
  deployment: DeploymentIdentity
  checks: AggregateReadinessChecks
}

export interface AggregateReadinessServiceOptions {
  homeServer: boolean
  state: ReadinessState
  redis?: { ping(): Promise<string> }
  serviceProbeUrls?: Record<string, string>
  serviceControlService?: ServiceControlService
  inProcessChecks?: Record<string, () => Promise<unknown>>
  fetchFn?: ReadinessFetch
  timeoutMs?: number
  cacheTtlMs?: number
  now?: () => number
  deploymentRevision?: string
  deploymentVersion?: string
  deploymentMarker?: DeploymentIdentity
  /**
   * C9: late-bound realtime health provider. The gateway attaches to the owned
   * http.Server AFTER the container is built, so this is a thunk, not a value.
   * `undefined` from the thunk means "no gateway attached". Omit the option
   * entirely and the report carries no `realtime` field at all.
   */
  realtime?: () => RealtimeGatewayHealth | undefined
}

/**
 * Public, bounded, fail-closed readiness for both supported server topologies.
 *
 * Multi-process deployments require every backend readiness endpoint and every
 * supervisord program (including workers) to be healthy. The home-server uses
 * direct in-process dependency checks plus an explicit lifecycle gate because
 * there are no independently supervised sibling services or workers.
 */
export class AggregateReadinessService {
  private readonly requiredServices = ['auth', 'syncing-server', 'files', 'revisions']
  private readonly fetchFn: ReadinessFetch
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private cached: { expiresAt: number; report: AggregateReadinessReport } | undefined
  private inFlight: Promise<AggregateReadinessReport> | undefined
  private readonly deployment: AggregateReadinessReport['deployment']

  constructor(private readonly options: AggregateReadinessServiceOptions) {
    this.fetchFn = options.fetchFn ?? (globalThis.fetch.bind(globalThis) as unknown as ReadinessFetch)
    this.timeoutMs = options.timeoutMs ?? 2_500
    // This endpoint is public. A small cache and in-flight coalescing prevent it
    // from becoming a process-spawn/internal-request amplification primitive.
    this.cacheTtlMs = options.cacheTtlMs ?? 5_000
    this.now = options.now ?? Date.now
    // Deployment identity is public metadata, never a health gate. Reject
    // malformed or unbounded operator input instead of reflecting it verbatim.
    this.deployment = verifiedDeploymentIdentity(
      options.deploymentRevision,
      options.deploymentVersion,
      options.deploymentMarker,
    )
  }

  async check(): Promise<AggregateReadinessReport> {
    const now = this.now()
    const runtimeReady = this.options.state.isReady()
    if (this.cached && this.cached.expiresAt > now && this.cached.report.checks.gateway.runtime === runtimeReady) {
      return this.cached.report
    }
    this.cached = undefined
    if (this.inFlight) {
      return this.inFlight
    }

    this.inFlight = this.runChecks()
    try {
      const report = await this.inFlight
      this.cached = { expiresAt: this.now() + this.cacheTtlMs, report }

      return report
    } finally {
      this.inFlight = undefined
    }
  }

  private async runChecks(): Promise<AggregateReadinessReport> {
    if (this.options.homeServer) {
      const [redis, services] = await Promise.all([this.checkRedis(), this.checkInProcessServices()])
      const runtime = this.options.state.isReady()

      return this.report({ gateway: { redis, runtime }, services })
    }

    const [redis, services, programs] = await Promise.all([
      this.checkRedis(),
      this.checkServiceEndpoints(),
      this.checkPrograms(),
    ])
    const runtime = this.options.state.isReady()

    return this.report({ gateway: { redis, runtime }, services, programs })
  }

  private report(checks: AggregateReadinessChecks): AggregateReadinessReport {
    // Realtime health is deliberately NOT part of this conjunction — see RealtimeGatewayHealth.
    const healthy =
      checks.gateway.redis &&
      checks.gateway.runtime &&
      Object.values(checks.services).every(Boolean) &&
      (checks.programs === undefined || Object.values(checks.programs).every(Boolean))

    const realtime = this.sampleRealtime()
    const reported: AggregateReadinessChecks =
      realtime === undefined ? checks : { ...checks, gateway: { ...checks.gateway, realtime } }

    return { status: healthy ? 'ready' : 'unavailable', deployment: this.deployment, checks: reported }
  }

  private sampleRealtime(): RealtimeReadinessReport | undefined {
    if (!this.options.realtime) {
      return undefined
    }
    try {
      return this.options.realtime() ?? { attached: false }
    } catch {
      // A health snapshot must never take readiness down with it.
      return { attached: false }
    }
  }

  private async checkRedis(): Promise<boolean> {
    if (!this.options.redis) {
      return true
    }

    return this.promiseSucceeds(this.options.redis.ping())
  }

  private async checkInProcessServices(): Promise<Record<string, boolean>> {
    const results = await Promise.all(
      this.requiredServices.map(async (name) => {
        const check = this.options.inProcessChecks?.[name]

        return [name, check ? await this.checkCall(check) : false] as const
      }),
    )

    return Object.fromEntries(results)
  }

  private async checkServiceEndpoints(): Promise<Record<string, boolean>> {
    const urls = this.options.serviceProbeUrls ?? {}
    const results = await Promise.all(
      this.requiredServices.map(async (name) => {
        const baseUrl = urls[name]
        if (!baseUrl) {
          return [name, false] as const
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        timer.unref()
        try {
          const response = await this.withTimeout(
            this.fetchFn(`${baseUrl.replace(/\/$/, '')}/healthcheck/readiness`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: controller.signal,
            }),
          )

          return [name, response.status === 200] as const
        } catch {
          return [name, false] as const
        } finally {
          clearTimeout(timer)
        }
      }),
    )

    return Object.fromEntries(results)
  }

  private async checkPrograms(): Promise<Record<string, boolean>> {
    const programs = Object.fromEntries(DEFAULT_CONTROLLABLE_PROGRAMS.map((program) => [program, false]))
    if (!this.options.serviceControlService) {
      return programs
    }

    const snapshot = await this.valueOrUndefined(this.options.serviceControlService.getProgramStatuses())
    if (!snapshot?.available) {
      return programs
    }
    for (const program of DEFAULT_CONTROLLABLE_PROGRAMS) {
      programs[program] = snapshot.statuses[program] === 'RUNNING'
    }

    return programs
  }

  private async checkCall(check: () => Promise<unknown>): Promise<boolean> {
    try {
      return await this.promiseSucceeds(check())
    } catch {
      return false
    }
  }

  private async promiseSucceeds(promise: Promise<unknown>): Promise<boolean> {
    try {
      await this.withTimeout(promise)

      return true
    } catch {
      return false
    }
  }

  private async valueOrUndefined<T>(promise: Promise<T>): Promise<T | undefined> {
    try {
      return await this.withTimeout(promise)
    } catch {
      return undefined
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('readiness check timed out')), this.timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
