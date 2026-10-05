import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'
import { Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { Role } from '../../Domain/Role/Role'
import { CookieFactoryInterface } from '../../Domain/Auth/Cookies/CookieFactoryInterface'
import {
  AuthRuntimeDiagnosticsReport,
  DB_PROBE_TIMEOUT_MS,
  observeAuthRuntime,
} from '../../Domain/Diagnostics/AuthRuntimeDiagnostics'
import { createTypeORMDatastoreProbe } from '../TypeORM/TypeORMDatastoreProbe'

/**
 * Standard Red Notes: how long a `/healthcheck/diagnostics` answer may be
 * re-served before the probes run again.
 *
 * The route performs real database work — a read, a zero-row write and a
 * migration read — and it is reachable by anything that can reach this service
 * on the internal network. A short shared answer bounds that to one probe set
 * per window however often it is asked, and costs the pane nothing: the admin
 * screen reads it once per load, and the facts it carries (a schema's migration
 * state, a pool census) do not change between two clicks.
 *
 * Module-level rather than per-instance because inversify-express-utils builds a
 * fresh controller per request, so instance state would never be reused.
 */
export const DIAGNOSTICS_CACHE_TTL_MS = 5_000

let cachedDiagnostics: { at: number; report: AuthRuntimeDiagnosticsReport } | undefined

/** Test seam: drop the shared answer so a spec can observe a fresh probe. */
export const clearAuthRuntimeDiagnosticsCache = (): void => {
  cachedDiagnostics = undefined
}

@controller('/healthcheck')
export class AnnotatedHealthCheckController {
  constructor(
    @inject(TYPES.Auth_ORMRoleRepository) private roleRepository: Repository<Role>,
    // Redis is not bound when CACHE_TYPE=memory (home-server / self-hosted), so it
    // is optional here — its absence is treated as "healthy" for readiness.
    @inject(TYPES.Auth_Redis) @optional() private redis: { ping(): Promise<string> } | undefined,
    // Standard Red Notes: the REAL session-cookie factory, asked for the
    // effective `Secure` / `Partitioned` attributes by the diagnostics route
    // below. Optional so the controller still constructs on a container that
    // predates the binding, and so unit tests need not build one.
    @inject(TYPES.Auth_CookieFactory) @optional() private cookieFactory?: CookieFactoryInterface,
    // `E2E_TESTING === 'true'`, as this process resolved it. A boolean binding
    // that already exists; never re-derived here.
    @inject(TYPES.Auth_FORCE_LEGACY_SESSIONS) @optional() private forceLegacySessions?: boolean,
  ) {}

  // Cheap liveness: the process is up and the event loop is responsive. Kept
  // dependency-free so orchestrators can poll it frequently.
  @httpGet('/')
  public async get(): Promise<string> {
    return 'OK'
  }

  // Readiness: verifies the service can actually serve traffic by pinging its
  // hard dependencies (DB `SELECT 1` + Redis PING) under a short timeout, and
  // returns 503 when any dependency is down so the orchestrator stops routing to
  // us until it recovers. Cheap and bounded — no heavy work.
  @httpGet('/readiness')
  public async readiness(@response() res: Response): Promise<void> {
    const checks = { db: false, redis: false }

    try {
      await this.withTimeout(this.roleRepository.manager.query('SELECT 1'), 2000)
      checks.db = true
    } catch {
      checks.db = false
    }

    if (this.redis) {
      try {
        await this.withTimeout(this.redis.ping(), 2000)
        checks.redis = true
      } catch {
        checks.redis = false
      }
    } else {
      checks.redis = true
    }

    const healthy = checks.db && checks.redis
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'unavailable', checks })
  }

  /**
   * Standard Red Notes: the facts about THIS process that the admin Diagnostics
   * pane needs and that the gateway cannot answer — the effective session-cookie
   * attributes, the legacy-session switch, and the state of the durable store
   * this service owns a handle on.
   *
   * SEPARATE FROM `/readiness` ON PURPOSE. Readiness is polled by the
   * orchestrator every few seconds and must stay cheap; this route runs a write
   * probe and a migration read, and it answers 200 with a degraded body rather
   * than ever failing a deployment.
   *
   * *** WHAT CAN COME OUT OF HERE ***
   * Booleans, members of closed unions, bounded counts and bounded whole-
   * millisecond durations — see `AuthRuntimeDiagnostics`, whose report type
   * contains no `string` field at all. No probe failure detail is read, so there
   * is no field for the host, port or database name a driver error carries. The
   * gateway re-reads this body BY ALLOWLIST before serving it to an admin, so
   * even a newer or misbehaving auth cannot push free-form text to a client.
   */
  @httpGet('/diagnostics')
  public async diagnostics(@response() res: Response): Promise<void> {
    const now = Date.now()
    if (cachedDiagnostics !== undefined && now - cachedDiagnostics.at < DIAGNOSTICS_CACHE_TTL_MS) {
      res.status(200).json(cachedDiagnostics.report)

      return
    }

    const report = await observeAuthRuntime({
      uptimeSeconds: process.uptime(),
      // A container that predates the cookie binding reports both attributes
      // OFF rather than failing the route; the gateway's reader carries the
      // distinction no further, because the attributes default to ON when the
      // variables are unset and a fabricated reading here would invert the
      // diagnosis. An absent factory is impossible on a booted auth server —
      // `Auth_CookieFactory` is bound unconditionally — so this arm exists only
      // for construction without a container.
      cookies: this.cookieFactory ?? { createCookieHeaderValue: (): string[] => [] },
      e2eTesting: this.forceLegacySessions === true,
      datastore: createTypeORMDatastoreProbe(this.roleRepository.manager.connection),
      timeoutMs: DB_PROBE_TIMEOUT_MS,
    })

    cachedDiagnostics = { at: now, report }

    res.status(200).json(report)
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs)
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
