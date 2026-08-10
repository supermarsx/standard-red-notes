import { inject } from 'inversify'
import { controller, httpGet, response } from 'inversify-express-utils'
import { Response } from 'express'

import { TYPES } from '../Bootstrap/Types'
import { AggregateReadinessService } from '../Service/Readiness/AggregateReadinessService'

@controller('/healthcheck')
export class HealthCheckController {
  constructor(
    @inject(TYPES.ApiGateway_AggregateReadinessService)
    private aggregateReadinessService: AggregateReadinessService,
  ) {}

  // Cheap liveness: the process is up and the event loop is responsive. Kept
  // dependency-free so orchestrators can poll it frequently.
  @httpGet('/')
  public async get(): Promise<string> {
    return 'OK'
  }

  // Aggregate readiness: this is the deployment acceptance path. Liveness stays
  // cheap above; readiness fails closed when any required service, dependency,
  // supervised worker, or in-process home-server runtime component is down.
  @httpGet('/readiness')
  public async readiness(@response() res: Response): Promise<void> {
    const report = await this.aggregateReadinessService.check()
    res.status(report.status === 'ready' ? 200 : 503).json(report)
  }
}
