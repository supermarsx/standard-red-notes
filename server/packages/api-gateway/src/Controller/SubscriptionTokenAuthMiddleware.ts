import { OfflineUserTokenData, CrossServiceTokenData } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import { inject, injectable } from 'inversify'
import { BaseMiddleware } from 'inversify-express-utils'
import { verify } from 'jsonwebtoken'
import { AxiosInstance, AxiosResponse } from 'axios'
import { Logger } from 'winston'
import { TYPES } from '../Bootstrap/Types'
import { TokenAuthenticationMethod } from './TokenAuthenticationMethod'
import { ResponseLocals } from './ResponseLocals'
import { OfflineResponseLocals } from './OfflineResponseLocals'
import { SubscriptionResponseLocals } from './SubscriptionResponseLocals'
import {
  PublicServiceFailure,
  publicHttpErrorStatus,
  safeHttpErrorLogMetadata,
  safePublicErrorData,
} from '../Service/Logging/SafeLog'

const SubscriptionTokenHeader = 'x-subscription-token'

@injectable()
export class SubscriptionTokenAuthMiddleware extends BaseMiddleware {
  constructor(
    @inject(TYPES.ApiGateway_HTTPClient) private httpClient: AxiosInstance,
    @inject(TYPES.ApiGateway_AUTH_SERVER_URL) private authServerUrl: string,
    @inject(TYPES.ApiGateway_AUTH_JWT_SECRET) private jwtSecret: string,
    @inject(TYPES.ApiGateway_Logger) private logger: Logger,
  ) {
    super()
  }

  async handler(request: Request, response: Response, next: NextFunction): Promise<void> {
    const bodyTokenCandidate =
      request.body && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>).subscription_token
        : undefined
    const tokenCandidate = request.query.subscription_token || bodyTokenCandidate
    const subscriptionToken = typeof tokenCandidate === 'string' ? tokenCandidate : undefined

    const emailCandidate = request.headers['x-offline-email']
    const email = typeof emailCandidate === 'string' ? emailCandidate : undefined
    if (!subscriptionToken) {
      response.status(401).send({
        error: {
          tag: 'invalid-auth',
          message: 'Invalid login credentials.',
        },
      })

      return
    }

    const locals = {
      tokenAuthenticationMethod: email
        ? TokenAuthenticationMethod.OfflineSubscriptionToken
        : TokenAuthenticationMethod.SubscriptionToken,
    } as SubscriptionResponseLocals
    Object.assign(response.locals, locals)

    try {
      const url =
        locals.tokenAuthenticationMethod == TokenAuthenticationMethod.OfflineSubscriptionToken
          ? `${this.authServerUrl}/offline/subscription-tokens/validate`
          : `${this.authServerUrl}/subscription-tokens/validate`

      const authResponse = await this.httpClient.request({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          [SubscriptionTokenHeader]: subscriptionToken,
        },
        data: {
          email,
        },
        validateStatus: (status: number) => {
          return status >= 200 && status < 500
        },
        url,
      })

      if (authResponse.status > 200) {
        this.sendValidationFailure(response, authResponse)

        return
      }

      if (locals.tokenAuthenticationMethod == TokenAuthenticationMethod.OfflineSubscriptionToken) {
        this.handleOfflineAuthTokenValidationResponse(response, authResponse)

        return next()
      }

      this.handleAuthTokenValidationResponse(response, authResponse)

      return next()
    } catch (error) {
      const endpoint =
        locals.tokenAuthenticationMethod == TokenAuthenticationMethod.OfflineSubscriptionToken
          ? `${this.authServerUrl}/offline/subscription-tokens/validate`
          : `${this.authServerUrl}/subscription-tokens/validate`
      const safeError = safeHttpErrorLogMetadata(error, {
        action: 'subscription-token.validate',
        endpoint,
        method: 'POST',
      })
      this.logger.error('Could not validate subscription token on underlying service.', safeError)
      this.logger.debug('Subscription token validation failure summary.', safeError)

      response.status(publicHttpErrorStatus(error)).send(PublicServiceFailure)

      return
    }
  }

  private sendValidationFailure(response: Response, authResponse: AxiosResponse): void {
    const status = authResponse.status >= 400 && authResponse.status <= 599 ? authResponse.status : 500
    const contentType = authResponse.headers?.['content-type']
    if (typeof contentType === 'string' && contentType.length > 0) {
      response.setHeader('content-type', contentType)
    }
    response.status(status).send(safePublicErrorData(authResponse.data))
  }

  private handleOfflineAuthTokenValidationResponse(response: Response, authResponse: AxiosResponse) {
    const decodedToken = verify(authResponse.data.authToken, this.jwtSecret, {
      algorithms: ['HS256'],
    }) as OfflineUserTokenData

    Object.assign(response.locals, {
      offlineAuthToken: authResponse.data.authToken,
      userEmail: decodedToken.userEmail,
      featuresToken: decodedToken.featuresToken,
    } as OfflineResponseLocals)
  }

  private handleAuthTokenValidationResponse(response: Response, authResponse: AxiosResponse) {
    const decodedToken = verify(authResponse.data.authToken, this.jwtSecret, {
      algorithms: ['HS256'],
    }) as CrossServiceTokenData

    Object.assign(response.locals, {
      authToken: authResponse.data.authToken,
      user: decodedToken.user,
      roles: decodedToken.roles,
    } as ResponseLocals)
  }
}
