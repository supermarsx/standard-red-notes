import { AxiosInstance, AxiosResponse, Method } from 'axios'
import { Request, Response } from 'express'
import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'
import { Cookie, IAuthClient, RequestValidationOptions, SessionValidationResponse } from '@standardnotes/grpc'
import * as grpc from '@grpc/grpc-js'

import { CrossServiceTokenCacheInterface } from '../Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { GRPCSyncingServerServiceProxy } from './GRPCSyncingServerServiceProxy'
import { webSocketGatewayAccessService } from '../Sync/SyncWebSocketRuntime'
import { ResponseLocals } from '../../Controller/ResponseLocals'
import { OfflineResponseLocals } from '../../Controller/OfflineResponseLocals'
import {
  PublicServiceFailure,
  publicHttpErrorStatus,
  safeErrorLogMetadata,
  safeHttpErrorLogMetadata,
  sanitizeUrlForSafeLog,
} from '../Logging/SafeLog'
import {
  classifyGrpcFailure,
  GRPC_FALLBACK_REFUSAL_STATUS,
  grpcFallbackRefusal,
  mayFallBackToHttp,
  syncPayloadWritesNothing,
  type GrpcCallReplaySafety,
  type GrpcFailureClass,
} from './GrpcTransportFallback'
import { grpcTransportFallbackDiagnostics } from './GrpcTransportFallbackDiagnostics'

/** The shape `ServiceProxyInterface.validateSession` is declared with. */
type SessionValidationRequest = {
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
}

type SessionValidationResult = {
  status: number
  data: unknown
  headers: {
    contentType: string
  }
}

export class GRPCServiceProxy implements ServiceProxyInterface {
  constructor(
    private httpClient: AxiosInstance,
    private authServerUrl: string,
    private syncingServerJsUrl: string,
    private paymentsServerUrl: string,
    private filesServerUrl: string,
    private webSocketServerUrl: string,
    private revisionsServerUrl: string,
    private emailServerUrl: string,
    private httpCallTimeout: number,
    private crossServiceTokenCache: CrossServiceTokenCacheInterface,
    private logger: Logger,
    private timer: TimerInterface,
    private authClient: IAuthClient,
    private gRPCSyncingServerServiceProxy: GRPCSyncingServerServiceProxy,
  ) {}

