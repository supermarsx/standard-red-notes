import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'

import { TYPES } from '../Bootstrap/Types'

@controller('/healthcheck')
export class HealthCheckController {
  constructor(
    // Redis is only bound when a Redis cache is configured, so it is optional
    // here — its absence is treated as "healthy" for readiness.
    @inject(TYPES.ApiGateway_Redis) @optional() private redis?: { ping(): Promise<string> },
  ) {}

  // Cheap liveness: the process is up and the event loop is responsive. Kept
  // dependency-free so orchestrators can poll it frequently.
  @httpGet('/')
  public async get(): Promise<string> {
    return 'OK'
  }

  // Readiness: verifies the gateway can reach its own cheap dependency (Redis
  // PING) under a short timeout and returns 503 when it is down. Downstream
  // service health is intentionally NOT probed here — that would be heavy and is
  // covered by each service's own readiness endpoint.
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
