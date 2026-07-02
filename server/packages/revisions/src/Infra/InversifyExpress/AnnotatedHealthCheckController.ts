import { inject, optional } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'
import { Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { SQLRevision } from '../TypeORM/SQL/SQLRevision'

@controller('/healthcheck')
export class AnnotatedHealthCheckController {
  constructor(
    // Optional so the unit test can construct the controller without a container.
    // In production Revisions_ORMRevisionRepository is always bound.
    @inject(TYPES.Revisions_ORMRevisionRepository) @optional() private revisionRepository?: Repository<SQLRevision>,
  ) {}

  // Cheap liveness: the process is up and the event loop is responsive. Kept
  // dependency-free so orchestrators can poll it frequently.
  @httpGet('/')
  public async get(): Promise<string> {
    return 'OK'
  }

  // Readiness: verifies the service can actually serve traffic by pinging its
  // hard dependency (DB `SELECT 1` through the revisions repository) under a
  // short timeout, and returns 503 when it is down so the orchestrator stops
  // routing to us until it recovers. The revisions service's only cheap
  // dependency is its database — mirrors the files/auth readiness pattern.
  @httpGet('/readiness')
  public async readiness(@response() res: Response): Promise<void> {
    const checks = { db: false }

    if (this.revisionRepository) {
      try {
        await this.withTimeout(this.revisionRepository.manager.query('SELECT 1'), 2000)
        checks.db = true
      } catch {
        checks.db = false
      }
    } else {
      checks.db = true
    }

    const healthy = checks.db
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
