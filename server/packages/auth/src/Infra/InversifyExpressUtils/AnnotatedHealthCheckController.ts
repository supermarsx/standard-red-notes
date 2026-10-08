import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'
import { Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { Role } from '../../Domain/Role/Role'
import { CookieFactoryInterface } from '../../Domain/Auth/Cookies/CookieFactoryInterface'
import { InviteEventOutboxDispatcher } from '../../Domain/Invite/InviteEventOutboxDispatcher'
import { InviteEventOutboxRepositoryInterface } from '../../Domain/Invite/InviteEventOutboxRepositoryInterface'
import { resolveAuthRuntimeDiagnosticsReport } from '../Diagnostics/AuthRuntimeDiagnosticsEndpoint'
import { TypeORMInviteEventOutbox } from '../TypeORM/TypeORMInviteEventOutbox'

/**
 * Standard Red Notes: the answer window and its test seam live in the shared
 * endpoint module, because the bundled home-server answers the SAME route from
 * a loopback-only internal listener and the two entry points must share one
 * window rather than hold one each. Re-exported here so this module stays the
 * one import a reader of the route needs.
 */
export {
  DIAGNOSTICS_CACHE_TTL_MS,
  clearAuthRuntimeDiagnosticsCache,
} from '../Diagnostics/AuthRuntimeDiagnosticsEndpoint'

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
    // Standard Red Notes: the three bindings the DEAD-OUTBOX census needs, all
    // @optional so the controller still constructs on a container that predates
    // them and on one that binds no outbox at all — the census is then omitted
    // rather than reported as zero rows.
    //
    // The entity repository does the counting; the domain repository is asked
    // only whether it implements the requeue transition; the dispatcher is asked
    // only whether a drain loop is armed. None of the three is used for anything
    // else here, and no row, identifier or error code is read off any of them.
    @inject(TYPES.Auth_ORMInviteEventOutboxRepository)
    @optional()
    private inviteEventOutboxEntityRepository?: Repository<TypeORMInviteEventOutbox>,
    @inject(TYPES.Auth_InviteEventOutboxRepository)
    @optional()
    private inviteEventOutboxRepository?: InviteEventOutboxRepositoryInterface,
    @inject(TYPES.Auth_InviteEventOutboxDispatcher)
    @optional()
    private inviteEventOutboxDispatcher?: InviteEventOutboxDispatcher,
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
   * attributes, the legacy-session switch, the state of the durable store this
   * service owns a handle on, and the count of TERMINAL invite-event outbox rows
   * (a row no dispatcher will claim again, carrying a realtime invalidation some
   * client is still waiting for) beside whether anything here could put one
   * back on the queue.
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
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: this.roleRepository.manager.connection,
      cookieFactory: this.cookieFactory,
      forceLegacySessions: this.forceLegacySessions,
      outboxEntityRepository: this.inviteEventOutboxEntityRepository,
      outboxRepository: this.inviteEventOutboxRepository,
      outboxDispatcher: this.inviteEventOutboxDispatcher,
    })

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
