import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'

import TYPES from '../../Bootstrap/Types'
import { StorageReadinessInterface } from '../../Domain/Services/StorageReadinessInterface'

@controller('/healthcheck')
export class AnnotatedHealthCheckController {
  constructor(
    // Redis is intentionally absent when CACHE_TYPE=memory (the zero-Redis
    // home-server profile), so its absence is healthy for that topology.
    @inject(TYPES.Files_Redis) @optional() private redis?: { ping(): Promise<string> },
    // Optional only for direct unit construction. Production always binds the
    // topology-specific filesystem or S3 capability probe and absence fails
    // readiness closed.
    @inject(TYPES.Files_StorageReadiness) @optional() private storage?: StorageReadinessInterface,
  ) {}

  // Cheap liveness: the process is up and the event loop is responsive. Kept
  // dependency-free so orchestrators can poll it frequently.
  @httpGet('/')
  public async get(): Promise<string> {
    return 'OK'
  }

  // Readiness: verifies the service can actually serve traffic by pinging its
  // hard dependencies (Redis when configured plus the active filesystem/S3
  // storage capability) under a short timeout, and returns 503 when either is
  // down so the orchestrator stops routing to us until it recovers.
  @httpGet('/readiness')
  public async readiness(@response() res: Response): Promise<void> {
    const checks = { redis: this.redis === undefined, storage: false }

    await Promise.all([
      this.redis
        ? this.withTimeout(this.redis.ping(), 2000)
            .then(() => {
              checks.redis = true
            })
            .catch(() => undefined)
        : Promise.resolve(),
      this.storage
        ? this.withTimeout(this.storage.check(), 2000)
            .then(() => {
              checks.storage = true
            })
            .catch(() => undefined)
        : Promise.resolve(),
    ])

    const healthy = checks.redis && checks.storage
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
