import 'reflect-metadata'

import { AxiosError, AxiosInstance } from 'axios'
import { Request, Response } from 'express'
import { IAuthClient } from '@standardnotes/grpc'
import { Status } from '@grpc/grpc-js/build/src/constants'

import { CrossServiceTokenCacheInterface } from '../Cache/CrossServiceTokenCacheInterface'
import { GRPCServiceProxy } from './GRPCServiceProxy'
import { GRPCSyncingServerServiceProxy } from './GRPCSyncingServerServiceProxy'

describe('GRPCServiceProxy', () => {
  let httpClient: AxiosInstance
  let crossServiceTokenCache: CrossServiceTokenCacheInterface
  let logger: { error: jest.Mock; debug: jest.Mock; info: jest.Mock; warn: jest.Mock }
  let timer: { sleep: jest.Mock }
  let authClient: IAuthClient
  let syncingServerProxy: GRPCSyncingServerServiceProxy

  let send: jest.Mock
  let status: jest.Mock
  let setHeader: jest.Mock
  let redirect: jest.Mock

  const urls = {
    auth: 'http://auth',
    syncing: 'http://syncing',
    payments: 'http://payments',
    files: 'http://files',
    ws: 'http://ws',
    revisions: 'http://revisions',
    email: 'http://email',
  }

  const buildProxy = (overrides: Partial<typeof urls> = {}): GRPCServiceProxy => {
    const u = { ...urls, ...overrides }
    return new GRPCServiceProxy(
      httpClient,
      u.auth,
      u.syncing,
      u.payments,
      u.files,
      u.ws,
      u.revisions,
      u.email,
      1000,
      crossServiceTokenCache,
      logger as never,
      timer as never,
      authClient,
      syncingServerProxy,
    )
  }

  const buildRequest = (overrides: Partial<Request> = {}): Request =>
    ({
      method: 'POST',
      url: '/v1/items',
      headers: {},
      query: {},
      socket: { remoteAddress: '1.1.1.1' },
      ...overrides,
    }) as unknown as Request

  const buildResponse = (locals: Record<string, unknown> = {}): Response =>
    ({ locals, setHeader, status, send, redirect }) as unknown as Response

  const serviceResponse = (overrides: Record<string, unknown> = {}) => ({
    status: 200,
    data: { ok: true },
    headers: { 'content-type': 'application/json' },
    request: { _redirectable: { _redirectCount: 0 }, res: { responseUrl: 'http://final' } },
    ...overrides,
  })

  const sentConfig = () => (httpClient.request as jest.Mock).mock.calls[0][0]

  /** The grpc ServiceError shape the proxy reads error details from. */
  const grpcError = (entries: Record<string, string[]>, extra: Record<string, unknown> = {}) =>
    ({ metadata: { get: (key: string) => entries[key] ?? [] }, ...extra }) as never

  beforeEach(() => {
    httpClient = { request: jest.fn().mockResolvedValue(serviceResponse()) } as unknown as AxiosInstance
    crossServiceTokenCache = {
      get: jest.fn(),
      set: jest.fn(),
      invalidate: jest.fn(),
    } as unknown as CrossServiceTokenCacheInterface
    logger = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() }
    timer = { sleep: jest.fn().mockResolvedValue(undefined) }

    authClient = {
      validate: jest.fn((_request, _metadata, callback) => {
        callback(null, { getCrossServiceToken: () => 'cross-service-token' })
      }),
    } as unknown as IAuthClient

    syncingServerProxy = {
      sync: jest.fn().mockResolvedValue({ status: 200, data: { retrieved_items: [] } }),
    } as unknown as GRPCSyncingServerServiceProxy

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
    setHeader = jest.fn()
    redirect = jest.fn()
  })

  describe('validateSession', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      headers: { authorization: 'token' },
      requestMetadata: { url: '/items/sync', method: 'POST', snjs: '2.1.0', application: '3.4.5', ip: '2.2.2.2' },
      ...overrides,
    })

    const sentRequest = () => (authClient.validate as jest.Mock).mock.calls[0][0]
    const sentMetadata = () => (authClient.validate as jest.Mock).mock.calls[0][1]

    it('returns the cross service token issued by the auth service', async () => {
      const result = await buildProxy().validateSession(dto())

      expect(result).toEqual({
        status: 200,
        data: { authToken: 'cross-service-token' },
        headers: { contentType: 'application/json' },
      })
    })

    it('sends the bearer token on the validation request', async () => {
      await buildProxy().validateSession(dto())

      expect(sentRequest().getBearerToken()).toBe('token')
    })

    it('carries the client version and origin metadata on the gRPC call', async () => {
      await buildProxy().validateSession(dto())

      expect(sentMetadata().get('x-snjs-version')).toEqual(['2.1.0'])
      expect(sentMetadata().get('x-application-version')).toEqual(['3.4.5'])
      expect(sentMetadata().get('x-origin-ip')).toEqual(['2.2.2.2'])
      expect(sentMetadata().get('x-origin-url')).toEqual(['/items/sync'])
      expect(sentMetadata().get('x-origin-method')).toEqual(['POST'])
    })

    it('omits x-origin-ip entirely when the caller could not resolve an IP', async () => {
      await buildProxy().validateSession(dto({ requestMetadata: { url: '/u', method: 'GET' } }))

      expect(sentMetadata().get('x-origin-ip')).toEqual([])
    })

    it('translates every cookie value into its own Cookie message', async () => {
      await buildProxy().validateSession(
        dto({
          cookies: new Map([
            ['a', ['1', '3']],
            ['b', ['2']],
          ]),
        }),
      )

      const cookies = sentRequest().getCookieList()
      expect(
        cookies.map((c: { getName: () => string; getValue: () => string }) => [c.getName(), c.getValue()]),
      ).toEqual([
        ['a', '1'],
        ['a', '3'],
        ['b', '2'],
      ])
    })

    it('sets the shared vault owner context only when the caller supplied one', async () => {
      await buildProxy().validateSession(dto())
      expect(sentRequest().getSharedVaultOwnerContext()).toBe('')

      jest.clearAllMocks()
      await buildProxy().validateSession(dto({ headers: { authorization: 't', sharedVaultOwnerContext: 'owner-1' } }))
      expect(sentRequest().getSharedVaultOwnerContext()).toBe('owner-1')
    })

    it('maps an auth error carrying a response code into that HTTP status and body', async () => {
      ;(authClient.validate as jest.Mock).mockImplementation((_r, _m, callback) => {
        callback(
          grpcError({
            'x-auth-error-response-code': ['401'],
            'x-auth-error-message': ['Invalid login credentials.'],
            'x-auth-error-tag': ['invalid-auth'],
          }),
          undefined,
        )
      })

      const result = await buildProxy().validateSession(dto())

      expect(result).toEqual({
        status: 401,
        data: { error: { message: 'Invalid login credentials.', tag: 'invalid-auth' } },
        headers: { contentType: 'application/json' },
      })
    })

    it('rethrows an auth error with no response code metadata', async () => {
      ;(authClient.validate as jest.Mock).mockImplementation((_r, _m, callback) => {
        callback(grpcError({}, { message: 'internal' }), undefined)
      })

      await expect(buildProxy().validateSession(dto())).rejects.toMatchObject({ message: 'internal' })
    })

    it('rejects when the auth client throws synchronously', async () => {
      ;(authClient.validate as jest.Mock).mockImplementation(() => {
        throw new Error('channel closed')
      })

      await expect(buildProxy().validateSession(dto())).rejects.toThrow('channel closed')
    })

    it('retries an UNAVAILABLE auth service and succeeds on the retry', async () => {
      ;(authClient.validate as jest.Mock)
        .mockImplementationOnce((_r, _m, callback) => {
          callback(grpcError({}, { code: Status.UNAVAILABLE }), undefined)
        })
        .mockImplementationOnce((_r, _m, callback) => {
          callback(null, { getCrossServiceToken: () => 'retried-token' })
        })

      const result = await buildProxy().validateSession(dto())

      expect(timer.sleep).toHaveBeenCalledWith(50)
      expect(result.data).toEqual({ authToken: 'retried-token' })
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('after 1 retries'))
    })

    it('gives up on a persistently UNAVAILABLE auth service after 3 retries', async () => {
      ;(authClient.validate as jest.Mock).mockImplementation((_r, _m, callback) => {
        callback(grpcError({}, { code: Status.UNAVAILABLE }), undefined)
      })

      await expect(buildProxy().validateSession(dto())).rejects.toMatchObject({ code: Status.UNAVAILABLE })
      expect(authClient.validate).toHaveBeenCalledTimes(4)
      expect(timer.sleep).toHaveBeenCalledTimes(3)
    })

    it('does NOT retry an error that is not UNAVAILABLE', async () => {
      ;(authClient.validate as jest.Mock).mockImplementation((_r, _m, callback) => {
        callback(grpcError({}, { code: Status.PERMISSION_DENIED }), undefined)
      })

      await expect(buildProxy().validateSession(dto())).rejects.toBeDefined()
      expect(authClient.validate).toHaveBeenCalledTimes(1)
      expect(timer.sleep).not.toHaveBeenCalled()
    })
  })

  describe('syncing server routing', () => {
    it('routes an api=20200115 items/sync over gRPC instead of HTTP', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse({ user: { uuid: 'u-1' } }), 'items/sync', {
        api: '20200115',
      })

      expect(syncingServerProxy.sync).toHaveBeenCalled()
      expect(httpClient.request).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith({
        meta: { auth: { userUuid: 'u-1', roles: undefined }, server: { filesServerUrl: 'http://files' } },
        data: { retrieved_items: [] },
      })
    })

    it('falls back to HTTP for items/sync on an older api version', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items/sync', { api: '20190520' })

      expect(syncingServerProxy.sync).not.toHaveBeenCalled()
      expect(sentConfig().url).toBe('http://syncing/items/sync')
    })

    it('falls back to HTTP for a non-sync endpoint even on the latest api version', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items/check', { api: '20200115' })

      expect(syncingServerProxy.sync).not.toHaveBeenCalled()
      expect(sentConfig().url).toBe('http://syncing/items/check')
    })

    it('falls back to HTTP when the payload is a raw string or absent', async () => {
      for (const payload of ['raw-body', undefined]) {
        jest.clearAllMocks()
        await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items/sync', payload as never)
        expect(syncingServerProxy.sync).not.toHaveBeenCalled()
      }
    })

    it('propagates the status the gRPC sync returned', async () => {
      ;(syncingServerProxy.sync as jest.Mock).mockResolvedValue({ status: 207, data: {} })

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items/sync', { api: '20200115' })

      expect(status).toHaveBeenCalledWith(207)
    })
  })

  describe('outgoing HTTP request construction', () => {
    it('strips host and content-length but keeps the other client headers', async () => {
      await buildProxy().callAuthServer(
        buildRequest({ headers: { host: 'gateway.example', 'content-length': '42', 'x-custom': 'kept' } as never }),
        buildResponse(),
        'sessions',
      )

      expect(sentConfig().headers.host).toBeUndefined()
      expect(sentConfig().headers['content-length']).toBeUndefined()
      expect(sentConfig().headers['x-custom']).toBe('kept')
    })

    it('attaches the cross service token or the offline token, never both', async () => {
      await buildProxy().callAuthServer(buildRequest(), buildResponse({ authToken: 'cst' }), 'sessions')
      expect(sentConfig().headers['X-Auth-Token']).toBe('cst')
      expect(sentConfig().headers['X-Auth-Offline-Token']).toBeUndefined()

      jest.clearAllMocks()
      await buildProxy().callAuthServer(buildRequest(), buildResponse({ offlineAuthToken: 'off' }), 'sessions')
      expect(sentConfig().headers['X-Auth-Offline-Token']).toBe('off')
      expect(sentConfig().headers['X-Auth-Token']).toBeUndefined()
    })

    it('drops an empty payload and forwards a non-empty one', async () => {
      for (const payload of ['', {}, undefined]) {
        jest.clearAllMocks()
        await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions', payload as never)
        expect(sentConfig().data).toBeUndefined()
      }

      jest.clearAllMocks()
      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions', { a: 1 })
      expect(sentConfig().data).toEqual({ a: 1 })
    })

    it('forwards the query string and applies the configured call timeout', async () => {
      await buildProxy().callAuthServer(buildRequest({ query: { page: '2' } as never }), buildResponse(), 'sessions')

      expect(sentConfig().params).toEqual({ page: '2' })
      expect(sentConfig().timeout).toBe(1000)
    })

    it('treats every status below 500 as non-throwing', async () => {
      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      const validateStatus = sentConfig().validateStatus as (s: number) => boolean
      expect(validateStatus(404)).toBe(true)
      expect(validateStatus(500)).toBe(false)
      expect(validateStatus(199)).toBe(false)
    })
  })

  describe('response handling', () => {
    it('decorates the service response with auth and server metadata', async () => {
      await buildProxy().callAuthServer(
        buildRequest(),
        buildResponse({ user: { uuid: 'u-1' }, roles: [{ name: 'CORE_USER' }] }),
        'sessions',
      )

      expect(send).toHaveBeenCalledWith({
        meta: {
          auth: { userUuid: 'u-1', roles: [{ name: 'CORE_USER' }] },
          server: { filesServerUrl: 'http://files' },
        },
        data: { ok: true },
      })
    })

    it('does NOT wrap an HTML response in the JSON envelope', async () => {
      ;(httpClient.request as jest.Mock).mockResolvedValue(
        serviceResponse({ data: '<html></html>', headers: { 'content-type': 'TEXT/HTML' } }),
      )

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(send).toHaveBeenCalledWith('<html></html>')
    })

    it('copies only the allow-listed headers back to the client', async () => {
      ;(httpClient.request as jest.Mock).mockResolvedValue(
        serviceResponse({
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer new',
            'set-cookie': ['a=1'],
            'access-control-expose-headers': 'authorization',
            'x-captcha-required': 'true',
            'x-secret-internal': 'leak',
          },
        }),
      )

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      const copied = setHeader.mock.calls.map((call) => call[0] as string)
      expect(copied).toEqual([
        'content-type',
        'authorization',
        'set-cookie',
        'access-control-expose-headers',
        'x-captcha-required',
      ])
      expect(copied).not.toContain('x-secret-internal')
    })

    it('invalidates the cross service token cache when the service asks it to', async () => {
      ;(httpClient.request as jest.Mock).mockResolvedValue(
        serviceResponse({ headers: { 'content-type': 'application/json', 'x-invalidate-cache': 'u-9' } }),
      )

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(crossServiceTokenCache.invalidate).toHaveBeenCalledWith('u-9')
    })
  })

  describe('legacy format', () => {
    it('sends the raw service body with no envelope', async () => {
      await buildProxy().callAuthServerWithLegacyFormat(buildRequest(), buildResponse(), 'sessions')

      expect(status).toHaveBeenCalledWith(200)
      expect(send).toHaveBeenCalledWith({ ok: true })
      expect(redirect).not.toHaveBeenCalled()
    })

    it('turns a followed redirect into a 302 to the final URL', async () => {
      ;(httpClient.request as jest.Mock).mockResolvedValue(
        serviceResponse({
          request: { _redirectable: { _redirectCount: 2 }, res: { responseUrl: 'http://final/target' } },
        }),
      )

      await buildProxy().callLegacySyncingServer(buildRequest(), buildResponse(), 'items')

      expect(status).toHaveBeenCalledWith(302)
      expect(redirect).toHaveBeenCalledWith('http://final/target')
    })
  })

  describe('per-service routing and configuration guards', () => {
    it('routes each helper at its own configured base URL', async () => {
      const cases: [string, string][] = [
        ['callAuthServer', 'http://auth/e'],
        ['callRevisionsServer', 'http://revisions/e'],
        ['callEmailServer', 'http://email/e'],
        ['callLegacySyncingServer', 'http://syncing/e'],
        ['callPaymentsServer', 'http://payments/e'],
        ['callAuthServerWithLegacyFormat', 'http://auth/e'],
      ]

      for (const [method, expectedUrl] of cases) {
        jest.clearAllMocks()
        const proxy = buildProxy() as unknown as Record<string, (...args: unknown[]) => Promise<void>>
        await proxy[method](buildRequest(), buildResponse(), 'e')
        expect(sentConfig().url).toBe(expectedUrl)
      }
    })

    it('rejects a revisions call with 400 when no revisions server is configured', async () => {
      await buildProxy({ revisions: '' }).callRevisionsServer(buildRequest(), buildResponse(), 'revisions')

      expect(status).toHaveBeenCalledWith(400)
      expect(send).toHaveBeenCalledWith({ message: 'Revisions Server not configured' })
      expect(httpClient.request).not.toHaveBeenCalled()
    })

    it('rejects an email call with 400 when no email server is configured', async () => {
      await buildProxy({ email: '' }).callEmailServer(buildRequest(), buildResponse(), 'send')

      expect(status).toHaveBeenCalledWith(400)
      expect(send).toHaveBeenCalledWith({ message: 'Email Server not configured' })
      expect(httpClient.request).not.toHaveBeenCalled()
    })

    it('silently skips websocket and payments calls when those servers are unconfigured', async () => {
      await buildProxy({ ws: '' }).callWebSocketServer(buildRequest(), buildResponse(), 'push')
      await buildProxy({ payments: '' }).callPaymentsServer(buildRequest(), buildResponse(), 'subscriptions')

      expect(httpClient.request).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('keeps a gateway-originated websocket call in the minimal legacy format', async () => {
      await buildProxy().callWebSocketServer(
        buildRequest({ headers: { connectionid: 'c-1' } as never }),
        buildResponse({ user: { uuid: 'u-1' } }),
        'push',
      )

      expect(send).toHaveBeenCalledWith({ ok: true })
    })

    it('decorates a client-originated websocket call', async () => {
      await buildProxy().callWebSocketServer(buildRequest(), buildResponse({ user: { uuid: 'u-1' } }), 'push')

      expect(send).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.anything(), data: { ok: true } }))
    })
  })

  describe('downstream error handling', () => {
    it('retries a timed-out downstream call and succeeds on the retry', async () => {
      ;(httpClient.request as jest.Mock)
        .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
        .mockResolvedValueOnce(serviceResponse())

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(httpClient.request).toHaveBeenCalledTimes(2)
      expect(timer.sleep).toHaveBeenCalledWith(50)
      expect(status).toHaveBeenCalledWith(200)
    })

    it('retries a 503 and a 504 from the downstream service', async () => {
      for (const responseStatus of [503, 504]) {
        jest.clearAllMocks()
        ;(httpClient.request as jest.Mock)
          .mockRejectedValueOnce({ response: { status: responseStatus } })
          .mockResolvedValueOnce(serviceResponse())

        await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

        expect(httpClient.request).toHaveBeenCalledTimes(2)
      }
    })

    it('gives up after 3 retries and reports the timeout to the client', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue({ code: 'ETIMEDOUT' })

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(httpClient.request).toHaveBeenCalledTimes(4)
      expect(logger.error).toHaveBeenCalledWith(
        'Request to underlying service exhausted its retry budget.',
        expect.objectContaining({
          action: 'service-proxy.retry-exhausted',
          retryAttempt: 3,
        }),
      )
      expect(status).toHaveBeenCalledWith(500)
    })

    it('does NOT retry an error that reached the destination', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(httpClient.request).toHaveBeenCalledTimes(1)
      expect(status).toHaveBeenCalledWith(500)
      expect(send).toHaveBeenCalledWith({
        error: {
          tag: 'service-unavailable',
          message: 'The requested service is temporarily unavailable.',
        },
      })
    })

    it('logs a sanitized target URL together with the acting user', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

      await buildProxy().callAuthServer(buildRequest(), buildResponse({ user: { uuid: 'u-1' } }), 'sessions')

      expect(logger.error).toHaveBeenCalledWith(
        'Could not complete request on underlying service.',
        expect.objectContaining({
          action: 'service-proxy.request',
          endpoint: 'http://auth/sessions',
          method: 'POST',
          userId: 'u-1',
        }),
      )
    })

    it('keeps an axios error body and content-type private while preserving an upstream 5xx status', async () => {
      const error = new AxiosError('Request failed', '502')
      error.response = {
        status: 502,
        data: { error: 'bad gateway' },
        headers: { 'content-type': 'application/problem+json' },
      } as never
      ;(httpClient.request as jest.Mock).mockRejectedValue(error)

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(setHeader).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(502)
      expect(send).toHaveBeenCalledWith({
        error: {
          tag: 'service-unavailable',
          message: 'The requested service is temporarily unavailable.',
        },
      })
    })

    it('never logs or returns auth, cookie, query, body, message, or circular axios data', async () => {
      const error: Record<string, unknown> = {
        name: 'AxiosError',
        code: 'ERR_BAD_RESPONSE',
        message: 'access-token-sentinel',
        response: {
          status: 503,
          data: {
            refreshToken: 'refresh-token-sentinel',
            content: 'encrypted-content-sentinel',
          },
          headers: { 'set-cookie': 'cookie-sentinel' },
        },
        config: {
          headers: {
            Authorization: 'Bearer access-token-sentinel',
            Cookie: 'cookie-sentinel',
          },
          url: 'http://auth/sessions?code_verifier=pkce-sentinel#fragment-sentinel',
        },
      }
      error.circular = error
      ;(httpClient.request as jest.Mock).mockRejectedValue(error)

      await buildProxy().callAuthServer(
        buildRequest({
          headers: {
            authorization: 'Bearer access-token-sentinel',
            cookie: 'sid=cookie-sentinel',
          } as never,
          query: { access_token: 'query-token-sentinel' } as never,
        }),
        buildResponse({ user: { uuid: 'u-1' } }),
        'sessions',
        { content: 'encrypted-content-sentinel' },
      )

      const serialized = JSON.stringify({
        logs: {
          error: logger.error.mock.calls,
          debug: logger.debug.mock.calls,
        },
        response: send.mock.calls,
      })
      for (const sentinel of [
        'access-token-sentinel',
        'refresh-token-sentinel',
        'encrypted-content-sentinel',
        'cookie-sentinel',
        'pkce-sentinel',
        'fragment-sentinel',
        'query-token-sentinel',
      ]) {
        expect(serialized).not.toContain(sentinel)
      }
    })

    it('does not send an envelope after an error response has already been written', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

      await buildProxy().callAuthServer(buildRequest(), buildResponse(), 'sessions')

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.anything() }))
    })
  })
})