  async validateSession(dto: SessionValidationRequest): Promise<SessionValidationResult> {
    const promise = new Promise((resolve, reject) => {
      try {
        const request = new RequestValidationOptions()
        request.setBearerToken(dto.headers.authorization)

        for (const cookieName of dto.cookies?.keys() ?? []) {
          for (const cookieValue of dto.cookies?.get(cookieName) as string[]) {
            const cookie = new Cookie()
            cookie.setName(cookieName)
            cookie.setValue(cookieValue)

            request.addCookie(cookie)
          }
        }
        if (dto.headers.sharedVaultOwnerContext) {
          request.setSharedVaultOwnerContext(dto.headers.sharedVaultOwnerContext)
        }

        this.logger.debug('[GRPCServiceProxy] Validating session via gRPC')

        const metadata = new grpc.Metadata()
        metadata.set('x-snjs-version', dto.requestMetadata.snjs as string)
        metadata.set('x-application-version', dto.requestMetadata.application as string)
        metadata.set('x-origin-user-agent', dto.requestMetadata.userAgent as string)
        metadata.set('x-origin-sec-ch-ua', dto.requestMetadata.secChUa as string)
        if (dto.requestMetadata.ip) {
          metadata.set('x-origin-ip', dto.requestMetadata.ip)
        }
        metadata.set('x-origin-url', dto.requestMetadata.url)
        metadata.set('x-origin-method', dto.requestMetadata.method)

        this.authClient.validate(
          request,
          metadata,
          (error: grpc.ServiceError | null, response: SessionValidationResponse) => {
            if (error) {
              const responseCode = error.metadata.get('x-auth-error-response-code').pop()
              if (responseCode) {
                return resolve({
                  status: +responseCode,
                  data: {
                    error: {
                      message: error.metadata.get('x-auth-error-message').pop(),
                      tag: error.metadata.get('x-auth-error-tag').pop(),
                    },
                  },
                  headers: {
                    contentType: 'application/json',
                  },
                })
              }

              return reject(error)
            }

            return resolve({
              status: 200,
              data: {
                authToken: response.getCrossServiceToken(),
              },
              headers: {
                contentType: 'application/json',
              },
            })
          },
        )
      } catch (error) {
        return reject(error)
      }
    })

    try {
      const result = await promise

      if (dto.retryAttempt) {
        this.logger.info(`Request to Auth Server succeeded after ${dto.retryAttempt} retries`)
      }

      return result as SessionValidationResult
    } catch (error) {
      const failure = classifyGrpcFailure(error)
      const requestDidNotMakeIt = failure === 'channel-unavailable'

      const tooManyRetryAttempts = dto.retryAttempt && dto.retryAttempt > 2
      if (!tooManyRetryAttempts && requestDidNotMakeIt) {
        await this.timer.sleep(50)

        const nextRetryAttempt = dto.retryAttempt ? dto.retryAttempt + 1 : 1

        this.logger.warn(`Retrying request to Auth Server for the ${nextRetryAttempt} time`)

        return this.validateSession({
          headers: dto.headers,
          cookies: dto.cookies,
          requestMetadata: dto.requestMetadata,
          retryAttempt: nextRetryAttempt,
        })
      }

      // Standard Red Notes: the gRPC auth transport is exhausted — degrade to
      // the HTTP transport this proxy already holds a client and a URL for,
      // rather than failing EVERY authenticated request on this gateway.
      //
      // Session validation is classified `read-only` and that is a fact about
      // the auth service, not an assumption: both transports terminate in the
      // same `AuthenticateRequest` use case, which issues a cross-service token
      // and writes nothing but last-write-wins session bookkeeping. A second
      // delivery therefore cannot double-apply anything. The eligible failure
      // CLASSES are still narrow — `GrpcTransportFallback` excludes
      // `Status.UNKNOWN`, which is the auth server's own catch-all and so means
      // the call arrived and the handler faulted, and excludes every deliberate
      // application answer.
      if (mayFallBackToHttp('read-only', failure)) {
        return await this.validateSessionOverHttpFallback(dto, failure, error)
      }

      grpcTransportFallbackDiagnostics.recordRefusal('session-validation', failure)
      this.logger.error('Session validation failed over gRPC and is not eligible for the HTTP transport.', {
        action: 'service-proxy.grpc-fallback-refused',
        lane: 'session-validation',
        failureClass: failure,
      })

      throw error
    }
  }

  /**
   * Serve one session validation over HTTP after the gRPC transport failed, and
   * make the degradation impossible to miss: counted in
   * `grpcTransportFallbackDiagnostics` (which the admin sync-diagnostics
   * payload reports, so `boundServiceProxy: 'grpc'` with a non-zero count reads
   * as "bound gRPC, serving HTTP") and logged at `error` on every occurrence.
   *
   * No sticky "gRPC is down" flag, deliberately: a latch would stop the gateway
   * ever returning to gRPC on its own and would make the degradation a
   * configuration state rather than a live symptom. The cost is that each
   * request pays the failed gRPC attempt (and its retry budget) first.
   *
   * When HTTP fails too, the ORIGINAL gRPC error is re-thrown. The HTTP failure
   * is logged separately — but the caller's contract and the primary
   * transport's diagnosis are what the operator needs to see at the top.
   */
  private async validateSessionOverHttpFallback(
    dto: SessionValidationRequest,
    failure: GrpcFailureClass,
    grpcError: unknown,
  ): Promise<SessionValidationResult> {
    grpcTransportFallbackDiagnostics.recordDegradation('session-validation', failure)
    this.logger.error('Auth gRPC transport failed; serving this session validation over HTTP instead.', {
      action: 'service-proxy.grpc-fallback',
      lane: 'session-validation',
      failureClass: failure,
      degradedCalls: grpcTransportFallbackDiagnostics.degradedCallsOn('session-validation'),
    })

    try {
      return await this.validateSessionOverHttp(dto)
    } catch (fallbackError) {
      this.logger.error('The HTTP fallback for session validation also failed; surfacing the gRPC failure.', {
        ...safeHttpErrorLogMetadata(fallbackError, {
          action: 'service-proxy.grpc-fallback-failed',
          endpoint: `${this.authServerUrl}/sessions/validate`,
          method: 'POST',
        }),
        lane: 'session-validation',
        failureClass: failure,
      })

      throw grpcError
    }
  }

