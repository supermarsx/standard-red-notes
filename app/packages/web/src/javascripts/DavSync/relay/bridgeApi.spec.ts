import {
  ApiAnswer,
  DavBridgeApi,
  RELAY_ANSWER_MARGIN_MS,
  RelayTransport,
  createBridgeAccount,
  davBridgeApiOf,
  deleteAllBridgeAccounts,
  deleteBridgeAccount,
  listBridgeAccounts,
  pinBridgeAccount,
  readBridgeConfig,
  relayDeadlineMs,
  relayResultOf,
  replaceBridgeSecret,
} from './bridgeApi'

/** The answers below are the examples of the server contract (dav-contract.md v1.1), copied by hand. */
const REMOTE = {
  status: 207,
  headers: { 'content-type': 'application/xml; charset=utf-8', dav: '1, 3, calendar-access' },
  body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>',
  bodyEncoding: 'utf8',
  path: '/remote.php/dav/calendars/alice/personal/',
  redirects: 0,
}

const CONFIG = {
  enabled: true,
  allowed: true,
  available: true,
  mode: 'relay',
  writeEnabled: false,
  methods: ['OPTIONS', 'PROPFIND', 'REPORT', 'GET'],
  limits: {
    maxAccounts: 5,
    requestBodyBytes: 1048576,
    responseBodyBytes: 8388608,
    requestTimeoutMs: 30000,
    pathLength: 2048,
    discoveryWindowSeconds: 900,
    requestsPerTenMinutes: 600,
    writesPerMinute: 60,
    accountValidationsPerHour: 10,
  },
}

const ACCOUNT = {
  id: '0f8b2c1e-6a53-4f0e-9d0e-3b1a2c4d5e6f',
  kind: 'nextcloud',
  origin: 'https://cloud.example.org',
  entryPath: '/',
  username: 'alice',
  credentialKind: 'basic',
  secretConfigured: true,
  status: 'unverified',
  pin: null,
  discoveryOpenUntil: '2026-10-12T15:20:00.000Z',
  createdAt: '2026-10-12T15:05:00.000Z',
  updatedAt: '2026-10-12T15:05:00.000Z',
}

const READ_ACCOUNT = {
  id: '0f8b2c1e-6a53-4f0e-9d0e-3b1a2c4d5e6f',
  kind: 'nextcloud',
  origin: 'https://cloud.example.org',
  entryPath: '/',
  username: 'alice',
  credentialKind: 'basic',
  status: 'unverified',
  pin: null,
  discoveryOpenUntil: Date.UTC(2026, 9, 12, 15, 20, 0),
  createdAt: '2026-10-12T15:05:00.000Z',
  updatedAt: '2026-10-12T15:05:00.000Z',
}

const refusal = (status: number, tag: string, extra: Record<string, unknown> = {}): ApiAnswer => ({
  status,
  data: { error: { tag, message: `The server said ${tag}.`, ...extra } },
})

/** An API whose every call answers with `answer`, or throws when `answer` is an Error. */
const apiAnswering = (answer: ApiAnswer | Error) => {
  const calls: { name: string; args: unknown[] }[] = []
  const respond = (name: string) => {
    return async (...args: unknown[]): Promise<ApiAnswer> => {
      calls.push({ name, args })
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    }
  }
  const api: DavBridgeApi = {
    getDavBridgeConfig: respond('getDavBridgeConfig'),
    listDavBridgeAccounts: respond('listDavBridgeAccounts'),
    createDavBridgeAccount: respond('createDavBridgeAccount'),
    replaceDavBridgeAccountSecret: respond('replaceDavBridgeAccountSecret'),
    pinDavBridgeAccount: respond('pinDavBridgeAccount'),
    deleteDavBridgeAccount: respond('deleteDavBridgeAccount'),
    deleteAllDavBridgeAccounts: respond('deleteAllDavBridgeAccounts'),
    relayDavBridgeRequest: respond('relayDavBridgeRequest'),
  }
  return { api, calls }
}

