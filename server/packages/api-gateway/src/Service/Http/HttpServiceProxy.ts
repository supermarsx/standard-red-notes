import { AxiosInstance, AxiosError, AxiosResponse, Method } from 'axios'
import { Request, Response } from 'express'
import { inject, injectable, optional } from 'inversify'
import { Logger } from 'winston'

import { TYPES } from '../../Bootstrap/Types'
import { CrossServiceTokenCacheInterface } from '../Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { TimerInterface } from '@standardnotes/time'
import { ResponseLocals } from '../../Controller/ResponseLocals'
import { OfflineResponseLocals } from '../../Controller/OfflineResponseLocals'
import { resolveClientIpFromRequest } from '../../Controller/ClientIp'

@injectable()
export class HttpServiceProxy implements ServiceProxyInterface {
  constructor(
    @inject(TYPES.ApiGateway_HTTPClient) private httpClient: AxiosInstance,
    @inject(TYPES.ApiGateway_AUTH_SERVER_URL) private authServerUrl: string,
    @inject(TYPES.ApiGateway_SYNCING_SERVER_JS_URL) private syncingServerJsUrl: string,
    @inject(TYPES.ApiGateway_PAYMENTS_SERVER_URL) private paymentsServerUrl: string,
    @inject(TYPES.ApiGateway_FILES_SERVER_URL) private filesServerUrl: string,
    @inject(TYPES.ApiGateway_WEB_SOCKET_SERVER_URL) private webSocketServerUrl: string,
    @inject(TYPES.ApiGateway_REVISIONS_SERVER_URL) private revisionsServerUrl: string,
    @inject(TYPES.ApiGateway_EMAIL_SERVER_URL) private emailServerUrl: string,
    @inject(TYPES.ApiGateway_HTTP_CALL_TIMEOUT) private httpCallTimeout: number,
    @inject(TYPES.ApiGateway_CrossServiceTokenCache) private crossServiceTokenCache: CrossServiceTokenCacheInterface,
    @inject(TYPES.ApiGateway_Logger) private logger: Logger,
    @inject(TYPES.ApiGateway_Timer) private timer: TimerInterface,
    // Standard Red Notes: optional trusted client-IP header name (CLIENT_IP_HEADER;
    // empty = off), threaded into the canonical resolver used to set x-origin-ip.
    @inject(TYPES.ApiGateway_CLIENT_IP_HEADER) @optional() private clientIpHeader: string = '',
  ) {}