  /**
   * The HTTP session-validation request, byte-for-byte the one
   * `HttpServiceProxy.validateSession` makes — same URL, headers, body shape and
   * `validateStatus` window — because a fallback that validates sessions
   * DIFFERENTLY from the deployment's own HTTP mode is not a fallback.
   *
   * It is a second copy rather than a shared helper because `HttpServiceProxy`
   * is an `@injectable` whose constructor wants the whole container. The copy is
   * guarded: `GRPCServiceProxy.spec.ts` drives both proxies against the same
   * stubbed Axios instance and asserts the two request configurations are equal,
   * so a change to either side fails that spec instead of drifting.
   *
   * Unlike `HttpServiceProxy` this makes exactly ONE attempt. The gRPC leg has
   * already spent its retry budget, and a second budget here would multiply the
   * latency of a request that is already late.
   */
  private async validateSessionOverHttp(dto: SessionValidationRequest): Promise<SessionValidationResult> {
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
  }

  async callSyncingServer(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const requestIsUsingLatestApiVersions =
      payload !== undefined && typeof payload !== 'string' && 'api' in payload && payload.api === '20200115'

    if (requestIsUsingLatestApiVersions && endpoint === 'items/sync') {
      await this.callSyncingServerGRPC(request, response, endpoint, payload)

      return
    }

    await this.callServer(this.syncingServerJsUrl, request, response, endpoint, payload)
  }

  private async callSyncingServerGRPC(
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const locals = response.locals as ResponseLocals

    let result: Awaited<ReturnType<GRPCSyncingServerServiceProxy['sync']>>

    // *** KEEP THIS try SCOPED TO THE gRPC CALL ALONE. ***
    // `classifyGrpcFailure` reads an error with no gRPC status code as
    // `never-dispatched`, which is only true of a throw from inside `sync()`'s
    // own request-building. Widening this try to cover the response writing
    // below would classify a send failure the same way — and a send failure
    // happens AFTER the sync was applied, so it would authorise re-delivering a
    // committed item write over HTTP.
    try {
      result = await this.gRPCSyncingServerServiceProxy.sync(request, response, payload)
    } catch (error) {
      await this.fallBackFromSyncGRPC(error, request, response, endpoint, payload)

      return
    }

    const command =
      result.data && typeof result.data === 'object' && 'command' in result.data
        ? (result.data.command as { status?: string } | undefined)
        : undefined
    if (command?.status) {
      response.setHeader('X-Sync-Command-Status', command.status)
      response.setHeader('X-Sync-Command-Replayed', result.replayed === true ? 'true' : 'false')
    }
    const syncError =
      result.data && typeof result.data === 'object' && 'error' in result.data
        ? (result.data.error as { code?: string } | undefined)
        : undefined
    if (syncError?.code === 'sync_command_pending') {
      response.setHeader('Retry-After', '1')
    }

    response.status(result.status).send({
      meta: {
        auth: {
          userUuid: locals.user?.uuid,
          roles: locals.roles,
        },
        server: {
          filesServerUrl: this.filesServerUrl,
        },
      },
      data: result.data,
    })
  }

