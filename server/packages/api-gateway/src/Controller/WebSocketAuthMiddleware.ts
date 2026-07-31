import { CrossServiceTokenData } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import { inject, injectable } from 'inversify'
import { BaseMiddleware } from 'inversify-express-utils'
import { verify } from 'jsonwebtoken'
import { AxiosInstance } from 'axios'
import { Logger } from 'winston'

import { TYPES } from '../Bootstrap/Types'
import { ResponseLocals } from './ResponseLocals'
import {
  PublicServiceFailure,
  publicHttpErrorStatus,
  safePublicErrorData,
  safeHttpErrorLogMetadata,
} from '../Service/Logging/SafeLog'

@injectable()
export class WebSocketAuthMiddleware extends BaseMiddleware {
  constructor(
    @inject(TYPES.ApiGateway_HTTPClient) private httpClient: AxiosInstance,
    @inject(TYPES.ApiGateway_AUTH_SERVER_URL) private authServerUrl: string,
    @inject(TYPES.ApiGateway_AUTH_JWT_SECRET) private jwtSecret: string,
    @inject(TYPES.ApiGateway_Logger) private logger: Logger,
  ) {
    super()
  }

  async handler(request: Request, response: Response, next: NextFunction): Promise<void> {
    const authHeaderValue = request.headers.authorization as string

    if (!authHeaderValue) {
      response.status(401).send({
        error: {
          tag: 'invalid-auth',
          message: 'Invalid login credentials.',
        },
      })

      return
    }

    try {
      const authResponse = await this.httpClient.request({
        method: 'POST',
        headers: {
          Authorization: authHeaderValue,
          Accept: 'application/json',
        },
        validateStatus: (status: number) => {
          return status >= 200 && status < 500
        },
        url: `${this.authServerUrl}/sockets/tokens/validate`,
      })

      if (authResponse.status > 200) {
        const status = authResponse.status >= 400 && authResponse.status <= 599 ? authResponse.status : 500
        const contentType = authResponse.headers['content-type']
        if (typeof contentType === 'string' && contentType.trim().length > 0) {
          response.setHeader('content-type', contentType)
        }
        response.status(status).send(safePublicErrorData(authResponse.data))

        return
      }

      const crossServiceToken = authResponse.data.authToken

      const decodedToken = verify(crossServiceToken, this.jwtSecret, { algorithms: ['HS256'] }) as CrossServiceTokenData

      Object.assign(response.locals, {
        authToken: crossServiceToken,
        user: decodedToken.user,
        session: decodedToken.session,
        roles: decodedToken.roles,
      } as ResponseLocals)
    } catch (error) {
      const safeError = safeHttpErrorLogMetadata(error, {
        action: 'websocket-token.validate',
        endpoint: `${this.authServerUrl}/sockets/tokens/validate`,
        method: 'POST',
      })
      this.logger.error('Could not validate websocket token on underlying service.', safeError)
      this.logger.debug('Websocket token validation failure summary.', safeError)

      response.status(publicHttpErrorStatus(error)).send(PublicServiceFailure)

      return
    }

    return next()
  }
}
