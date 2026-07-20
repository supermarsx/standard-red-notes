import { LoggerInterface } from '@standardnotes/utils'
import { Environment } from '@standardnotes/models'
import { LegacySession, Session, SessionToken } from '@standardnotes/domain-core'
import { HttpRequest, HttpResponse, HttpStatusCode, HttpVerb } from '@standardnotes/responses'
import { ApiVersion } from '../Api/ApiVersion'
import { FetchRequestHandler } from './FetchRequestHandler'
import { HttpService } from './HttpService'

jest.mock('./FetchRequestHandler')

const FetchRequestHandlerMock = FetchRequestHandler as jest.MockedClass<typeof FetchRequestHandler>

const HOST = 'https://api.example.com'

const sessionWith = (accessToken: string, refreshToken = 'refresh-token') =>
  Session.create(
    SessionToken.create(accessToken, 1_700_000_000).getValue(),
    SessionToken.create(refreshToken, 1_700_000_000).getValue(),
  ).getValue()

const refreshBody = (accessToken: string, refreshToken: string) => ({
  session: {
    access_token: accessToken,
    access_expiration: 1_800_000_000,
    refresh_token: refreshToken,
    refresh_expiration: 1_900_000_000,
    readonly_access: false,
  },
})

describe('HttpService', () => {
  let handleRequest: jest.Mock
  let logger: jest.Mocked<LoggerInterface>
  let service: HttpService

  const lastRequest = (): HttpRequest => handleRequest.mock.calls[handleRequest.mock.calls.length - 1][0]

  beforeEach(() => {
    handleRequest = jest.fn().mockResolvedValue({ status: HttpStatusCode.Success, data: {} })
    FetchRequestHandlerMock.mockImplementation(
      () => ({ handleRequest }) as unknown as InstanceType<typeof FetchRequestHandler>,
    )

    logger = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), setLevel: jest.fn() }

    service = new HttpService(Environment.Web, '1.2.3', '4.5.6', ApiVersion.v0, logger)
    service.setHost(HOST)
  })

  afterEach(() => {
    FetchRequestHandlerMock.mockReset()
  })

  it('should build its request handler from the constructor arguments', () => {
    expect(FetchRequestHandlerMock).toHaveBeenCalledWith('4.5.6', '1.2.3', Environment.Web, logger)
  })

  describe('host', () => {
    it('should round-trip the host', () => {
      expect(service.getHost()).toBe(HOST)
    })

    it('get should throw before the host is set', async () => {
      const unhosted = new HttpService(Environment.Web, '1', '2', ApiVersion.v0, logger)

      await expect(unhosted.get('/v1/items')).rejects.toThrow('Attempting to make network request before host is set')
    })

    it('post should throw before the host is set', async () => {
      const unhosted = new HttpService(Environment.Web, '1', '2', ApiVersion.v0, logger)

      await expect(unhosted.post('/v1/items')).rejects.toThrow('Attempting to make network request before host is set')
    })
  })

  describe('verbs', () => {
    it('get should join the host and path and stamp the api version', async () => {
      await service.get('/v1/items', { limit: 10 })

      expect(lastRequest()).toMatchObject({
        url: 'https://api.example.com/v1/items',
        verb: HttpVerb.Get,
        params: { limit: 10, api: ApiVersion.v0 },
      })
    })

    it('getExternal should not join the host and should mark the request external', async () => {
      await service.getExternal('https://third-party.example/data', { q: 1 })

      expect(lastRequest()).toMatchObject({
        url: 'https://third-party.example/data',
        verb: HttpVerb.Get,
        external: true,
      })
    })

    it('post, put, patch and delete should use their verbs', async () => {
      await service.post('/v1/a', {})
      await service.put('/v1/b', {})
      await service.patch('/v1/c', {})
      await service.delete('/v1/d', {})

      expect(handleRequest.mock.calls.map(([request]) => [request.verb, request.url])).toEqual([
        [HttpVerb.Post, 'https://api.example.com/v1/a'],
        [HttpVerb.Put, 'https://api.example.com/v1/b'],
        [HttpVerb.Patch, 'https://api.example.com/v1/c'],
        [HttpVerb.Delete, 'https://api.example.com/v1/d'],
      ])
    })

    it('should leave params undefined when none are supplied', async () => {
      await service.get('/v1/items')

      expect(lastRequest().params).toBeUndefined()
    })

    it('should forward custom headers', async () => {
      const headers = [{ key: 'x-server-password', value: 'secret' }]

      await service.get('/v1/items', undefined, { headers })

      expect(lastRequest().customHeaders).toBe(headers)
    })
  })

  describe('authentication', () => {
    it('should send no authentication when there is no session', async () => {
      await service.get('/v1/items')

      expect(lastRequest().authentication).toBeUndefined()
    })

    it('should send the access token value of a modern session', async () => {
      service.setSession(sessionWith('access-token'))

      await service.get('/v1/items')

      expect(lastRequest().authentication).toBe('access-token')
    })

    it('should send the raw token of a legacy session', async () => {
      service.setSession(LegacySession.create('legacy-token').getValue())

      await service.get('/v1/items')

      expect(lastRequest().authentication).toBe('legacy-token')
    })

    it('should prefer an explicitly supplied authentication over the session', async () => {
      service.setSession(sessionWith('access-token'))

      await service.get('/v1/items', undefined, { authentication: 'override' })

      expect(lastRequest().authentication).toBe('override')
    })

    it('deinit should drop the session so no authentication is sent', async () => {
      service.setSession(sessionWith('access-token'))

      service.deinit()
      await service.get('/v1/items')

      expect(lastRequest().authentication).toBeUndefined()
    })
  })

  describe('meta and logging', () => {
    it('should pass response meta to the update callback', async () => {
      const meta = { auth: { userUuid: 'user-1' } }
      handleRequest.mockResolvedValue({ status: HttpStatusCode.Success, data: {}, meta })
      const updateMeta = jest.fn()
      service.setCallbacks(updateMeta, jest.fn())

      await service.get('/v1/items')

      expect(updateMeta).toHaveBeenCalledWith(meta)
    })

    it('should not pass meta for external requests', async () => {
      handleRequest.mockResolvedValue({ status: HttpStatusCode.Success, data: {}, meta: { auth: {} } })
      const updateMeta = jest.fn()
      service.setCallbacks(updateMeta, jest.fn())

      await service.getExternal('https://third-party.example/data')

      expect(updateMeta).not.toHaveBeenCalled()
    })

    it('should not log errors while logging is disabled', async () => {
      handleRequest.mockResolvedValue({ status: HttpStatusCode.BadRequest, data: { error: { message: 'nope' } } })

      await service.get('/v1/items')

      expect(logger.error).not.toHaveBeenCalled()
    })

    it('should log error responses once logging is enabled', async () => {
      handleRequest.mockResolvedValue({ status: HttpStatusCode.BadRequest, data: { error: { message: 'nope' } } })
      service.loggingEnabled = true

      await service.get('/v1/items')

      expect(logger.error).toHaveBeenCalledWith('Request failed', expect.any(Object), expect.any(Object))
    })

    it('should not log a successful response even with logging enabled', async () => {
      service.loggingEnabled = true

      await service.get('/v1/items')

      expect(logger.error).not.toHaveBeenCalled()
    })
  })

  describe('refreshSession', () => {
    it('should fail when there is no session', async () => {
      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('No session to refresh')
    })

    it('should fail for a legacy session', async () => {
      service.setSession(LegacySession.create('legacy-token').getValue())

      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Cannot refresh legacy session')
    })

    it('should post the current tokens to the refresh path', async () => {
      service.setSession(sessionWith('old-access', 'old-refresh'))
      service.setCallbacks(jest.fn(), jest.fn())
      handleRequest.mockResolvedValue({
        status: HttpStatusCode.Success,
        data: refreshBody('new-access', 'new-refresh'),
      })

      await service.refreshSession()

      expect(lastRequest()).toMatchObject({
        url: 'https://api.example.com/v1/sessions/refresh',
        verb: HttpVerb.Post,
        params: { access_token: 'old-access', refresh_token: 'old-refresh', api: ApiVersion.v0 },
      })
    })

    it('should install the new session and notify the callback', async () => {
      service.setSession(sessionWith('old-access', 'old-refresh'))
      const refreshCallback = jest.fn()
      service.setCallbacks(jest.fn(), refreshCallback)
      handleRequest.mockResolvedValue({
        status: HttpStatusCode.Success,
        data: refreshBody('new-access', 'new-refresh'),
      })

      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(false)
      expect(refreshCallback).toHaveBeenCalledTimes(1)

      handleRequest.mockResolvedValue({ status: HttpStatusCode.Success, data: {} })
      await service.get('/v1/items')
      expect(lastRequest().authentication).toBe('new-access')
    })

    it('should return the error response untouched when the server rejects the refresh', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())
      const errorResponse = { status: HttpStatusCode.Unauthorized, data: { error: { message: 'bad refresh' } } }
      handleRequest.mockResolvedValue(errorResponse)

      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(false)
      expect(result.getValue()).toBe(errorResponse as HttpResponse<never>)
    })

    it('should fail when the returned access token is empty', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())
      handleRequest.mockResolvedValue({ status: HttpStatusCode.Success, data: refreshBody('', 'new-refresh') })

      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toContain('Token value is empty')
    })

    it('should fail when the returned refresh token is empty', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())
      handleRequest.mockResolvedValue({ status: HttpStatusCode.Success, data: refreshBody('new-access', '') })

      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toContain('Token value is empty')
    })

    it('should forward the refresh response meta', async () => {
      service.setSession(sessionWith('old-access'))
      const updateMeta = jest.fn()
      service.setCallbacks(updateMeta, jest.fn())
      handleRequest.mockResolvedValue({
        status: HttpStatusCode.Success,
        data: refreshBody('new-access', 'new-refresh'),
        meta: { auth: { userUuid: 'user-1' } },
      })

      await service.refreshSession()

      expect(updateMeta).toHaveBeenCalledWith({ auth: { userUuid: 'user-1' } })
    })
  })

  describe('expired access token handling', () => {
    it('should refresh the session and retry the original request', async () => {
      service.setSession(sessionWith('old-access', 'old-refresh'))
      service.setCallbacks(jest.fn(), jest.fn())

      handleRequest
        // original request
        .mockResolvedValueOnce({ status: HttpStatusCode.ExpiredAccessToken, data: {} })
        // refresh
        .mockResolvedValueOnce({ status: HttpStatusCode.Success, data: refreshBody('new-access', 'new-refresh') })
        // retry
        .mockResolvedValueOnce({ status: HttpStatusCode.Success, data: { items: [] } })

      const response = await service.get('/v1/items')

      expect(response.status).toBe(HttpStatusCode.Success)
      expect(handleRequest).toHaveBeenCalledTimes(3)
      expect(lastRequest().authentication).toBe('new-access')
    })

    it('should return the original response when the refresh fails', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())

      const expired = { status: HttpStatusCode.ExpiredAccessToken, data: {} }
      handleRequest
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce({ status: HttpStatusCode.Unauthorized, data: { error: { message: 'bad refresh' } } })

      const response = await service.get('/v1/items')

      expect(response).toBe(expired as HttpResponse<never>)
      expect(handleRequest).toHaveBeenCalledTimes(2)
    })

    it('should not attempt a refresh for an external request', async () => {
      service.setSession(sessionWith('old-access'))
      handleRequest.mockResolvedValue({ status: HttpStatusCode.ExpiredAccessToken, data: {} })

      await service.getExternal('https://third-party.example/data')

      expect(handleRequest).toHaveBeenCalledTimes(1)
    })

    it('should not recurse when the refresh request itself expires', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())
      handleRequest.mockResolvedValue({ status: HttpStatusCode.ExpiredAccessToken, data: {} })

      const result = await service.refreshSession()

      expect(result.isFailed()).toBe(false)
      expect(handleRequest).toHaveBeenCalledTimes(1)
    })

    it('should retry without refreshing when the token was renewed in between', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())

      handleRequest.mockImplementationOnce(async () => {
        // Simulate another caller installing a fresh session while this request was in flight.
        service.setSession(sessionWith('renewed-access'))
        return { status: HttpStatusCode.ExpiredAccessToken, data: {} }
      })
      handleRequest.mockResolvedValueOnce({ status: HttpStatusCode.Success, data: {} })

      const response = await service.get('/v1/items')

      expect(response.status).toBe(HttpStatusCode.Success)
      expect(handleRequest).toHaveBeenCalledTimes(2)
      expect(lastRequest().authentication).toBe('renewed-access')
    })
  })

  describe('runHttp', () => {
    it('should delegate to the request handler and return its response', async () => {
      const expected = { status: HttpStatusCode.Success, data: { ok: true } }
      handleRequest.mockResolvedValue(expected)

      const request: HttpRequest = { url: `${HOST}/v1/items`, verb: HttpVerb.Get }

      await expect(service.runHttp(request)).resolves.toBe(expected)
    })

    it('should wait for an in-progress refresh and pick up the refreshed token', async () => {
      service.setSession(sessionWith('old-access', 'old-refresh'))
      service.setCallbacks(jest.fn(), jest.fn())

      let releaseRefresh: () => void = () => undefined
      handleRequest
        .mockImplementationOnce(async () => ({ status: HttpStatusCode.ExpiredAccessToken, data: {} }))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseRefresh = () =>
                resolve({ status: HttpStatusCode.Success, data: refreshBody('new-access', 'new-refresh') })
            }),
        )
        .mockResolvedValue({ status: HttpStatusCode.Success, data: {} })

      const first = service.get('/v1/items')
      // Give the first request time to reach the refresh call.
      await Promise.resolve()
      await Promise.resolve()
      const second = service.get('/v1/other')
      releaseRefresh()

      await first
      await second

      expect(lastRequest().authentication).toBe('new-access')
    })
  })

  describe('developer simulators', () => {
    it('should delay every request by the configured latency', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      ;(service as unknown as { __latencySimulatorMs?: number }).__latencySimulatorMs = 5

      const before = Date.now()
      await service.get('/v1/items')

      expect(Date.now() - before).toBeGreaterThanOrEqual(4)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Sleeping for 5ms'))
      warn.mockRestore()
    })

    it('should report a dropped refresh response when the drop simulator is armed', async () => {
      service.setSession(sessionWith('old-access'))
      service.setCallbacks(jest.fn(), jest.fn())
      handleRequest.mockResolvedValue({
        status: HttpStatusCode.Success,
        data: refreshBody('new-access', 'new-refresh'),
      })
      ;(
        service as unknown as { __simulateNextSessionRefreshResponseDrop: boolean }
      ).__simulateNextSessionRefreshResponseDrop = true

      const dropped = await service.refreshSession()

      expect(dropped.isFailed()).toBe(true)
      expect(dropped.getError()).toBe('Simulating a dropped response')

      // The simulator disarms itself, so the next refresh succeeds.
      const next = await service.refreshSession()
      expect(next.isFailed()).toBe(false)
    })
  })

  describe('setCallbacks', () => {
    it('should tolerate a response with meta before any callbacks are registered', async () => {
      handleRequest.mockResolvedValue({ status: HttpStatusCode.Success, data: {}, meta: { auth: {} } })

      await expect(service.get('/v1/items')).resolves.toMatchObject({ status: HttpStatusCode.Success })
    })
  })
})
