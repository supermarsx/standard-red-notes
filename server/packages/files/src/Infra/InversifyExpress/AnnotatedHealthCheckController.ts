import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'

import TYPES from '../../Bootstrap/Types'

@controller('/healthcheck')
export class AnnotatedHealthCheckController {
  constructor(
    // Optional so the unit test can construct the controller without a container.
    // In production Files_Redis is always bound and injected.
    @inject(TYPES.Files_Redis) @optional() private redis?: { ping(): Promise<string> },
  ) {}

  // Cheap liveness: the process is up and the event loop is responsive. Kept
  // dependency-free so orchestrators can poll it frequently.
  @httpGet('/')
  public async get(): Promise<string> {
    return 'OK'
  }

  // Readiness: verifies the service can actually serve traffic by pinging its
  // hard dependency (Redis PING) under a short timeout, and returns 503 when it
  // is down so the orchestrator stops routing to us until it recovers. The files
  // service has no SQL database, so Redis is the only cheap dependency to probe.
  @httpGet('/readiness')
  public async readiness(@response() res: Response): Promise<void> {
    const checks = { redis: false }

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

    const healthy = checks.redis
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
