import 'reflect-metadata'

import { AxiosError, AxiosInstance } from 'axios'
import { Request, Response } from 'express'

import { CrossServiceTokenCacheInterface } from '../Cache/CrossServiceTokenCacheInterface'
import { HttpServiceProxy } from './HttpServiceProxy'

describe('HttpServiceProxy', () => {
  let httpClient: AxiosInstance
  let crossServiceTokenCache: CrossServiceTokenCacheInterface
  let logger: { error: jest.Mock; debug: jest.Mock; info: jest.Mock }
  let timer: { sleep: jest.Mock }

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

  const buildProxy = (overrides: Partial<typeof urls> = {}): HttpServiceProxy => {
    const u = { ...urls, ...overrides }
    return new HttpServiceProxy(
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

  /** The axios response shape `callServerWithLegacyFormat` inspects for redirects. */
  const serviceResponse = (overrides: Record<string, unknown> = {}) => ({
    status: 200,
    data: { ok: true },
    headers: { 'content-type': 'application/json' },
    request: { _redirectable: { _redirectCount: 0 }, res: { responseUrl: 'http://final' } },
    ...overrides,
  })

  const sentConfig = () => (httpClient.request as jest.Mock).mock.calls[0][0]

  beforeEach(() => {
    httpClient = { request: jest.fn().mockResolvedValue(serviceResponse()) } as unknown as AxiosInstance
    crossServiceTokenCache = {
      get: jest.fn(),
      set: jest.fn(),
      invalidate: jest.fn(),
    } as unknown as CrossServiceTokenCacheInterface
    logger = { error: jest.fn(), debug: jest.fn(), info: jest.fn() }
    timer = { sleep: jest.fn().mockResolvedValue(undefined) }

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
    setHeader = jest.fn()
    redirect = jest.fn()
  })

  describe('validateSession', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      headers: { authorization: 'token' },
      requestMetadata: { url: '/items/sync', method: 'POST', snjs: '2.1.0', ip: '2.2.2.2' },
      ...overrides,
    })

    beforeEach(() => {
      ;(httpClient.request as jest.Mock).mockResolvedValue({
        status: 200,
        data: { authToken: 'encoded' },
        headers: { 'content-type': 'application/json' },
      })
    })

    it('posts to the auth server sessions/validate endpoint with the origin metadata headers', async () => {
      await buildProxy().validateSession(dto())

      expect(sentConfig()).toMatchObject({
        method: 'POST',
        url: 'http://auth/sessions/validate',
        data: { authTokenFromHeaders: 'token', sharedVaultOwnerContext: undefined },
      })
      expect(sentConfig().headers).toMatchObject({
        'x-snjs-version': '2.1.0',
        'x-origin-ip': '2.2.2.2',
        'x-origin-url': '/items/sync',
        'x-origin-method': 'POST',
      })
    })

    it('serializes the cookie map into a single Cookie header, repeating duplicate names', async () => {
      await buildProxy().validateSession(
        dto({
          cookies: new Map([
            ['a', ['1', '3']],
            ['b', ['2']],
          ]),
        }),
      )

      expect(sentConfig().headers.Cookie).toBe('a=1; a=3; b=2;')
    })

    it('sends an empty Cookie header when no cookies are supplied', async () => {
      await buildProxy().validateSession(dto())

      expect(sentConfig().headers.Cookie).toBe('')
    })

    it('returns the upstream status, data and content-type', async () => {
      const result = await buildProxy().validateSession(dto())

      expect(result).toEqual({
        status: 200,
        data: { authToken: 'encoded' },
        headers: { contentType: 'application/json' },
      })
    })

    it('treats every status below 500 as non-throwing', async () => {
      await buildProxy().validateSession(dto())

      const validateStatus = sentConfig().validateStatus as (s: number) => boolean
      expect(validateStatus(401)).toBe(true)
      expect(validateStatus(500)).toBe(false)
      expect(validateStatus(199)).toBe(false)
    })

    it('retries a timed-out call with backoff and succeeds on the retry', async () => {
      ;(httpClient.request as jest.Mock)
        .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
        .mockResolvedValueOnce({ status: 200, data: { authToken: 'encoded' }, headers: {} })

      const result = await buildProxy().validateSession(dto())

      expect(httpClient.request).toHaveBeenCalledTimes(2)
      expect(timer.sleep).toHaveBeenCalledTimes(1)
      expect(result.status).toBe(200)
    })

    it('retries a 503 and a 504 from the auth service', async () => {
      for (const status of [503, 504]) {
        jest.clearAllMocks()
        ;(httpClient.request as jest.Mock)
          .mockRejectedValueOnce({ response: { status } })
          .mockResolvedValueOnce({ status: 200, data: {}, headers: {} })

        await buildProxy().validateSession(dto())

        expect(httpClient.request).toHaveBeenCalledTimes(2)
      }
    })

    it('does NOT retry an error that reached the destination, e.g. a 500', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue({ response: { status: 500 } })

      await expect(buildProxy().validateSession(dto())).rejects.toEqual({ response: { status: 500 } })
      expect(httpClient.request).toHaveBeenCalledTimes(1)
      expect(timer.sleep).not.toHaveBeenCalled()
    })

    it('gives up after 3 retries and rethrows', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue({ code: 'ETIMEDOUT' })

      await expect(buildProxy().validateSession(dto())).rejects.toEqual({ code: 'ETIMEDOUT' })
      expect(httpClient.request).toHaveBeenCalledTimes(4)
      expect(timer.sleep).toHaveBeenCalledTimes(3)
    })

    it('backs off exponentially from 100ms, capped at 5s plus jitter under 50ms', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue({ code: 'ETIMEDOUT' })

      await expect(buildProxy().validateSession(dto())).rejects.toBeDefined()

      const delays = timer.sleep.mock.calls.map((call) => call[0] as number)
      expect(delays).toHaveLength(3)
      expect(delays[0]).toBeGreaterThanOrEqual(100)
      expect(delays[0]).toBeLessThan(150)
      expect(delays[1]).toBeGreaterThanOrEqual(200)
      expect(delays[1]).toBeLessThan(250)
      expect(delays[2]).toBeGreaterThanOrEqual(400)
      expect(delays[2]).toBeLessThan(450)
    })
  })

  describe('outgoing request construction', () => {
    it('forwards the incoming method, query string and endpoint path to the target service', async () => {
      await buildProxy().callSyncingServer(
        buildRequest({ method: 'GET', query: { limit: '10' } as never }),
        buildResponse(),
        'items',
      )

      expect(sentConfig()).toMatchObject({
        method: 'GET',
        url: 'http://syncing/items',
        params: { limit: '10' },
        timeout: 1000,
      })
    })

    it('strips host and content-length so the target service does not see the gateway hop', async () => {
      await buildProxy().callSyncingServer(
        buildRequest({ headers: { host: 'gateway.example', 'content-length': '42', 'x-custom': 'kept' } as never }),
        buildResponse(),
        'items',
      )

      expect(sentConfig().headers.host).toBeUndefined()
      expect(sentConfig().headers['content-length']).toBeUndefined()
      expect(sentConfig().headers['x-custom']).toBe('kept')
    })

    it('attaches the cross service token as X-Auth-Token when locals carry one', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse({ authToken: 'cst' }), 'items')

      expect(sentConfig().headers['X-Auth-Token']).toBe('cst')
      expect(sentConfig().headers['X-Auth-Offline-Token']).toBeUndefined()
    })

    it('attaches an offline token as X-Auth-Offline-Token', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse({ offlineAuthToken: 'off' }), 'items')

      expect(sentConfig().headers['X-Auth-Offline-Token']).toBe('off')
      expect(sentConfig().headers['X-Auth-Token']).toBeUndefined()
    })

    it('sends no auth header at all for an anonymous request', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(sentConfig().headers['X-Auth-Token']).toBeUndefined()
      expect(sentConfig().headers['X-Auth-Offline-Token']).toBeUndefined()
    })

    it('drops an empty payload so the target service sees no body', async () => {
      for (const payload of ['', {}, undefined]) {
        jest.clearAllMocks()
        await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items', payload as never)
        expect(sentConfig().data).toBeUndefined()
      }
    })

    it('forwards a non-empty payload untouched', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items', { items: [1] })

      expect(sentConfig().data).toEqual({ items: [1] })
    })

    it('lifts the axios body size limits so large syncs are not truncated', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(sentConfig().maxContentLength).toBe(Infinity)
      expect(sentConfig().maxBodyLength).toBe(Infinity)
    })
  })

  describe('response handling', () => {
    it('decorates the service response with auth and server metadata', async () => {
      await buildProxy().callSyncingServer(
        buildRequest(),
        buildResponse({ user: { uuid: 'u-1' }, roles: [{ name: 'CORE_USER' }] }),
        'items',
      )

      expect(status).toHaveBeenCalledWith(200)
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
        serviceResponse({ data: '<html></html>', headers: { 'content-type': 'text/HTML; charset=utf-8' } }),
      )

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(send).toHaveBeenCalledWith('<html></html>')
    })

    it('copies only the allow-listed headers back to the client', async () => {
      ;(httpClient.request as jest.Mock).mockResolvedValue(
        serviceResponse({
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer new',
            'set-cookie': ['a=1'],
            'x-captcha-required': 'true',
            'x-secret-internal': 'leak',
          },
        }),
      )

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      const copied = setHeader.mock.calls.map((call) => call[0] as string)
      expect(copied).toEqual(
        expect.arrayContaining(['content-type', 'authorization', 'set-cookie', 'x-captcha-required']),
      )
      expect(copied).not.toContain('x-secret-internal')
    })

    it('invalidates the cross service token cache when the service asks it to', async () => {
      ;(httpClient.request as jest.Mock).mockResolvedValue(
        serviceResponse({ headers: { 'content-type': 'application/json', 'x-invalidate-cache': 'u-9' } }),
      )

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(crossServiceTokenCache.invalidate).toHaveBeenCalledWith('u-9')
    })

    it('does not invalidate the cache on an ordinary response', async () => {
      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(crossServiceTokenCache.invalidate).not.toHaveBeenCalled()
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
          request: { _redirectable: { _redirectCount: 1 }, res: { responseUrl: 'http://final/target' } },
        }),
      )

      await buildProxy().callAuthServerWithLegacyFormat(buildRequest(), buildResponse(), 'sessions')

      expect(status).toHaveBeenCalledWith(302)
      expect(redirect).toHaveBeenCalledWith('http://final/target')
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('per-service routing and configuration guards', () => {
    it('routes each helper at its own configured base URL', async () => {
      const cases: [string, string][] = [
        ['callSyncingServer', 'http://syncing/e'],
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

    it('silently skips a websocket call when no websocket server is configured', async () => {
      await buildProxy({ ws: '' }).callWebSocketServer(buildRequest(), buildResponse(), 'push')

      expect(httpClient.request).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('silently skips a payments call when no payments server is configured', async () => {
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

  describe('error handling', () => {
    it('responds 500 with a generic message when the target service is unreachable', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(status).toHaveBeenCalledWith(500)
      expect(send).toHaveBeenCalledWith(
        "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
      )
    })

    it('logs the failing target URL together with the acting user', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

      await buildProxy().callSyncingServer(buildRequest(), buildResponse({ user: { uuid: 'u-1' } }), 'items')

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('http://syncing/items'), { userId: 'u-1' })
    })

    it('mirrors an axios error status, content-type and body back to the client', async () => {
      const error = new AxiosError('Request failed', '502')
      error.response = {
        data: { error: 'bad gateway' },
        headers: { 'content-type': 'application/problem+json' },
      } as never

      ;(httpClient.request as jest.Mock).mockRejectedValue(error)

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(setHeader).toHaveBeenCalledWith('content-type', 'application/problem+json')
      expect(status).toHaveBeenCalledWith(502)
      expect(send).toHaveBeenCalledWith({ error: 'bad gateway' })
    })

    it('does not send an envelope after an error response has already been written', async () => {
      ;(httpClient.request as jest.Mock).mockRejectedValue(new Error('ECONNRESET'))

      await buildProxy().callSyncingServer(buildRequest(), buildResponse(), 'items')

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.anything() }))
    })
  })
})