  /**
   * Decide, for ONE failed `items/sync` gRPC attempt, whether the HTTP
   * transport may carry it — and then either do that or surface the failure.
   *
   * The response is untouched at this point: `sync()` rejects before
   * `callSyncingServerGRPC` sets a single header or sends a byte, so the HTTP
   * leg owns a pristine response.
   *
   * Refusing is a normal, correct outcome here, not a bug to be engineered
   * away. An un-deduplicated item write whose gRPC attempt failed AMBIGUOUSLY
   * (and `UNAVAILABLE` is ambiguous — the connection can drop after the request
   * bytes went out) must not be re-sent on a second transport: the save may
   * already be committed, and re-sending the same item hashes with their now
   * stale `updated_at` makes the syncing server answer with a sync conflict,
   * which the client turns into a duplicate "conflicted copy" note. Failing the
   * request is strictly better than silently duplicating a user's notes.
   *
   * HOW THE REFUSAL IS REPORTED, and why it is not a rethrow any more.
   *
   * Until now this method rethrew, and the thrown value reached Express's error
   * handler as any other fault would: a bare `500` with a generic body. Measured
   * live at `44c3c59b`, the refusal was therefore indistinguishable from every
   * other `500` — so the client could not tell it was looking at the one failure
   * this design expects it to recover from, and the safety argument for refusing
   * rested on a signal that was not on the wire.
   *
   * It now answers the SAME status with a closed-enum refusal body from
   * `grpcFallbackRefusal` — code, fixed copy, retryability, and nothing else. It
   * is written here rather than thrown because the response is pristine at this
   * point (see above) and because shaping it anywhere else would mean teaching a
   * generic error handler about this one case. The operator detail that the
   * error handler used to log is logged here instead, via
   * `safeErrorLogMetadata`, so surfacing less to the client costs the operator
   * nothing.
   */
  private async fallBackFromSyncGRPC(
    error: unknown,
    request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    const failure = classifyGrpcFailure(error)
    const replaySafety = this.syncReplaySafety(request, payload)
    const userId = (response.locals as ResponseLocals).user?.uuid

    if (!mayFallBackToHttp(replaySafety, failure)) {
      const refusal = grpcFallbackRefusal(replaySafety)

      grpcTransportFallbackDiagnostics.recordRefusal('items-sync', failure)
      this.logger.error('Item sync failed over gRPC and must NOT be re-delivered over HTTP; surfacing the failure.', {
        action: 'service-proxy.grpc-fallback-refused',
        lane: 'items-sync',
        failureClass: failure,
        replaySafety,
        refusalCode: refusal.error.code,
        userId,
        ...safeErrorLogMetadata(error),
      })

      response.status(GRPC_FALLBACK_REFUSAL_STATUS).send(refusal)

      return
    }

    grpcTransportFallbackDiagnostics.recordDegradation('items-sync', failure)
    this.logger.error('Syncing gRPC transport failed; serving this item sync over HTTP instead.', {
      action: 'service-proxy.grpc-fallback',
      lane: 'items-sync',
      failureClass: failure,
      replaySafety,
      degradedCalls: grpcTransportFallbackDiagnostics.degradedCallsOn('items-sync'),
      userId,
    })

    await this.callServer(this.syncingServerJsUrl, request, response, endpoint, payload)
  }

