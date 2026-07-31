import 'reflect-metadata'

import { AxiosError } from 'axios'
import { NextFunction, Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'
import { verify } from 'jsonwebtoken'

import { CrossServiceTokenCacheInterface } from '../Service/Cache/CrossServiceTokenCacheInterface'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { OptionalCrossServiceTokenMiddleware } from './OptionalCrossServiceTokenMiddleware'
import { RequiredCrossServiceTokenMiddleware } from './RequiredCrossServiceTokenMiddleware'

jest.mock('jsonwebtoken')

describe('AuthMiddleware (via its Required/Optional subclasses)', () => {
  const mockedVerify = verify as unknown as jest.Mock

  let serviceProxy: ServiceProxyInterface
  let crossServiceTokenCache: CrossServiceTokenCacheInterface
  let timer: { getTimestampInSeconds: jest.Mock; convertStringDateToSeconds: jest.Mock }
  let logger: { debug: jest.Mock; error: jest.Mock }
  let response: Response
  let locals: Record<string, unknown>
  let next: NextFunction
  let status: jest.Mock
  let send: jest.Mock
  let setHeader: jest.Mock

  const required = (cacheTTL = 0) =>
    new RequiredCrossServiceTokenMiddleware(
      serviceProxy,
      'jwt-secret',
      cacheTTL,
      crossServiceTokenCache,
      timer as never,
      logger as never,
    )

  const optional = (cacheTTL = 0) =>
    new OptionalCrossServiceTokenMiddleware(
      serviceProxy,
      'jwt-secret',
      cacheTTL,
      crossServiceTokenCache,
      timer as never,
      logger as never,
    )

  const makeRequest = (headers: Record<string, unknown> = {}): Request =>
    ({
      headers: { authorization: 'Bearer token', ...headers },
      socket: { remoteAddress: '1.1.1.1' },
      url: '/items/sync',
      method: 'POST',
    }) as unknown as Request

  beforeEach(() => {
    mockedVerify.mockReset()
    mockedVerify.mockReturnValue({
      user: { uuid: '1-2-3', email: 'test@test.te' },
      roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
    })

    serviceProxy = {
      validateSession: jest.fn().mockResolvedValue({ status: 200, data: { authToken: 'encoded' }, headers: {} }),
    } as unknown as ServiceProxyInterface

    crossServiceTokenCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
    } as unknown as CrossServiceTokenCacheInterface

    timer = {
      getTimestampInSeconds: jest.fn().mockReturnValue(1000),
      convertStringDateToSeconds: jest.fn().mockReturnValue(9999),
    }

    logger = { debug: jest.fn(), error: jest.fn() }

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
    setHeader = jest.fn()
    locals = {}
    response = { locals, status, send, setHeader } as unknown as Response
    next = jest.fn() as unknown as NextFunction
  })

  describe('missing Authorization header', () => {
    it('Required responds 401 and never reaches the auth service', async () => {
      await required().handler(makeRequest({ authorization: undefined }), response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(send).toHaveBeenCalledWith({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    })

    it('Optional continues the chain anonymously with empty locals', async () => {
      await optional().handler(makeRequest({ authorization: undefined }), response, next)

      expect(next).toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
      expect(locals).toEqual({})
    })
  })

  describe('rejected session validation', () => {
    beforeEach(() => {
      ;(serviceProxy.validateSession as jest.Mock).mockResolvedValue({
        status: 401,
        data: { error: { tag: 'invalid-auth' } },
        headers: { contentType: 'application/json' },
      })
    })

    it('Required preserves the safe upstream 4xx tag/status/content-type and stops the chain', async () => {
      await required().handler(makeRequest(), response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(send).toHaveBeenCalledWith({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
      expect(setHeader).toHaveBeenCalledWith('content-type', 'application/json')
      expect(next).not.toHaveBeenCalled()
      expect(locals).toEqual({})
    })

    it('Required preserves the safe upstream 4xx response when content-type is absent at runtime', async () => {
      ;(serviceProxy.validateSession as jest.Mock).mockResolvedValue({
        status: 401,
        data: { error: { tag: 'invalid-auth' } },
        headers: {},
      })

      await required().handler(makeRequest(), response, next)

      expect(status).toHaveBeenCalledWith(401)
      expect(send).toHaveBeenCalledWith({
        error: { tag: 'invalid-auth', message: 'Invalid login credentials.' },
      })
      expect(setHeader).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    })

    it('Optional continues anonymously and never decodes a token', async () => {
      await optional().handler(makeRequest(), response, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(status).not.toHaveBeenCalled()
      expect(mockedVerify).not.toHaveBeenCalled()
      expect(locals).toEqual({})
    })
  })

  describe('session validation request', () => {
    it('strips the Bearer prefix before handing the token to the auth service', async () => {
      await required().handler(makeRequest(), response, next)

      expect((serviceProxy.validateSession as jest.Mock).mock.calls[0][0].headers.authorization).toBe('token')
    })

    it('forwards the client version metadata used for session bookkeeping', async () => {
      await required().handler(
        makeRequest({
          'x-snjs-version': '2.1.0',
          'x-application-version': '3.4.5',
          'user-agent': 'jest',
          'sec-ch-ua': '"Chromium";v="120"',
        }),
        response,
        next,
      )

      expect((serviceProxy.validateSession as jest.Mock).mock.calls[0][0].requestMetadata).toMatchObject({
        snjs: '2.1.0',
        application: '3.4.5',
        userAgent: 'jest',
        secChUa: '"Chromium";v="120"',
        url: '/items/sync',
        method: 'POST',
      })
    })

    it('forwards the shared vault owner context header', async () => {
      await required().handler(makeRequest({ 'x-shared-vault-owner-context': 'owner-1' }), response, next)

      expect((serviceProxy.validateSession as jest.Mock).mock.calls[0][0].headers.sharedVaultOwnerContext).toBe(
        'owner-1',
      )
    })

    it('parses the cookie header into a name -> values map', async () => {
      await required().handler(makeRequest({ cookie: 'a=1; b=2; a=3' }), response, next)

      const cookies = (serviceProxy.validateSession as jest.Mock).mock.calls[0][0].cookies as Map<string, string[]>

      expect(cookies.get('a')).toEqual(['1', '3'])
      expect(cookies.get('b')).toEqual(['2'])
    })

    it('ignores malformed cookie segments that are not exactly name=value', async () => {
      await required().handler(makeRequest({ cookie: 'novalue; a=1; x=y=z' }), response, next)

      const cookies = (serviceProxy.validateSession as jest.Mock).mock.calls[0][0].cookies as Map<string, string[]>

      expect([...cookies.keys()]).toEqual(['a'])
    })

    it('sends an empty cookie map when the request carries no cookie header', async () => {
      await required().handler(makeRequest(), response, next)

      const cookies = (serviceProxy.validateSession as jest.Mock).mock.calls[0][0].cookies as Map<string, string[]>

      expect(cookies.size).toBe(0)
    })
  })

  describe('cross service token cache', () => {
    it('does not touch the cache at all when the TTL is 0', async () => {
      await required(0).handler(makeRequest(), response, next)

      expect(crossServiceTokenCache.get).not.toHaveBeenCalled()
      expect(crossServiceTokenCache.set).not.toHaveBeenCalled()
      expect(serviceProxy.validateSession).toHaveBeenCalled()
    })

    it('serves a cache hit without calling the auth service', async () => {
      ;(crossServiceTokenCache.get as jest.Mock).mockResolvedValue('cached-token')

      await required(60).handler(makeRequest(), response, next)

      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
      expect(mockedVerify).toHaveBeenCalledWith('cached-token', 'jwt-secret', { algorithms: ['HS256'] })
      expect(crossServiceTokenCache.set).not.toHaveBeenCalled()
      expect(locals.authToken).toBe('cached-token')
      expect(next).toHaveBeenCalled()
    })

    it('caches a freshly fetched token under the authorization header key', async () => {
      await required(60).handler(makeRequest(), response, next)

      expect(crossServiceTokenCache.set).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'Bearer token', encodedCrossServiceToken: 'encoded', userUuid: '1-2-3' }),
      )
    })

    it('keys the cache separately per shared vault owner context so contexts cannot leak', async () => {
      await required(60).handler(makeRequest({ 'x-shared-vault-owner-context': 'owner-1' }), response, next)

      expect(crossServiceTokenCache.get).toHaveBeenCalledWith('Bearer token:owner-1')
      expect((crossServiceTokenCache.set as jest.Mock).mock.calls[0][0].key).toBe('Bearer token:owner-1')
    })

    it('expires the cache entry at now + TTL when the token carries no session', async () => {
      await required(60).handler(makeRequest(), response, next)

      expect((crossServiceTokenCache.set as jest.Mock).mock.calls[0][0].expiresAtInSeconds).toBe(1060)
    })

    it('never caches past the session access/refresh expiration', async () => {
      mockedVerify.mockReturnValue({
        user: { uuid: '1-2-3' },
        roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
        session: { access_expiration: 'a', refresh_expiration: 'r' },
      })
      timer.convertStringDateToSeconds.mockImplementation((value: string) => (value === 'a' ? 1020 : 1040))

      await required(60).handler(makeRequest(), response, next)

      expect((crossServiceTokenCache.set as jest.Mock).mock.calls[0][0].expiresAtInSeconds).toBe(1020)
    })

    it('uses the TTL when it expires before the session', async () => {
      mockedVerify.mockReturnValue({
        user: { uuid: '1-2-3' },
        roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
        session: { access_expiration: 'a', refresh_expiration: 'r' },
      })
      timer.convertStringDateToSeconds.mockReturnValue(99999)

      await required(60).handler(makeRequest(), response, next)

      expect((crossServiceTokenCache.set as jest.Mock).mock.calls[0][0].expiresAtInSeconds).toBe(1060)
    })
  })

  describe('locals projection', () => {
    it('projects the session, roles and shared vault fields from the decoded token', async () => {
      mockedVerify.mockReturnValue({
        user: { uuid: '1-2-3' },
        session: { uuid: 's-1', readonly_access: true },
        roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
        shared_vault_owner_context: 'owner-1',
        belongs_to_shared_vaults: ['v-1'],
        version: 4,
      })

      await required().handler(makeRequest(), response, next)

      expect(locals.session).toEqual({ uuid: 's-1', readonly_access: true })
      expect(locals.sharedVaultOwnerContext).toBe('owner-1')
      expect(locals.belongsToSharedVaults).toEqual(['v-1'])
      expect(locals.authTokenVersion).toBe(4)
      expect(locals.readOnlyAccess).toBe(true)
    })

    it('defaults readOnlyAccess to false and belongsToSharedVaults to empty when absent (fail-closed)', async () => {
      await required().handler(makeRequest(), response, next)

      expect(locals.readOnlyAccess).toBe(false)
      expect(locals.belongsToSharedVaults).toEqual([])
    })

    it('marks a lone CORE_USER as a free user but not a user holding a paid role', async () => {
      const isFreeUserFor = async (roles: unknown[]) => {
        mockedVerify.mockReturnValue({ user: { uuid: '1-2-3' }, roles })
        const scopedLocals: Record<string, unknown> = {}
        await required().handler(
          makeRequest(),
          { locals: scopedLocals, status, send, setHeader } as unknown as Response,
          next,
        )
        return scopedLocals.isFreeUser
      }

      expect(await isFreeUserFor([{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }])).toBe(true)
      expect(await isFreeUserFor([{ uuid: 'r-2', name: RoleName.NAMES.PlusUser }])).toBe(false)
      // CORE_USER is retained alongside a paid role, so the role COUNT is what
      // distinguishes a free user — checking roles[0] alone would pass this by.
      expect(
        await isFreeUserFor([
          { uuid: 'r-1', name: RoleName.NAMES.CoreUser },
          { uuid: 'r-2', name: RoleName.NAMES.PlusUser },
        ]),
      ).toBe(false)
    })

    it('emits AI_ENABLED=false when the token explicitly disables AI', async () => {
      mockedVerify.mockReturnValue({
        user: { uuid: '1-2-3' },
        roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
        ai_enabled: false,
      })

      await required().handler(makeRequest(), response, next)

      expect((locals.settings as Record<string, unknown>)['AI_ENABLED']).toBe('false')
    })

    it('emits a positive AI_REQUEST_LIMIT override but ignores zero and non-numeric values', async () => {
      const limitFor = async (ai_request_limit: unknown) => {
        mockedVerify.mockReturnValue({
          user: { uuid: '1-2-3' },
          roles: [{ uuid: 'r-1', name: RoleName.NAMES.CoreUser }],
          ai_request_limit,
        })
        const scopedLocals: Record<string, unknown> = {}
        await required().handler(
          makeRequest(),
          { locals: scopedLocals, status, send, setHeader } as unknown as Response,
          next,
        )
        return (scopedLocals.settings as Record<string, unknown>)['AI_REQUEST_LIMIT']
      }

      expect(await limitFor(25)).toBe(25)
      expect(await limitFor(0)).toBeUndefined()
      expect(await limitFor(-1)).toBeUndefined()
      expect(await limitFor('25')).toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('responds 500 with a stable public error when session validation throws a plain error', async () => {
      ;(serviceProxy.validateSession as jest.Mock).mockRejectedValue(new Error('boom'))

      await required().handler(makeRequest(), response, next)

      expect(status).toHaveBeenCalledWith(500)
      expect(send).toHaveBeenCalledWith({
        error: {
          tag: 'service-unavailable',
          message: 'The requested service is temporarily unavailable.',
        },
      })
      expect(logger.error).toHaveBeenCalledWith(
        'Could not validate session on underlying service.',
        expect.objectContaining({ action: 'session.validate', endpoint: '/sessions/validate' }),
      )
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('boom')
      expect(next).not.toHaveBeenCalled()
    })

    it('does NOT continue the chain when token verification fails', async () => {
      mockedVerify.mockImplementation(() => {
        throw new Error('invalid signature')
      })

      await required().handler(makeRequest(), response, next)

      expect(next).not.toHaveBeenCalled()
      expect(locals).toEqual({})
      expect(status).toHaveBeenCalledWith(500)
    })

    it('logs only an allowlisted AxiosError summary and keeps the upstream body and headers private', async () => {
      const error = new AxiosError('Request failed', '502')
      error.response = {
        status: 502,
        data: { error: 'bad gateway' },
        headers: { 'content-type': 'application/problem+json' },
      } as never

      ;(serviceProxy.validateSession as jest.Mock).mockRejectedValue(error)

      await required().handler(makeRequest(), response, next)

      expect(logger.error).toHaveBeenCalledWith(
        'Could not validate session on underlying service.',
        expect.objectContaining({
          action: 'session.validate',
          endpoint: '/sessions/validate',
          status: 502,
        }),
      )
      expect(setHeader).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(502)
      expect(send).toHaveBeenCalledWith({
        error: {
          tag: 'service-unavailable',
          message: 'The requested service is temporarily unavailable.',
        },
      })
    })

    it('falls back to 500 when the axios error code is not numeric', async () => {
      const error = new AxiosError('Request failed', 'ECONNREFUSED')
      error.response = { data: { error: 'down' }, headers: {} } as never

      ;(serviceProxy.validateSession as jest.Mock).mockRejectedValue(error)

      await required().handler(makeRequest(), response, next)

      expect(status).toHaveBeenCalledWith(500)
      expect(send).toHaveBeenCalledWith({
        error: {
          tag: 'service-unavailable',
          message: 'The requested service is temporarily unavailable.',
        },
      })
    })

    it('never logs raw auth, cookie, response-body, URL-query, message, or circular axios config data', async () => {
      const error: Record<string, unknown> = {
        name: 'AxiosError',
        code: 'ERR_BAD_RESPONSE',
        message: 'access-token-sentinel',
        response: {
          status: 503,
          data: {
            refreshToken: 'refresh-token-sentinel',
            encryptedContent: 'encrypted-content-sentinel',
          },
          headers: {
            'set-cookie': 'cookie-sentinel',
          },
        },
        config: {
          headers: {
            Authorization: 'Bearer access-token-sentinel',
            Cookie: 'cookie-sentinel',
          },
          url: '/sessions/validate?code_verifier=pkce-sentinel#fragment-sentinel',
        },
      }
      error.circular = error
      ;(serviceProxy.validateSession as jest.Mock).mockRejectedValue(error)

      await required().handler(
        makeRequest({
          authorization: 'Bearer access-token-sentinel',
          cookie: 'sid=cookie-sentinel',
        }),
        response,
        next,
      )

      const serializedLogs = JSON.stringify({
        error: logger.error.mock.calls,
        debug: logger.debug.mock.calls,
      })
      for (const sentinel of [
        'access-token-sentinel',
        'refresh-token-sentinel',
        'encrypted-content-sentinel',
        'cookie-sentinel',
        'pkce-sentinel',
        'fragment-sentinel',
      ]) {
        expect(serializedLogs).not.toContain(sentinel)
      }
    })
  })
})
