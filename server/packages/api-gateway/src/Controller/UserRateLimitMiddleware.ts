import { NextFunction, Request, Response } from 'express'
import { inject, injectable, optional } from 'inversify'
import { BaseMiddleware } from 'inversify-express-utils'
import { Logger } from 'winston'

import { TYPES } from '../Bootstrap/Types'
import { ServerSettingsResolver } from '../Service/ServerSettings/ServerSettingsResolver'
import { RateLimitMetricsStore } from './RateLimitMetrics'
import { createUserRateLimitMiddleware, RateLimitRedis, UserRateLimitConfig } from './RateLimitMiddleware'

/**
 * Standard Red Notes: the PER-USER rate tier (anti-abuse item 4), mounted as an
 * inversify-express-utils middleware on the expensive AUTHENTICATED endpoints
 * (the assistant LLM streaming proxy). It MUST run AFTER
 * RequiredCrossServiceTokenMiddleware so `response.locals.user` is set — the
 * limiter keys on the authenticated user uuid.
 *
 * SAFE DEFAULT: the effective window/max are resolved PER REQUEST from the
 * ServerSettings overlay (`security.rateLimit.userWindowSeconds` / `userMax`,
 * admin value wins over RATE_LIMIT_USER_* env wins over the hardcoded default of
 * userMax=0). A max of 0 (the default) makes the wrapped limiter a pure
 * pass-through, so mounting it is behavior-preserving until an admin opts in.
 *
 * FAIL-OPEN: when Redis is absent (in-memory cache deployment) the wrapped
 * limiter is a no-op, and any Redis/overlay error inside it degrades to next()
 * rather than blocking a legitimate request.
 */
@injectable()
export class UserRateLimitMiddleware extends BaseMiddleware {
  private readonly delegate: (request: Request, response: Response, next: NextFunction) => void

  constructor(
    @inject(TYPES.ApiGateway_ServerSettingsResolver) serverSettingsResolver: ServerSettingsResolver,
    @inject(TYPES.ApiGateway_Logger) logger: Logger,
    // Redis is only bound when a Redis cache is configured; without it the
    // wrapped limiter is a pass-through (createUserRateLimitMiddleware no-ops on
    // an undefined client).
    @inject(TYPES.ApiGateway_Redis) @optional() redis?: RateLimitRedis,
    @inject(TYPES.ApiGateway_RateLimitMetricsStore) @optional() metrics?: RateLimitMetricsStore,
    @inject(TYPES.ApiGateway_CLIENT_IP_HEADER) @optional() clientIpHeader = '',
  ) {
    super()

    this.delegate = createUserRateLimitMiddleware({
      redis,
      logger: {
        warn: (message: string): void => {
          logger.warn(message)
        },
      },
      // The bucket namespaces the per-user counter; 'assistant' groups all the
      // expensive AI proxy endpoints under one shared per-user budget.
      config: async (): Promise<UserRateLimitConfig> => {
        const resolved = await serverSettingsResolver.resolveRateLimitConfig()

        return {
          bucket: 'assistant',
          windowSeconds: resolved.userWindowSeconds,
          max: resolved.userMax,
        }
      },
      metrics,
      clientIpHeader,
    })
  }

  handler(request: Request, response: Response, next: NextFunction): void {
    this.delegate(request, response, next)
  }
}
