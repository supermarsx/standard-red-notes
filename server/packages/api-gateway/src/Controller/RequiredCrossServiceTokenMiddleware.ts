import { TimerInterface } from '@standardnotes/time'
import { NextFunction, Response } from 'express'
import { inject, injectable, optional } from 'inversify'
import { Logger } from 'winston'

import { TYPES } from '../Bootstrap/Types'
import { CrossServiceTokenCacheInterface } from '../Service/Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { AuthMiddleware } from './AuthMiddleware'
import { PublicInvalidAuthFailure, safePublicErrorData } from '../Service/Logging/SafeLog'

@injectable()
export class RequiredCrossServiceTokenMiddleware extends AuthMiddleware {
  constructor(
    @inject(TYPES.ApiGateway_ServiceProxy) serviceProxy: ServiceProxyInterface,
    @inject(TYPES.ApiGateway_AUTH_JWT_SECRET) jwtSecret: string,
    @inject(TYPES.ApiGateway_CROSS_SERVICE_TOKEN_CACHE_TTL) crossServiceTokenCacheTTL: number,
    @inject(TYPES.ApiGateway_CrossServiceTokenCache) crossServiceTokenCache: CrossServiceTokenCacheInterface,
    @inject(TYPES.ApiGateway_Timer) timer: TimerInterface,
    @inject(TYPES.ApiGateway_Logger) logger: Logger,
    @inject(TYPES.ApiGateway_CLIENT_IP_HEADER) @optional() clientIpHeader = '',
  ) {
    super(serviceProxy, jwtSecret, crossServiceTokenCacheTTL, crossServiceTokenCache, timer, logger, clientIpHeader)
  }

  protected override handleSessionValidationResponse(
    authResponse: { status: number; data: unknown; headers: { contentType: string } },
    response: Response,
    _next: NextFunction,
  ): boolean {
    if (authResponse.status > 200) {
      const status = authResponse.status >= 400 && authResponse.status <= 599 ? authResponse.status : 500
      const contentType = authResponse.headers.contentType
      if (typeof contentType === 'string' && contentType.trim().length > 0) {
        response.setHeader('content-type', contentType)
      }
      response.status(status).send(safePublicErrorData(authResponse.data))

      return false
    }

    return true
  }

  protected override handleMissingAuthHeader(
    authHeaderValue: string | undefined,
    response: Response,
    _next: NextFunction,
  ): boolean {
    if (!authHeaderValue) {
      this.logger.debug('Missing auth header')

      response.status(401).send(PublicInvalidAuthFailure)

      return false
    }

    return true
  }
}