describe('what an answer to a relayed request means', () => {
  it('reads a 200 that carries a remote answer as what the other server said', () => {
    expect(relayResultOf({ status: 200, data: { remote: REMOTE } })).toEqual({ kind: 'remote', remote: REMOTE })
  })

  it.each([404, 410, 412, 403, 429, 500, 507])(
    'reads a remote %i as the other server saying so, not as a failure to reach it',
    (status) => {
      const result = relayResultOf({ status: 200, data: { remote: { ...REMOTE, status, body: '' } } })

      expect(result).toEqual({ kind: 'remote', remote: { ...REMOTE, status, body: '' } })
    },
  )

  it('keeps only the headers the contract names, and only as text', () => {
    const headers = {
      etag: '"abc"',
      'content-type': 'text/calendar',
      dav: '1',
      allow: 'GET',
      'retry-after': '30',
      location: '/moved/',
      'set-cookie': 'session=1',
      'www-authenticate': 'Basic',
      server: 'nginx',
    }

    const result = relayResultOf({ status: 200, data: { remote: { ...REMOTE, headers } } })

    expect(result.kind === 'remote' && result.remote.headers).toEqual({
      etag: '"abc"',
      'content-type': 'text/calendar',
      dav: '1',
      allow: 'GET',
      'retry-after': '30',
      location: '/moved/',
    })
    const odd = relayResultOf({ status: 200, data: { remote: { ...REMOTE, headers: { etag: 7, dav: null } } } })
    expect(odd.kind === 'remote' && odd.remote.headers).toEqual({})
  })

  it('reads a remote answer with no headers at all', () => {
    const { headers: _headers, ...bare } = REMOTE

    expect(relayResultOf({ status: 200, data: { remote: bare } })).toEqual({
      kind: 'remote',
      remote: { ...bare, headers: {} },
    })
  })

  it('keeps the bytes of an answer that is not text as the relay encoded them', () => {
    const result = relayResultOf({ status: 200, data: { remote: { ...REMOTE, bodyEncoding: 'base64', body: '/w==' } } })

    expect(result).toEqual({ kind: 'remote', remote: { ...REMOTE, bodyEncoding: 'base64', body: '/w==' } })
  })

  it.each<[string, unknown]>([
    ['no remote', {}],
    ['a remote that is not an object', { remote: 'gone' }],
    ['a remote that is a list', { remote: [REMOTE] }],
    ['no status', { remote: { ...REMOTE, status: undefined } }],
    ['a status that is text', { remote: { ...REMOTE, status: '207' } }],
    ['a status that is not a whole number', { remote: { ...REMOTE, status: 207.5 } }],
    ['a status below any HTTP status', { remote: { ...REMOTE, status: 99 } }],
    ['a status above any HTTP status', { remote: { ...REMOTE, status: 600 } }],
    ['no body', { remote: { ...REMOTE, body: undefined } }],
    ['a body that is not text', { remote: { ...REMOTE, body: { xml: true } } }],
    ['an encoding it does not know', { remote: { ...REMOTE, bodyEncoding: 'gzip' } }],
    ['no path', { remote: { ...REMOTE, path: undefined } }],
    ['a path that is not absolute', { remote: { ...REMOTE, path: 'calendars/alice/' } }],
    ['no redirect count', { remote: { ...REMOTE, redirects: undefined } }],
    ['a negative redirect count', { remote: { ...REMOTE, redirects: -1 } }],
    ['headers that are not an object', { remote: { ...REMOTE, headers: 'etag: 1' } }],
    ['headers that are a list', { remote: { ...REMOTE, headers: [] } }],
  ])('knows nothing about the other server from a 200 with %s', (_name, data) => {
    expect(relayResultOf({ status: 200, data })).toEqual({ kind: 'transport', httpStatus: 200 })
  })

  it('knows nothing from a 200 with no body', () => {
    expect(relayResultOf({ status: 200 })).toEqual({ kind: 'transport', httpStatus: 200 })
    expect(relayResultOf({ status: 200, data: null })).toEqual({ kind: 'transport', httpStatus: 200 })
  })

  it('reads a refusal with its tag, its sentence and whatever else it names', () => {
    const result = relayResultOf(refusal(429, 'dav-rate-limited', { retryAfterSeconds: 12, budget: 'requests' }))

    expect(result).toEqual({
      kind: 'refused',
      httpStatus: 429,
      tag: 'dav-rate-limited',
      message: 'The server said dav-rate-limited.',
      extra: { retryAfterSeconds: 12, budget: 'requests' },
    })
  })

  it('reads a refusal that has no sentence', () => {
    const result = relayResultOf({ status: 409, data: { error: { tag: 'dav-password-rejected', message: 7 } } })

    expect(result).toEqual({ kind: 'refused', httpStatus: 409, tag: 'dav-password-rejected', message: '', extra: {} })
  })

  it('does not take a remote answer from an answer that is not a 200', () => {
    expect(relayResultOf({ status: 201, data: { remote: REMOTE } })).toEqual({ kind: 'transport', httpStatus: 201 })
    expect(relayResultOf({ status: 502, data: { remote: REMOTE } })).toEqual({ kind: 'transport', httpStatus: 502 })
    expect(relayResultOf({ status: 404, data: { remote: REMOTE, error: { tag: 'dav-account-not-found' } } })).toEqual({
      kind: 'refused',
      httpStatus: 404,
      tag: 'dav-account-not-found',
      message: '',
      extra: {},
    })
  })

  it('does not take a refusal from a 200', () => {
    const answer = { status: 200, data: { error: { tag: 'dav-rate-limited', message: 'no' } } }

    expect(relayResultOf(answer)).toEqual({ kind: 'transport', httpStatus: 200 })
  })

  it.each<[string, ApiAnswer]>([
    ['an expired session', { status: 401, data: { error: { tag: 'invalid-auth', message: 'Sign in again.' } } }],
    ['the general rate limit of the server', { status: 429, data: { error: { message: 'Too many requests.' } } }],
    ['a bare server error', { status: 500, data: { error: { message: 'Unknown error' } } }],
    ['a gateway that is down', { status: 502, data: { error: { message: 'Request failed with HTTP 502.' } } }],
    ['a tag that is not text', { status: 403, data: { error: { tag: ['dav-busy'] } } }],
    ['a tag that only contains the prefix', { status: 403, data: { error: { tag: 'not-dav-busy' } } }],
    ['an error that is not an object', { status: 403, data: { error: 'dav-busy' } }],
    ['no body', { status: 503 }],
  ])('reads %s as nothing known about the other server', (_name, answer) => {
    expect(relayResultOf(answer)).toEqual({ kind: 'transport', httpStatus: answer.status })
  })

  it('tells a request that got no answer at all from one the server answered', () => {
    const offline = {
      status: 500,
      data: { networkFailure: true, timedOut: false, error: { message: 'Network request failed' } },
    }

    expect(relayResultOf(offline)).toEqual({ kind: 'transport', httpStatus: null })
  })
})

