import { HttpVerb } from '@standardnotes/responses'

import { LegacyApiService } from './ApiService'

describe('LegacyApiService CalDAV bridge', () => {
  const HOST = 'https://sync.example.test'
  const ACCOUNT = '0f8b2c1e-6a53-4f0e-9d0e-3b1a2c4d5e6f'

  const createService = (answer: unknown = { status: 200, data: {} }) => {
    const runHttp = jest.fn().mockResolvedValue(answer)
    const service = new LegacyApiService(
      { runHttp } as never,
      {} as never,
      HOST,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    ;(service as unknown as { session: unknown }).session = { accessToken: 'access-token' }

    return { service, runHttp }
  }

  it('reads the configuration', async () => {
    const { service, runHttp } = createService()

    await service.getDavBridgeConfig()

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Get,
      url: `${HOST}/v1/dav-bridge/config`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to load the calendar sync settings.',
    })
  })

  it('lists the accounts', async () => {
    const { service, runHttp } = createService()

    await service.listDavBridgeAccounts()

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Get,
      url: `${HOST}/v1/dav-bridge/accounts`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to list the connected calendar accounts.',
    })
  })

  it('creates an account with exactly what it was given', async () => {
    const { service, runHttp } = createService()
    const body = { kind: 'nextcloud' as const, url: 'https://cloud.example.org/', username: 'alice', secret: 's3cret' }

    await service.createDavBridgeAccount(body)

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Post,
      url: `${HOST}/v1/dav-bridge/accounts`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to connect the calendar account.',
      params: body,
    })
  })

  it('replaces the secret of one account', async () => {
    const { service, runHttp } = createService()

    await service.replaceDavBridgeAccountSecret(ACCOUNT, { secret: 'new' })

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Put,
      url: `${HOST}/v1/dav-bridge/accounts/${ACCOUNT}/secret`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to replace the stored password.',
      params: { secret: 'new' },
    })
  })

  it('pins one account', async () => {
    const { service, runHttp } = createService()
    const pin = { principalPath: '/principals/alice/', calendarHomePath: '/calendars/alice/' }

    await service.pinDavBridgeAccount(ACCOUNT, pin)

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Put,
      url: `${HOST}/v1/dav-bridge/accounts/${ACCOUNT}/pin`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to save which calendars this account can reach.',
      params: pin,
    })
  })

  it('deletes one account, and separately every account', async () => {
    const { service, runHttp } = createService()

    await service.deleteDavBridgeAccount(ACCOUNT)
    await service.deleteAllDavBridgeAccounts()

    expect(runHttp).toHaveBeenNthCalledWith(1, {
      verb: HttpVerb.Delete,
      url: `${HOST}/v1/dav-bridge/accounts/${ACCOUNT}`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to remove the calendar account.',
    })
    expect(runHttp).toHaveBeenNthCalledWith(2, {
      verb: HttpVerb.Delete,
      url: `${HOST}/v1/dav-bridge/accounts`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to remove the calendar accounts.',
    })
  })

  it('relays one request with the deadline it was given', async () => {
    const { service, runHttp } = createService()
    const envelope = { method: 'PROPFIND', path: '/calendars/alice/', headers: { depth: '0' }, body: '<d:propfind/>' }

    await service.relayDavBridgeRequest(ACCOUNT, envelope, 45_000)

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Post,
      url: `${HOST}/v1/dav-bridge/accounts/${ACCOUNT}/relay`,
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to reach the calendar server.',
      params: envelope,
      timeoutMs: 45_000,
    })
  })

  it('cannot be made to address another route by an account id', async () => {
    const { service, runHttp } = createService()

    await service.relayDavBridgeRequest('../../users/1?x=#', { method: 'GET', path: '/' })
    await service.deleteDavBridgeAccount('a/b')

    expect(runHttp.mock.calls[0][0].url).toBe(`${HOST}/v1/dav-bridge/accounts/..%2F..%2Fusers%2F1%3Fx%3D%23/relay`)
    expect(runHttp.mock.calls[1][0].url).toBe(`${HOST}/v1/dav-bridge/accounts/a%2Fb`)
  })

  it('hands back what the relay answered, a refusal with its tag included', async () => {
    const refusal = {
      status: 429,
      data: {
        error: { tag: 'dav-rate-limited', message: 'Too many requests.', retryAfterSeconds: 12, budget: 'requests' },
      },
    }
    const { service } = createService(refusal)

    await expect(service.relayDavBridgeRequest(ACCOUNT, { method: 'GET', path: '/' })).resolves.toEqual(refusal)
  })
})
