import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'
import { Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { Role } from '../../Domain/Role/Role'

@controller('/healthcheck')
export class AnnotatedHealthCheckController {
  constructor(
    @inject(TYPES.Auth_ORMRoleRepository) private roleRepository: Repository<Role>,
    // Redis is not bound when CACHE_TYPE=memory (home-server / self-hosted), so it
    // is optional here — its absence is treated as "healthy" for readiness.
    @inject(TYPES.Auth_Redis) @optional() private redis: { ping(): Promise<string> } | undefined,
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