describe('how long the app waits for the relay', () => {
  it('waits longer than the relay waits for the other server', () => {
    expect(relayDeadlineMs(30_000)).toBe(45_000)
    expect(relayDeadlineMs(30_000) - 30_000).toBe(RELAY_ANSWER_MARGIN_MS)
    expect(relayDeadlineMs(1)).toBe(15_001)
  })

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the documented thirty seconds for %p',
    (value) => {
      expect(relayDeadlineMs(value)).toBe(45_000)
    },
  )

  it('does not wait without limit because a server said so', () => {
    expect(relayDeadlineMs(120_000)).toBe(135_000)
    expect(relayDeadlineMs(120_001)).toBe(135_000)
    expect(relayDeadlineMs(86_400_000)).toBe(135_000)
  })
})

describe('the relay transport', () => {
  it('sends the envelope, the account and the deadline, and reads the answer', async () => {
    const { api, calls } = apiAnswering({ status: 200, data: { remote: REMOTE } })
    const transport = new RelayTransport(api, 'account-1', 45_000)

    const result = await transport.request({
      method: 'REPORT',
      path: '/calendars/alice/personal/',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: '<c:calendar-query/>',
    })

    expect(result).toEqual({ kind: 'remote', remote: REMOTE })
    expect(calls).toEqual([
      {
        name: 'relayDavBridgeRequest',
        args: [
          'account-1',
          {
            method: 'REPORT',
            path: '/calendars/alice/personal/',
            headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
            body: '<c:calendar-query/>',
          },
          45_000,
        ],
      },
    ])
  })

  it('sends no body and no headers when the request has none', async () => {
    const { api, calls } = apiAnswering({ status: 200, data: { remote: REMOTE } })

    await new RelayTransport(api, 'account-1', 45_000).request({ method: 'GET', path: '/calendars/alice/a.ics' })

    expect(calls[0].args[1]).toEqual({ method: 'GET', path: '/calendars/alice/a.ics' })
    expect(Object.keys(calls[0].args[1] as object)).toEqual(['method', 'path'])
  })

  it('leaves out a header that was named without a value, and keeps an empty body', async () => {
    const { api, calls } = apiAnswering({ status: 200, data: { remote: REMOTE } })

    await new RelayTransport(api, 'account-1', 45_000).request({
      method: 'PROPFIND',
      path: '/',
      headers: { depth: '0', 'if-match': undefined },
      body: '',
    })

    expect(calls[0].args[1]).toEqual({ method: 'PROPFIND', path: '/', headers: { depth: '0' }, body: '' })
    expect(Object.keys((calls[0].args[1] as { headers: object }).headers)).toEqual(['depth'])
  })

  it('reports a call that threw as nothing known, never as an answer', async () => {
    const { api } = apiAnswering(new Error('aborted'))

    const result = await new RelayTransport(api, 'account-1', 45_000).request({ method: 'GET', path: '/a.ics' })

    expect(result).toEqual({ kind: 'transport', httpStatus: null })
  })

  it('passes a refusal on', async () => {
    const { api } = apiAnswering(refusal(403, 'dav-path-not-allowed'))

    const result = await new RelayTransport(api, 'account-1', 45_000).request({ method: 'GET', path: '/a.ics' })

    expect(result).toMatchObject({ kind: 'refused', httpStatus: 403, tag: 'dav-path-not-allowed' })
  })
})

