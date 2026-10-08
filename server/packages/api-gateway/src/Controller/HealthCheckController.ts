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

/** What a readiness caller is answered with: the status line and the body it may see. */
export type ReadinessAnswer = {
  statusCode: 200 | 503
  body: AggregateReadinessReport | Pick<AggregateReadinessReport, 'status' | 'deployment'>
}

/**
 * Standard Red Notes: the ONE composition of the readiness answer — the
 * 200/503 rule AND the body-withholding rule, decided together.
 *
 * It exists because `/healthcheck/readiness` has TWO entry points. The
 * standalone api-gateway answers it from the controller below. The bundled
 * home-server CANNOT: every service it bundles declares its own
 * `@controller('/healthcheck')` with a `/readiness` route, so which one
 * `server.build()` mounts depends on controller discovery order — it therefore
 * registers the aggregate route directly on the public app, ahead of the
 * controller router, and `validateReadinessBootContract` in
 * `scripts/validate-docker-hardening.mjs` pins that ordering.
 *
 * That direct registration reached PAST `publicReadinessBody` and served the
 * whole `AggregateReadinessReport` — `checks.services` and
 * `checks.gateway.realtime`, the internal service topology and which internal
 * dependency is up — to every unauthenticated caller on the front door, while
 * the same deployment's multi-container twin withheld it. A second copy of the
 * answer rule is how one entry point gets the control and its twin does not,
 * so there is no second copy: both call this.
 *
 * The status code is deliberately caller-INDEPENDENT. The container healthcheck
 * (`curl -fsS http://127.0.0.1:8080/healthcheck/readiness >/dev/null`) arrives
 * through nginx, which sets `X-Forwarded-For` on every proxied request, so it is
 * classified public — and it discards the body entirely and scores only the
 * status. Narrowing the body therefore cannot affect `Up (healthy)`.
 */
export function resolveReadinessAnswer(
  req: Pick<Request, 'socket' | 'headers'>,
  report: AggregateReadinessReport,
): ReadinessAnswer {
  return {
    statusCode: report.status === 'ready' ? 200 : 503,
    body: isLoopbackReadinessCaller(req) ? report : publicReadinessBody(report),
  }
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
    const answer = resolveReadinessAnswer(req, await this.aggregateReadinessService.check())
    res.status(answer.statusCode).json(answer.body)
  }
}