  /**
   * What a SECOND delivery of this `items/sync` would do. Order matters: a
   * durable command key is checked first, because such a call writes but is
   * deduplicated, and only a call with no key at all falls through to the
   * payload inspection.
   *
   * A `command` that is present but NOT replay-safe (malformed, or a digest
   * that disagrees with the body) lands on `non-idempotent-mutation`: the
   * read-only allow-list in `syncPayloadWritesNothing` does not contain
   * `command`, so a broken key can never be mistaken for a plain read.
   */
  private syncReplaySafety(request: Request, payload?: Record<string, unknown> | string): GrpcCallReplaySafety {
    if (this.gRPCSyncingServerServiceProxy.durableCommandReplayKeyPresent(request, payload)) {
      return 'idempotent-mutation'
    }

    return syncPayloadWritesNothing(payload) ? 'read-only' : 'non-idempotent-mutation'
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
    // Standard Red Notes (R4): mint against the IN-PROCESS gateway first — see
    // HttpServiceProxy.callWebSocketServer for why the loopback self-call was
    // wrong. The loopback path survives only for a genuinely separate websockets
    // host; with nothing attached and no URL the caller now gets an answer.
    const minted = webSocketGatewayAccessService.mintConnectionTokenFor(response.locals as ResponseLocals)
    if (minted) {
      this.sendDecorated(response, minted.statusCode, minted.json)

      return
    }

    if (!this.webSocketServerUrl) {
      this.logger.debug('Websockets Server URL not defined and no in-process gateway attached; refusing request.')
      response.status(503).send({ error: { message: 'Websockets server is not available.' } })

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
    retryAttempt?: number,
  ): Promise<AxiosResponse | undefined> {
    const locals = response.locals as ResponseLocals | OfflineResponseLocals

    try {
      const headers: Record<string, string> = {}
      for (const headerName of Object.keys(request.headers)) {
        headers[headerName] = request.headers[headerName] as string
      }

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

      if (retryAttempt) {
        this.logger.debug('Underlying service request succeeded after retry.', {
          endpoint: sanitizeUrlForSafeLog(`${serverUrl}/${endpoint}`),
          retryAttempt,
        })
      }

      return serviceResponse
    } catch (error) {
      const requestDidNotMakeIt = this.requestTimedOutOrDidNotReachDestination(error as Record<string, unknown>)
      const tooManyRetryAttempts = retryAttempt && retryAttempt > 2
      if (!tooManyRetryAttempts && requestDidNotMakeIt) {
        await this.timer.sleep(50)

        const nextRetryAttempt = retryAttempt ? retryAttempt + 1 : 1

        this.logger.debug('Retrying underlying service request.', {
          endpoint: sanitizeUrlForSafeLog(`${serverUrl}/${endpoint}`),
          retryAttempt: nextRetryAttempt,
        })

        return this.getServerResponse(serverUrl, request, response, endpoint, payload, nextRetryAttempt)
      }

      const safeError = safeHttpErrorLogMetadata(error, {
        action: tooManyRetryAttempts ? 'service-proxy.retry-exhausted' : 'service-proxy.request',
        endpoint: `${serverUrl}/${endpoint}`,
        method: request.method,
        userId: (locals as ResponseLocals).user ? (locals as ResponseLocals).user.uuid : undefined,
      })
      this.logger.error(
        tooManyRetryAttempts
          ? 'Request to underlying service exhausted its retry budget.'
          : 'Could not complete request on underlying service.',
        {
          ...safeError,
          retryAttempt: tooManyRetryAttempts ? retryAttempt : undefined,
        },
      )
      this.logger.debug('Underlying service failure summary.', safeError)

      response.status(publicHttpErrorStatus(error)).send(PublicServiceFailure)
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
    const serviceResponse = await this.getServerResponse(serverUrl, request, response, endpoint, payload)

    if (!serviceResponse) {
      return
    }

    this.applyResponseHeaders(serviceResponse, response)

    if (this.responseShouldNotBeDecorated(serviceResponse)) {
      response.status(serviceResponse.status).send(serviceResponse.data)

      return
    }

    this.sendDecorated(response, serviceResponse.status, serviceResponse.data)
  }

  /** The gateway's standard response envelope: auth + server metadata around the service's payload. */
  private sendDecorated(response: Response, status: number, data: unknown): void {
    const locals = response.locals as ResponseLocals

    response.status(status).send({
      meta: {
        auth: {
          userUuid: locals.user?.uuid,
          roles: locals.roles,
        },
        server: {
          filesServerUrl: this.filesServerUrl,
        },
      },
      data,
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
      'x-sync-command-status',
      'x-sync-command-replayed',
      'retry-after',
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