  async validateSession(dto: {
    headers: {
      authorization: string
      sharedVaultOwnerContext?: string
    }
    requestMetadata: {
      url: string
      method: string
      snjs?: string
      application?: string
      userAgent?: string
      secChUa?: string
      ip?: string
    }
    cookies?: Map<string, string[]>
    retryAttempt?: number
  }): Promise<{
    status: number
    data: unknown
    headers: {
      contentType: string
    }
  }> {
    try {
      let stringOfCookies = ''
      for (const cookieName of dto.cookies?.keys() ?? []) {
        for (const cookieValue of dto.cookies?.get(cookieName) as string[]) {
          stringOfCookies += `${cookieName}=${cookieValue}; `
        }
      }

      const authResponse = await this.httpClient.request({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Cookie: stringOfCookies.trim(),
          'x-snjs-version': dto.requestMetadata.snjs,
          'x-application-version': dto.requestMetadata.application,
          'x-origin-user-agent': dto.requestMetadata.userAgent,
          'x-origin-sec-ch-ua': dto.requestMetadata.secChUa,
          'x-origin-ip': dto.requestMetadata.ip,
          'x-origin-url': dto.requestMetadata.url,
          'x-origin-method': dto.requestMetadata.method,
        },
        data: {
          authTokenFromHeaders: dto.headers.authorization,
          sharedVaultOwnerContext: dto.headers.sharedVaultOwnerContext,
        },
        validateStatus: (status: number) => {
          return status >= 200 && status < 500
        },
        url: `${this.authServerUrl}/sessions/validate`,
      })

      return {
        status: authResponse.status,
        data: authResponse.data,
        headers: {
          contentType: authResponse.headers['content-type'] as string,
        },
      }
    } catch (error) {
      const requestDidNotMakeIt = this.requestTimedOutOrDidNotReachDestination(error as Record<string, unknown>)
      const currentAttempt = dto.retryAttempt ?? 0
      const tooManyRetryAttempts = currentAttempt > 2
      if (!tooManyRetryAttempts && requestDidNotMakeIt) {
        // Standard Red Notes: bounded exponential backoff (base 100ms, capped at
        // 5s) with light jitter instead of a fixed 50ms delay, so a brief auth
        // blip self-heals without retrying in lock-step. Attempt cap unchanged.
        const backoffMs = Math.min(100 * 2 ** currentAttempt, 5000)
        const jitterMs = Math.floor(Math.random() * 50)
        await this.timer.sleep(backoffMs + jitterMs)

        const nextRetryAttempt = currentAttempt + 1

        return this.validateSession({
          headers: dto.headers,
          cookies: dto.cookies,
          requestMetadata: dto.requestMetadata,
          retryAttempt: nextRetryAttempt,
        })
      }

      throw error
    }
  }

  async callSyncingServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    await this.callServer(this.syncingServerJsUrl, request, response, endpoint, payload)
  }

  async callRevisionsServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    if (!this.revisionsServerUrl) {
      response.status(400).send({ message: 'Revisions Server not configured' })

      return
    }
    await this.callServer(this.revisionsServerUrl, request, response, endpoint, payload)
  }

  async callLegacySyncingServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    await this.callServerWithLegacyFormat(this.syncingServerJsUrl, request, response, endpoint, payload)
  }

  async callAuthServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    await this.callServer(this.authServerUrl, request, response, endpoint, payload)
  }

  async callEmailServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    if (!this.emailServerUrl) {
      response.status(400).send({ message: 'Email Server not configured' })

      return
    }

    await this.callServer(this.emailServerUrl, request, response, endpoint, payload)
  }

  async callWebSocketServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    if (!this.webSocketServerUrl) {
      this.logger.debug('Websockets Server URL not defined. Skipped request to WebSockets API.')

      return
    }

    const isARequestComingFromApiGatewayAndShouldBeKeptInMinimalFormat = request.headers.connectionid !== undefined
    if (isARequestComingFromApiGatewayAndShouldBeKeptInMinimalFormat) {
      await this.callServerWithLegacyFormat(this.webSocketServerUrl, request, response, endpoint, payload)
    } else {
      await this.callServer(this.webSocketServerUrl, request, response, endpoint, payload)
    }
  }

  async callPaymentsServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void | Response<unknown, Record<string, unknown>>> {
    if (!this.paymentsServerUrl) {
      this.logger.debug('Payments Server URL not defined. Skipped request to Payments API.')

      return
    }

    await this.callServerWithLegacyFormat(this.paymentsServerUrl, request, response, endpoint, payload)
  }

  async callAuthServerWithLegacyFormat(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    await this.callServerWithLegacyFormat(this.authServerUrl, request, response, endpoint, payload)
  }

  private async getServerResponse(
    serverUrl: string,
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<AxiosResponse | undefined> {
    const locals = response.locals as ResponseLocals | OfflineResponseLocals

    try {
      const headers: Record<string, string> = {}
      for (const headerName of Object.keys(request.headers)) {
        headers[headerName] = request.headers[headerName] as string
      }

      headers['x-origin-url'] = request.url
      headers['x-origin-method'] = request.method
      headers['x-snjs-version'] = request.headers['x-snjs-version'] as string
      headers['x-application-version'] = request.headers['x-application-version'] as string
      headers['x-origin-user-agent'] = request.headers['user-agent'] as string
      headers['x-origin-sec-ch-ua'] = request.headers['sec-ch-ua'] as string
      headers['x-origin-ip'] = this.clientIpFromRequest(request)

      delete headers.host
      delete headers['content-length']

      headers.cookie = request.headers.cookie as string

      if ('authToken' in locals && locals.authToken) {
        headers['X-Auth-Token'] = locals.authToken
      }

      if ('offlineAuthToken' in locals && locals.offlineAuthToken) {
        headers['X-Auth-Offline-Token'] = locals.offlineAuthToken
      }

      const serviceResponse = await this.httpClient.request({
        method: request.method as Method,
        headers,
        url: `${serverUrl}/${endpoint}`,
        data: this.getRequestData(payload),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        params: request.query,
        timeout: this.httpCallTimeout,
        validateStatus: (status: number) => {
          return status >= 200 && status < 500
        },
      })

      if (serviceResponse.headers['x-invalidate-cache']) {
        const userUuid = serviceResponse.headers['x-invalidate-cache']
        await this.crossServiceTokenCache.invalidate(userUuid)
      }

      return serviceResponse
    } catch (error) {
      let detailedErrorMessage = (error as Error).message
      if (error instanceof AxiosError) {
        detailedErrorMessage = `Status: ${error.status}, code: ${error.code}, message: ${error.message}`
      }

      this.logger.error(
        `Could not pass the request to ${serverUrl}/${endpoint} on underlying service: ${detailedErrorMessage}`,
        {
          userId: (locals as ResponseLocals).user ? (locals as ResponseLocals).user.uuid : undefined,
        },
      )

      this.logger.debug(`Response error: ${JSON.stringify(error)}`)

      if ((error as AxiosError).response?.headers['content-type']) {
        response.setHeader('content-type', (error as AxiosError).response?.headers['content-type'] as string)
      }

      const errorCode =
        (error as AxiosError).isAxiosError && !isNaN(+((error as AxiosError).code as string))
          ? +((error as AxiosError).code as string)
          : 500

      const responseErrorMessage = (error as AxiosError).response?.data

      response
        .status(errorCode)
        .send(
          responseErrorMessage ??
            "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
        )
    }

    return
  }

  private async callServer(
    serverUrl: string,
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const locals = response.locals as ResponseLocals
    const serviceResponse = await this.getServerResponse(serverUrl, request, response, endpoint, payload)

    if (!serviceResponse) {
      return
    }

    this.applyResponseHeaders(serviceResponse, response)

    if (this.responseShouldNotBeDecorated(serviceResponse)) {
      response.status(serviceResponse.status).send(serviceResponse.data)

      return
    }

    response.status(serviceResponse.status).send({
      meta: {
        auth: {
          userUuid: locals.user?.uuid,
          roles: locals.roles,
        },
        server: {
          filesServerUrl: this.filesServerUrl,
        },
      },
      data: serviceResponse.data,
    })
  }

  private async callServerWithLegacyFormat(
    serverUrl: string,
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void | Response<unknown, Record<string, unknown>>> {
    const serviceResponse = await this.getServerResponse(serverUrl, request, response, endpoint, payload)

    if (!serviceResponse) {
      return
    }

    this.applyResponseHeaders(serviceResponse, response)

    if (serviceResponse.request._redirectable._redirectCount > 0) {
      response.status(302)

      response.redirect(serviceResponse.request.res.responseUrl)
    } else {
      response.status(serviceResponse.status)

      response.send(serviceResponse.data)
    }
  }

  private clientIpFromRequest(request: Request): string {
    // Standard Red Notes: was reading the RAW leftmost X-Forwarded-For here, which a
    // direct client can spoof — letting them forge the IP recorded on their session.
    // Now routed through THE canonical resolver so x-origin-ip (which auth persists as
    // the session/security IP) honors TRUST_PROXY + CLIENT_IP_HEADER and matches the
    // rate limiter / ACL / workflows audit exactly.
    return resolveClientIpFromRequest(request, this.clientIpHeader)
  }

  private getRequestData(
    payload: Record<string, unknown> | string | undefined,
  ): Record<string, unknown> | string | undefined {
    if (
      payload === '' ||
      payload === null ||
      payload === undefined ||
      (typeof payload === 'object' && Object.keys(payload).length === 0)
    ) {
      return undefined
    }

    return payload
  }

  private responseShouldNotBeDecorated(serviceResponse: AxiosResponse): boolean {
    const contentType = serviceResponse.headers['content-type']
    return typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')
  }

  private applyResponseHeaders(serviceResponse: AxiosResponse, response: Response): void {
    const returnedHeadersFromUnderlyingService = [
      'content-type',
      'authorization',
      'set-cookie',
      'access-control-expose-headers',
      'x-captcha-required',
    ]

    returnedHeadersFromUnderlyingService.map((headerName) => {
      const headerValue = serviceResponse.headers[headerName]
      if (headerValue) {
        response.setHeader(headerName, headerValue)
      }
    })
  }

  private requestTimedOutOrDidNotReachDestination(error: Record<string, unknown>): boolean {
    return (
      ('code' in error && error.code === 'ETIMEDOUT') ||
      ('response' in error &&
        'status' in (error.response as Record<string, unknown>) &&
        [503, 504].includes((error.response as Record<string, unknown>).status as number))
    )
  }
}
