import { inject } from 'inversify'
import { controller, httpGet } from 'inversify-express-utils'
import { Request, Response } from 'express'

import { TYPES } from '../Bootstrap/Types'
import { AggregateReadinessReport, AggregateReadinessService } from '../Service/Readiness/AggregateReadinessService'

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Standard Red Notes (N44): whether the readiness caller is the container
 * itself — the Docker/compose healthcheck curl, `srn_admin`, the LXC installer —
 * rather than a client on the public front door. Decided on the TCP peer
 * address, NOT `request.ip`: with TRUST_PROXY honouring X-Forwarded-For, a remote
 * client could otherwise present a forged loopback origin. Anything that came
 * through a reverse proxy carries `x-forwarded-for` (nginx sets it on every
 * proxied request) and is treated as public even when that proxy runs on
 * loopback, as it does in the single container.
 */
export function isLoopbackReadinessCaller(req: Pick<Request, 'socket' | 'headers'>): boolean {
  const peer = req.socket?.remoteAddress
  return typeof peer === 'string' && LOOPBACK_ADDRESSES.has(peer) && req.headers['x-forwarded-for'] === undefined
}

/**
 * The public shape: the verdict and the (already public) deployment identity.
 * The per-service and supervisord program map stays in-container; it named
 * every internal service and worker to anyone who could reach the app URL.
 */
export function publicReadinessBody(
  report: AggregateReadinessReport,
): Pick<AggregateReadinessReport, 'status' | 'deployment'> {
  return { status: report.status, deployment: report.deployment }
}

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
  // The status code is the same for every caller; only the body is narrowed
  // for callers that did not come from inside the container (see above).
  @httpGet('/readiness')
  public async readiness(req: Request, res: Response): Promise<void> {
    const report = await this.aggregateReadinessService.check()
    const body = isLoopbackReadinessCaller(req) ? report : publicReadinessBody(report)
    res.status(report.status === 'ready' ? 200 : 503).json(body)
  }
}