describe('finding the bridge calls on an API service', () => {
  it('hands back the service itself when it has all eight', () => {
    const { api } = apiAnswering({ status: 200 })

    expect(davBridgeApiOf(api)).toBe(api)
  })

  it.each([
    'getDavBridgeConfig',
    'listDavBridgeAccounts',
    'createDavBridgeAccount',
    'replaceDavBridgeAccountSecret',
    'pinDavBridgeAccount',
    'deleteDavBridgeAccount',
    'deleteAllDavBridgeAccounts',
    'relayDavBridgeRequest',
  ])('finds none on a service built before %s existed', (name) => {
    const { api } = apiAnswering({ status: 200 })
    const older: Record<string, unknown> = { ...api }
    delete older[name]

    expect(davBridgeApiOf(older)).toBeUndefined()
    expect(davBridgeApiOf({ ...api, [name]: 'not a function' })).toBeUndefined()
  })

  it('finds none on something that is not a service', () => {
    expect(davBridgeApiOf(undefined)).toBeUndefined()
    expect(davBridgeApiOf(null)).toBeUndefined()
    expect(davBridgeApiOf('api')).toBeUndefined()
  })
})

describe('reading the configuration', () => {
  it('reads the documented answer', async () => {
    const { api } = apiAnswering({ status: 200, data: CONFIG })

    expect(await readBridgeConfig(api)).toEqual({ ok: true, value: CONFIG })
  })

  it('is not available in a mode this build does not implement, whatever the server claims', async () => {
    const { api } = apiAnswering({ status: 200, data: { ...CONFIG, mode: 'mirror', available: true } })

    const result = await readBridgeConfig(api)

    expect(result).toEqual({ ok: true, value: { ...CONFIG, mode: 'mirror', available: false } })
  })

  it('is not available when the server says it is not', async () => {
    const { api } = apiAnswering({ status: 200, data: { ...CONFIG, enabled: false, available: false } })

    const result = await readBridgeConfig(api)

    expect(result).toEqual({ ok: true, value: { ...CONFIG, enabled: false, available: false } })
  })

  it('drops a method that is not text', async () => {
    const { api } = apiAnswering({ status: 200, data: { ...CONFIG, methods: ['GET', 7, null, 'REPORT'] } })

    const result = await readBridgeConfig(api)

    expect(result.ok && result.value.methods).toEqual(['GET', 'REPORT'])
  })

  it.each<[string, unknown]>([
    ['no switch', { ...CONFIG, enabled: undefined }],
    ['a switch that is text', { ...CONFIG, enabled: 'true' }],
    ['no permission', { ...CONFIG, allowed: undefined }],
    ['no availability', { ...CONFIG, available: undefined }],
    ['no mode', { ...CONFIG, mode: undefined }],
    ['no word on writing', { ...CONFIG, writeEnabled: undefined }],
    ['methods that are not a list', { ...CONFIG, methods: 'GET' }],
    ['no limits', { ...CONFIG, limits: undefined }],
    ['a limit that is missing', { ...CONFIG, limits: { ...CONFIG.limits, requestsPerTenMinutes: undefined } }],
    ['a limit that is text', { ...CONFIG, limits: { ...CONFIG.limits, requestTimeoutMs: '30000' } }],
    ['a limit that is negative', { ...CONFIG, limits: { ...CONFIG.limits, maxAccounts: -1 } }],
    ['a limit that is not a whole number', { ...CONFIG, limits: { ...CONFIG.limits, pathLength: 20.48 } }],
  ])('cannot read a configuration with %s', async (_name, data) => {
    const { api } = apiAnswering({ status: 200, data })

    expect(await readBridgeConfig(api)).toEqual({ ok: false, failure: { kind: 'malformed' } })
  })

  it.each(Object.keys(CONFIG.limits))('needs the limit %s', async (name) => {
    const limits: Record<string, unknown> = { ...CONFIG.limits }
    delete limits[name]
    const { api } = apiAnswering({ status: 200, data: { ...CONFIG, limits } })

    expect(await readBridgeConfig(api)).toEqual({ ok: false, failure: { kind: 'malformed' } })
  })

  it('reports why there is no configuration', async () => {
    expect(await readBridgeConfig(apiAnswering(refusal(503, 'dav-settings-unavailable')).api)).toEqual({
      ok: false,
      failure: {
        kind: 'refused',
        httpStatus: 503,
        tag: 'dav-settings-unavailable',
        message: 'The server said dav-settings-unavailable.',
        extra: {},
      },
    })
    expect(await readBridgeConfig(apiAnswering({ status: 401, data: { error: { tag: 'invalid-auth' } } }).api)).toEqual(
      {
        ok: false,
        failure: { kind: 'transport', httpStatus: 401 },
      },
    )
    expect(await readBridgeConfig(apiAnswering({ status: 500, data: { networkFailure: true } }).api)).toEqual({
      ok: false,
      failure: { kind: 'transport', httpStatus: null },
    })
    expect(await readBridgeConfig(apiAnswering(new Error('offline')).api)).toEqual({
      ok: false,
      failure: { kind: 'transport', httpStatus: null },
    })
    expect(await readBridgeConfig(apiAnswering({ status: 200 }).api)).toEqual({
      ok: false,
      failure: { kind: 'malformed' },
    })
  })
})

describe('reading accounts', () => {
  it('reads the documented account, and nothing about its password', async () => {
    const { api } = apiAnswering({ status: 200, data: { accounts: [ACCOUNT] } })

    const result = await listBridgeAccounts(api)

    expect(result).toEqual({ ok: true, value: [READ_ACCOUNT] })
    expect(result.ok && Object.keys(result.value[0]).sort()).toEqual(Object.keys(READ_ACCOUNT).sort())
  })

  it('keeps nothing a faulty server sends beside the documented fields', async () => {
    const leaky = { ...ACCOUNT, secret: 'app-password', password: 'app-password', authorization: 'Basic YWxpY2U6' }
    const { api } = apiAnswering({ status: 200, data: { accounts: [leaky] } })

    const result = await listBridgeAccounts(api)

    expect(JSON.stringify(result)).not.toContain('app-password')
    expect(JSON.stringify(result)).not.toContain('YWxpY2U6')
    expect(result).toEqual({ ok: true, value: [READ_ACCOUNT] })
  })

  it('reads an empty list as no accounts', async () => {
    expect(await listBridgeAccounts(apiAnswering({ status: 200, data: { accounts: [] } }).api)).toEqual({
      ok: true,
      value: [],
    })
  })

  it('reads a pin', async () => {
    const pin = { principalPath: '/principals/users/alice/', calendarHomePath: '/calendars/alice/' }
    const pinned = { ...ACCOUNT, status: 'ok', pin: { ...pin, more: 1 }, discoveryOpenUntil: null }
    const { api } = apiAnswering({ status: 200, data: { accounts: [pinned] } })

    const result = await listBridgeAccounts(api)

    expect(result).toEqual({ ok: true, value: [{ ...READ_ACCOUNT, status: 'ok', pin, discoveryOpenUntil: null }] })
  })

  it.each(['unverified', 'ok', 'password-rejected', 'secret-unreadable'])('reads the status %s', async (status) => {
    const { api } = apiAnswering({ status: 200, data: { accounts: [{ ...ACCOUNT, status }] } })

    const result = await listBridgeAccounts(api)

    expect(result.ok && result.value[0].status).toBe(status)
  })

  it('does not pass a status it does not know off as one it does', async () => {
    const { api } = apiAnswering({ status: 200, data: { accounts: [{ ...ACCOUNT, status: 'suspended' }, ACCOUNT] } })

    const result = await listBridgeAccounts(api)

    expect(result.ok && result.value.map((account) => account.status)).toEqual(['unknown', 'unverified'])
  })

  it('reads the looser fields with a safe meaning when they are missing or odd', async () => {
    const odd = {
      ...ACCOUNT,
      kind: 'exchange',
      entryPath: 'dav',
      credentialKind: 'bearer',
      discoveryOpenUntil: 'soon',
      createdAt: 5,
      updatedAt: undefined,
    }
    const { api } = apiAnswering({ status: 200, data: { accounts: [odd] } })

    const result = await listBridgeAccounts(api)

    expect(result).toEqual({
      ok: true,
      value: [
        {
          ...READ_ACCOUNT,
          kind: 'caldav',
          entryPath: '/',
          credentialKind: 'bearer',
          discoveryOpenUntil: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
    })
  })

  it('treats a discovery window it was not told about as closed', async () => {
    const { discoveryOpenUntil: _window, ...silent } = ACCOUNT
    const { api } = apiAnswering({ status: 200, data: { accounts: [silent, { ...ACCOUNT, discoveryOpenUntil: 1 }] } })

    const result = await listBridgeAccounts(api)

    expect(result.ok && result.value.map((account) => account.discoveryOpenUntil)).toEqual([null, null])
  })

  it.each<[string, unknown]>([
    ['no list', {}],
    ['a list that is an object', { accounts: { 0: ACCOUNT } }],
    ['an account that is not an object', { accounts: [ACCOUNT, 'account'] }],
    ['an account with no id', { accounts: [{ ...ACCOUNT, id: undefined }] }],
    ['an account with an empty id', { accounts: [{ ...ACCOUNT, id: '' }] }],
    ['an account with no origin', { accounts: [{ ...ACCOUNT, origin: undefined }] }],
    ['an account with an empty origin', { accounts: [{ ...ACCOUNT, origin: '' }] }],
    ['an account with no user name', { accounts: [{ ...ACCOUNT, username: undefined }] }],
    ['a pin that is text', { accounts: [{ ...ACCOUNT, pin: '/calendars/alice/' }] }],
    ['a pin with no principal', { accounts: [{ ...ACCOUNT, pin: { calendarHomePath: '/calendars/alice/' } }] }],
    ['a pin with no calendar home', { accounts: [{ ...ACCOUNT, pin: { principalPath: '/principals/alice/' } }] }],
  ])('cannot read a listing with %s, and reads none of it', async (_name, data) => {
    const { api } = apiAnswering({ status: 200, data })

    expect(await listBridgeAccounts(api)).toEqual({ ok: false, failure: { kind: 'malformed' } })
  })

  it('allows an account whose user name is empty, as a token account has', async () => {
    const { api } = apiAnswering({ status: 200, data: { accounts: [{ ...ACCOUNT, username: '' }] } })

    const result = await listBridgeAccounts(api)

    expect(result.ok && result.value[0].username).toBe('')
  })
})

describe('changing accounts', () => {
  const NEW = {
    kind: 'nextcloud' as const,
    url: 'https://cloud.example.org/',
    username: 'alice',
    secret: 'app-password',
  }

  it('creates an account and reads back what the server made of it', async () => {
    const { api, calls } = apiAnswering({ status: 201, data: { account: ACCOUNT } })

    const result = await createBridgeAccount(api, NEW)

    expect(result).toEqual({ ok: true, value: READ_ACCOUNT })
    expect(calls).toEqual([{ name: 'createDavBridgeAccount', args: [NEW] }])
    expect(JSON.stringify(result)).not.toContain('app-password')
  })

  it('reports why an account was not created, with the field or address the server names', async () => {
    const field = await createBridgeAccount(apiAnswering(refusal(400, 'dav-invalid-input', { field: 'url' })).api, NEW)
    const address = await createBridgeAccount(
      apiAnswering(refusal(403, 'dav-address-not-allowed', { origin: 'https://cloud.example.org' })).api,
      NEW,
    )

    expect(field).toMatchObject({
      ok: false,
      failure: { kind: 'refused', tag: 'dav-invalid-input', extra: { field: 'url' } },
    })
    expect(address).toMatchObject({
      ok: false,
      failure: { kind: 'refused', httpStatus: 403, extra: { origin: 'https://cloud.example.org' } },
    })
  })

  it('does not report an account created when the answer has none in it', async () => {
    expect(await createBridgeAccount(apiAnswering({ status: 201, data: {} }).api, NEW)).toEqual({
      ok: false,
      failure: { kind: 'malformed' },
    })
    expect(await createBridgeAccount(apiAnswering({ status: 201, data: { account: { id: 'x' } } }).api, NEW)).toEqual({
      ok: false,
      failure: { kind: 'malformed' },
    })
  })

  it('does not take an account from an answer that is not a success', async () => {
    const result = await createBridgeAccount(apiAnswering({ status: 500, data: { account: ACCOUNT } }).api, NEW)

    expect(result).toEqual({ ok: false, failure: { kind: 'transport', httpStatus: 500 } })
  })

  it('replaces the secret of the account it was asked to', async () => {
    const { api, calls } = apiAnswering({ status: 200, data: { account: ACCOUNT } })

    const result = await replaceBridgeSecret(api, 'account-1', { secret: 'new-app-password' })

    expect(result).toEqual({ ok: true, value: READ_ACCOUNT })
    expect(calls).toEqual([
      { name: 'replaceDavBridgeAccountSecret', args: ['account-1', { secret: 'new-app-password' }] },
    ])
  })

  it('pins the account it was asked to', async () => {
    const pin = { principalPath: '/principals/users/alice/', calendarHomePath: '/calendars/alice/' }
    const { api, calls } = apiAnswering({ status: 200, data: { account: { ...ACCOUNT, pin } } })

    const result = await pinBridgeAccount(api, 'account-1', pin)

    expect(result).toEqual({ ok: true, value: { ...READ_ACCOUNT, pin } })
    expect(calls).toEqual([{ name: 'pinDavBridgeAccount', args: ['account-1', pin] }])
  })

  it('reports a pin the server would not take', async () => {
    const pin = { principalPath: '/principals/users/alice/', calendarHomePath: '/calendars/alice/' }

    const result = await pinBridgeAccount(apiAnswering(refusal(409, 'dav-pin-locked')).api, 'account-1', pin)

    expect(result).toMatchObject({ ok: false, failure: { kind: 'refused', httpStatus: 409, tag: 'dav-pin-locked' } })
  })

  it('reports an account deleted only when the server says it is', async () => {
    const { api, calls } = apiAnswering({ status: 200, data: { deleted: true } })

    expect(await deleteBridgeAccount(api, 'account-1')).toEqual({ ok: true, value: true })
    expect(calls).toEqual([{ name: 'deleteDavBridgeAccount', args: ['account-1'] }])
    for (const data of [{ deleted: false }, { deleted: 1 }, { deleted: 'true' }, {}]) {
      expect(await deleteBridgeAccount(apiAnswering({ status: 200, data }).api, 'account-1')).toEqual({
        ok: false,
        failure: { kind: 'malformed' },
      })
    }
    expect(
      await deleteBridgeAccount(apiAnswering(refusal(404, 'dav-account-not-found')).api, 'account-1'),
    ).toMatchObject({ ok: false, failure: { kind: 'refused', tag: 'dav-account-not-found' } })
    expect(await deleteBridgeAccount(apiAnswering(new Error('offline')).api, 'account-1')).toEqual({
      ok: false,
      failure: { kind: 'transport', httpStatus: null },
    })
  })

  it('reports how many accounts the server removed', async () => {
    expect(await deleteAllBridgeAccounts(apiAnswering({ status: 200, data: { deleted: 3 } }).api)).toEqual({
      ok: true,
      value: 3,
    })
    expect(await deleteAllBridgeAccounts(apiAnswering({ status: 200, data: { deleted: 0 } }).api)).toEqual({
      ok: true,
      value: 0,
    })
    for (const data of [{ deleted: true }, { deleted: -1 }, { deleted: 1.5 }, {}]) {
      expect(await deleteAllBridgeAccounts(apiAnswering({ status: 200, data }).api)).toEqual({
        ok: false,
        failure: { kind: 'malformed' },
      })
    }
  })
})
