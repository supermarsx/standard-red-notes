import { DavBridgeRefusal } from './DavBridgeRefusal'
import { DavNetworkPolicy } from './DavNetworkPolicy'
import {
  assertValidDavPath,
  assertValidDavPinPath,
  DAV_READ_METHODS,
  DAV_RELAY_LIMITS,
  DAV_RELAY_WRITE_ENABLED,
  DAV_WRITE_METHODS,
  DavRelay,
  DavRelayAbortedError,
  DavRelayRequest,
  DavRelayTarget,
  parseDavRelayEnvelope,
} from './DavRelay'
import { SecretString } from './SecretString'
import { AttemptedConnection, FakeRemote, recordingFactory, resolver } from './DavBridgeTestKit.spec'

const refusalOf = (action: () => unknown): DavBridgeRefusal => {
  try {
    action()
  } catch (error) {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    throw error
  }
  throw new Error('expected a refusal, and nothing was thrown')
}

const refusalFrom = async (action: Promise<unknown>): Promise<DavBridgeRefusal> => {
  try {
    await action
  } catch (error) {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    throw error
  }
  throw new Error('expected a refusal, and the call resolved')
}

describe('assertValidDavPath', () => {
  it.each([
    '/',
    '/remote.php/dav/',
    '/remote.php/dav/calendars/alice/personal/',
    '/remote.php/dav/calendars/alice/personal/0f8b2c1e.ics',
    '/calendars/alice%40example.org/work/',
    '/alice/calendar.ics/',
    '/dav.php/calendars/bob/default/event%20one.ics',
    '/a/b;c=d/e',
    '/.well-known/caldav',
    '/a/..b/',
    '/a/.hidden/',
    '/a/b...c',
    "/a/it's/",
    '/%E4%BC%9A%E8%AE%AE.ics',
  ])('accepts %s unchanged', (path) => {
    expect(assertValidDavPath(path)).toBe(path)
  })

  it.each([
    ['not a string', 42, 'path-shape'],
    ['empty', '', 'path-shape'],
    ['relative', 'remote.php/dav/', 'path-not-absolute'],
    ['a full URL', 'https://other.example/dav/', 'path-not-absolute'],
    ['protocol-relative', '//other.example/dav/', 'path-empty-segment'],
    ['an empty segment', '/a//b', 'path-empty-segment'],
    ['a dot segment', '/a/./b', 'path-dot-segment'],
    ['a parent segment', '/a/../b', 'path-dot-segment'],
    ['a trailing parent segment', '/a/..', 'path-dot-segment'],
    ['an encoded parent segment', '/a/%2e%2e/b', 'path-dot-segment'],
    ['a half-encoded parent segment', '/a/.%2E/b', 'path-dot-segment'],
    ['an encoded dot segment', '/a/%2e/b', 'path-dot-segment'],
    ['an encoded slash', '/a/b%2fc', 'path-encoded-separator'],
    ['an encoded slash, upper case', '/a/b%2Fc', 'path-encoded-separator'],
    ['an encoded backslash', '/a/b%5cc', 'path-encoded-separator'],
    ['a backslash', '/a\\b', 'path-backslash'],
    ['a query', '/a/b?x=1', 'path-query'],
    ['a fragment', '/a/b#x', 'path-query'],
    ['an encoded NUL', '/a/%00b', 'path-encoded-control'],
    ['an encoded line feed', '/a/%0ab', 'path-encoded-control'],
    ['an encoded carriage return', '/a/%0Db', 'path-encoded-control'],
    ['an encoded DEL', '/a/%7fb', 'path-encoded-control'],
    ['a raw space', '/a b', 'path-raw-character'],
    ['a raw tab', '/a\tb', 'path-raw-character'],
    ['a raw line feed', '/a\nb', 'path-raw-character'],
    ['a raw NUL', '/a\u0000b', 'path-raw-character'],
    ['raw non-ASCII', '/café', 'path-raw-character'],
    ['a truncated escape', '/a/%2', 'path-escape'],
    ['a non-hex escape', '/a/%zz', 'path-escape'],
    ['a lone percent sign', '/a/100%/b', 'path-escape'],
    ['a character the URL parser would rewrite', '/a/{b}', 'path-not-canonical'],
  ])('refuses %s', (_label, path, logTag) => {
    const refusal = refusalOf(() => assertValidDavPath(path))

    expect(refusal.tag).toBe('dav-invalid-path')
    expect(refusal.httpStatus).toBe(400)
    expect(refusal.logTag).toBe(logTag)
  })

  it('refuses a path longer than the limit and accepts one exactly at it', () => {
    const atLimit = `/${'a'.repeat(DAV_RELAY_LIMITS.pathLength - 1)}`

    expect(assertValidDavPath(atLimit)).toBe(atLimit)
    expect(refusalOf(() => assertValidDavPath(`${atLimit}a`)).logTag).toBe('path-shape')
  })

  it('never echoes the refused path back', () => {
    const refusal = refusalOf(() => assertValidDavPath('/secret-name/../x'))

    expect(JSON.stringify(refusal.toBody())).not.toContain('secret-name')
  })
})

describe('assertValidDavPinPath', () => {
  it('accepts a directory path under the server root', () => {
    expect(assertValidDavPinPath('/remote.php/dav/calendars/alice/', 'calendarHomePath')).toBe(
      '/remote.php/dav/calendars/alice/',
    )
    expect(assertValidDavPinPath('/alice/', 'principalPath')).toBe('/alice/')
  })

  it.each([
    ['the whole server', '/'],
    ['a path that is not a directory', '/remote.php/dav/calendars/alice'],
    ['a path with a parent segment', '/remote.php/dav/../files/'],
    ['a relative path', 'calendars/alice/'],
    ['a non-string', { path: '/a/' }],
    ['nothing', undefined],
  ])('refuses %s as a pin, naming the field', (_label, value) => {
    const refusal = refusalOf(() => assertValidDavPinPath(value, 'calendarHomePath'))

    expect(refusal.tag).toBe('dav-invalid-input')
    expect(refusal.extra).toEqual({ field: 'calendarHomePath' })
  })
})

describe('parseDavRelayEnvelope', () => {
  const valid = { method: 'PROPFIND', path: '/dav/' }

  it('accepts each read method and nothing is added to the request that the caller did not send', () => {
    for (const method of DAV_READ_METHODS) {
      expect(parseDavRelayEnvelope({ method, path: '/dav/' })).toEqual({
        method,
        path: '/dav/',
        headers: {},
        body: undefined,
      })
    }
  })

  it('this build never forwards writes', () => {
    expect(DAV_RELAY_WRITE_ENABLED).toBe(false)
  })

  it.each([...DAV_WRITE_METHODS])('refuses the write method %s by name, on the server', (method) => {
    const refusal = refusalOf(() =>
      parseDavRelayEnvelope({
        method,
        path: '/dav/calendars/alice/personal/x.ics',
        headers: { 'content-type': 'text/calendar', 'if-none-match': '*' },
        body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      }),
    )

    expect(refusal.tag).toBe('dav-writes-disabled')
    expect(refusal.httpStatus).toBe(403)
    expect(refusal.extra).toEqual({ method })
  })

  it.each([
    'POST',
    'PROPPATCH',
    'MOVE',
    'COPY',
    'LOCK',
    'UNLOCK',
    'MKCOL',
    'HEAD',
    'PATCH',
    'TRACE',
    'CONNECT',
    'ACL',
    'propfind',
    'Get',
    ' GET',
    'GET ',
  ])('refuses the method %p', (method) => {
    const refusal = refusalOf(() => parseDavRelayEnvelope({ method, path: '/dav/' }))

    expect(refusal.tag).toBe('dav-method-not-allowed')
    expect(refusal.httpStatus).toBe(400)
  })

  it('does not echo a method that is not a plain word', () => {
    const refusal = refusalOf(() => parseDavRelayEnvelope({ method: 'GET /x HTTP/1.1\r\nHost: evil', path: '/dav/' }))

    expect(refusal.extra).toEqual({ method: 'invalid' })
  })

  it.each([
    ['not an object', 'PROPFIND /dav/'],
    ['an array', [valid]],
    ['null', null],
  ])('refuses an envelope that is %s', (_label, envelope) => {
    expect(refusalOf(() => parseDavRelayEnvelope(envelope)).tag).toBe('dav-invalid-input')
  })

  it('refuses a missing or non-string method', () => {
    expect(refusalOf(() => parseDavRelayEnvelope({ path: '/dav/' })).extra).toEqual({ field: 'method' })
    expect(refusalOf(() => parseDavRelayEnvelope({ method: ['GET'], path: '/dav/' })).extra).toEqual({
      field: 'method',
    })
  })

  it('puts the path through the path rules', () => {
    expect(refusalOf(() => parseDavRelayEnvelope({ method: 'GET', path: '/a/../b' })).tag).toBe('dav-invalid-path')
    expect(refusalOf(() => parseDavRelayEnvelope({ method: 'GET' })).tag).toBe('dav-invalid-path')
  })

  describe('headers', () => {
    it('passes the five allowed headers through under their canonical names', () => {
      const request = parseDavRelayEnvelope({
        method: 'REPORT',
        path: '/dav/cal/',
        headers: {
          depth: '1',
          'if-match': '"abc"',
          'if-none-match': '*',
          'content-type': 'application/xml; charset=utf-8',
          prefer: 'return=minimal',
        },
        body: '<x/>',
      })

      expect(request.headers).toEqual({
        Depth: '1',
        'If-Match': '"abc"',
        'If-None-Match': '*',
        'Content-Type': 'application/xml; charset=utf-8',
        Prefer: 'return=minimal',
      })
    })

    it.each([
      'authorization',
      'cookie',
      'host',
      'x-forwarded-for',
      'destination',
      'overwrite',
      'user-agent',
      'accept-encoding',
      'content-length',
      'transfer-encoding',
      'Depth',
      'DEPTH',
      '__proto__',
      'constructor',
      'toString',
    ])('refuses the header %p rather than dropping it', (name) => {
      const refusal = refusalOf(() =>
        parseDavRelayEnvelope({ method: 'PROPFIND', path: '/dav/', headers: JSON.parse(`{"${name}":"1"}`) }),
      )

      expect(refusal.tag).toBe('dav-header-not-allowed')
      expect(refusal.httpStatus).toBe(400)
    })

    it.each([
      ['a line break', 'return=minimal\r\nX-Injected: 1'],
      ['a bare line feed', '1\n'],
      ['a NUL', 'a\u0000b'],
      ['non-ASCII', 'café'],
      ['an empty value', ''],
      ['a number', 1],
      ['an array', ['1']],
      ['a value past the limit', 'a'.repeat(DAV_RELAY_LIMITS.headerValueLength + 1)],
    ])('refuses a header value that is %s', (_label, value) => {
      const refusal = refusalOf(() =>
        parseDavRelayEnvelope({ method: 'PROPFIND', path: '/dav/', headers: { prefer: value } }),
      )

      expect(refusal.tag).toBe('dav-header-not-allowed')
      expect(refusal.extra).toEqual({ header: 'prefer' })
    })

    it.each(['infinity', 'Infinity', '2', '-1', '0,1', ' 1'])('refuses depth %p', (depth) => {
      const refusal = refusalOf(() => parseDavRelayEnvelope({ method: 'PROPFIND', path: '/dav/', headers: { depth } }))

      expect(refusal.tag).toBe('dav-header-not-allowed')
      expect(refusal.extra).toEqual({ header: 'depth' })
    })

    it.each([
      'application/xml',
      'text/xml',
      'text/calendar',
      'application/xml; charset=utf-8',
      'text/xml;charset=UTF-8',
      'text/calendar; charset=utf-8; component=VEVENT',
      'Application/XML; charset="utf-8"',
    ])('accepts the content type %p', (contentType) => {
      expect(
        parseDavRelayEnvelope({
          method: 'REPORT',
          path: '/dav/',
          headers: { 'content-type': contentType },
          body: '<x/>',
        }).headers['Content-Type'],
      ).toBe(contentType)
    })

    it.each([
      'application/json',
      'text/html',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/xml; charset=utf-16',
      'application/xml; charset=iso-8859-1',
      'text/calendarx',
      'xapplication/xml',
      'application/xml, text/html',
    ])('refuses the content type %p', (contentType) => {
      const refusal = refusalOf(() =>
        parseDavRelayEnvelope({
          method: 'REPORT',
          path: '/dav/',
          headers: { 'content-type': contentType },
          body: '<x/>',
        }),
      )

      expect(refusal.tag).toBe('dav-header-not-allowed')
      expect(refusal.extra).toEqual({ header: 'content-type' })
    })

    it('refuses headers that are not an object', () => {
      expect(refusalOf(() => parseDavRelayEnvelope({ ...valid, headers: [['depth', '1']] })).extra).toEqual({
        field: 'headers',
      })
    })
  })

  describe('body', () => {
    it('turns the body into UTF-8 bytes', () => {
      const request = parseDavRelayEnvelope({
        method: 'REPORT',
        path: '/dav/',
        headers: { 'content-type': 'application/xml' },
        body: '<d:prop>café</d:prop>',
      })

      expect(request.body?.toString('utf8')).toBe('<d:prop>café</d:prop>')
      expect(request.body?.byteLength).toBe(22)
    })

    it('treats an absent, null or empty body as no body', () => {
      for (const body of [undefined, null, '']) {
        expect(parseDavRelayEnvelope({ ...valid, body }).body).toBeUndefined()
      }
    })

    it('refuses a body that is not a string', () => {
      expect(
        refusalOf(() =>
          parseDavRelayEnvelope({ ...valid, headers: { 'content-type': 'application/xml' }, body: { xml: '<x/>' } }),
        ).extra,
      ).toEqual({ field: 'body' })
    })

    it('accepts a body exactly at the ceiling and refuses one byte more', () => {
      const headers = { 'content-type': 'application/xml' }
      const atLimit = 'a'.repeat(DAV_RELAY_LIMITS.requestBodyBytes)

      expect(parseDavRelayEnvelope({ method: 'REPORT', path: '/dav/', headers, body: atLimit }).body?.byteLength).toBe(
        DAV_RELAY_LIMITS.requestBodyBytes,
      )

      const refusal = refusalOf(() =>
        parseDavRelayEnvelope({ method: 'REPORT', path: '/dav/', headers, body: `${atLimit}a` }),
      )
      expect(refusal.tag).toBe('dav-request-too-large')
      expect(refusal.httpStatus).toBe(413)
      expect(refusal.extra).toEqual({ limit: DAV_RELAY_LIMITS.requestBodyBytes })
    })

    it('counts bytes, not characters: a body under the limit in characters and over it in bytes is refused', () => {
      const body = 'é'.repeat(DAV_RELAY_LIMITS.requestBodyBytes / 2 + 1)

      expect(body.length).toBeLessThan(DAV_RELAY_LIMITS.requestBodyBytes)
      expect(
        refusalOf(() =>
          parseDavRelayEnvelope({
            method: 'REPORT',
            path: '/dav/',
            headers: { 'content-type': 'application/xml' },
            body,
          }),
        ).tag,
      ).toBe('dav-request-too-large')
    })

    it.each(['GET', 'OPTIONS'])('refuses a body on %s', (method) => {
      expect(
        refusalOf(() =>
          parseDavRelayEnvelope({
            method,
            path: '/dav/',
            headers: { 'content-type': 'application/xml' },
            body: '<x/>',
          }),
        ).extra,
      ).toEqual({ field: 'body' })
    })

    it('refuses a body with no content type, and a content type with no body', () => {
      expect(refusalOf(() => parseDavRelayEnvelope({ method: 'REPORT', path: '/dav/', body: '<x/>' })).logTag).toBe(
        'header-content-type-missing',
      )
      expect(
        refusalOf(() => parseDavRelayEnvelope({ ...valid, headers: { 'content-type': 'application/xml' } })).logTag,
      ).toBe('header-content-type-without-body')
    })
  })
})

describe('DavRelay.forward', () => {
  const ORIGIN = 'https://cloud.example.org'
  const HOME = '/remote.php/dav/calendars/alice/'
  const PRINCIPAL = '/remote.php/dav/principals/users/alice/'

  let remote: FakeRemote
  let attempts: AttemptedConnection[]
  let relay: DavRelay
  let dns: ReturnType<typeof resolver>

  const target = (overrides: Partial<DavRelayTarget> = {}): DavRelayTarget => ({
    origin: ORIGIN,
    credentialKind: 'basic',
    username: 'alice',
    secret: new SecretString('app-password'),
    pin: { principalPath: PRINCIPAL, calendarHomePath: HOME },
    discoveryOpen: false,
    allowedPrivateOrigins: new Set<string>(),
    ...overrides,
  })

  const request = (overrides: Partial<DavRelayRequest> = {}): DavRelayRequest => ({
    method: 'PROPFIND',
    path: HOME,
    headers: {},
    body: undefined,
    ...overrides,
  })

  const build = (timeoutMs?: number): void => {
    const recording = recordingFactory(remote)
    attempts = recording.attempts
    dns = resolver({ 'cloud.example.org': ['93.184.216.34'], 'nextcloud.lan': ['192.168.1.20'] })
    const policy = new DavNetworkPolicy({
      resolveHost: dns,
      requestFactory: recording.factory,
      resolveOwnServiceName: async () => {
        throw new Error('ENOTFOUND')
      },
      ownInterfaceAddresses: () => [],
    })
    relay = new DavRelay(policy, () => Date.now(), timeoutMs)
  }

  beforeEach(async () => {
    remote = new FakeRemote()
    await remote.start()
    build()
  })

  afterEach(async () => {
    await remote.stop()
  })

  it('forwards to the pinned public address with the credential, the fixed headers and nothing else', async () => {
    remote.respond(() => ({
      status: 207,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ETag: '"e1"',
        DAV: '1, 3, calendar-access',
        'Set-Cookie': 'nc_session=abc',
        'WWW-Authenticate': 'Basic realm="x"',
        Server: 'nginx',
      },
      body: '<d:multistatus/>',
    }))

    const outcome = await relay.forward(
      target(),
      request({
        method: 'REPORT',
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body: Buffer.from('<c:calendar-query/>'),
      }),
    )

    expect(attempts).toEqual([
      {
        protocol: 'https:',
        address: '93.184.216.34',
        port: undefined,
        path: HOME,
        method: 'REPORT',
        host: 'cloud.example.org',
        authorization: `Basic ${Buffer.from('alice:app-password').toString('base64')}`,
      },
    ])
    const received = remote.received[0]
    expect(received.body).toBe('<c:calendar-query/>')
    expect(received.headers).toMatchObject({
      depth: '1',
      'content-type': 'application/xml',
      'content-length': '19',
      'accept-encoding': 'identity',
      'user-agent': 'StandardRedNotes-DavBridge/1',
    })
    expect(received.headers['transfer-encoding']).toBeUndefined()
    expect(received.headers.cookie).toBeUndefined()

    expect(outcome).toEqual({
      kind: 'remote',
      requestBytes: 19,
      responseBytes: 16,
      answer: {
        status: 207,
        headers: { 'content-type': 'application/xml; charset=utf-8', etag: '"e1"', dav: '1, 3, calendar-access' },
        body: '<d:multistatus/>',
        bodyEncoding: 'utf8',
        path: HOME,
        redirects: 0,
      },
    })
  })

  it('sends a request without a body with no body framing the remote could choke on', async () => {
    await relay.forward(target(), request({ headers: { Depth: '0' } }))

    expect(remote.received[0].body).toBe('')
    expect(remote.received[0].headers['transfer-encoding']).toBeUndefined()
    expect(remote.received[0].headers['content-type']).toBeUndefined()
  })

  it('sends a bearer token as it is', async () => {
    await relay.forward(
      target({ credentialKind: 'bearer', username: '', secret: new SecretString('tok_123') }),
      request(),
    )

    expect(attempts[0].authorization).toBe('Bearer tok_123')
  })

  it('encodes a non-ASCII password as UTF-8 before base64', async () => {
    await relay.forward(target({ secret: new SecretString('päss wörd') }), request())

    expect(Buffer.from(String(attempts[0].authorization).slice('Basic '.length), 'base64').toString('utf8')).toBe(
      'alice:päss wörd',
    )
  })

  it('hands back non-2xx remote answers as answers, not as failures', async () => {
    for (const status of [403, 404, 405, 412, 423, 429, 500, 503, 507]) {
      remote.respond(() => ({ status, headers: { 'Retry-After': '30' }, body: 'remote says no' }))

      const outcome = await relay.forward(target(), request())

      expect(outcome).toMatchObject({
        kind: 'remote',
        answer: { status, body: 'remote says no', headers: { 'retry-after': '30' } },
      })
    }
  })

  it('reports a 401 as unauthorized instead of handing it back', async () => {
    remote.respond(() => ({ status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' }, body: 'Unauthorized' }))

    expect(await relay.forward(target(), request())).toEqual({ kind: 'unauthorized', requestBytes: 0 })
  })

  it('returns bytes that are not UTF-8 as base64', async () => {
    const bytes = Buffer.from([0x42, 0xff, 0xfe, 0x00, 0x80])
    remote.respond(() => ({ status: 200, body: bytes }))

    const outcome = await relay.forward(target(), request({ method: 'GET', path: `${HOME}a.ics` }))

    expect(outcome).toMatchObject({
      kind: 'remote',
      answer: { bodyEncoding: 'base64', body: bytes.toString('base64') },
    })
  })

  it('returns an empty body as an empty string', async () => {
    remote.respond(() => ({ status: 204 }))

    expect(await relay.forward(target(), request({ method: 'OPTIONS' }))).toMatchObject({
      answer: { status: 204, body: '', bodyEncoding: 'utf8' },
      responseBytes: 0,
    })
  })

  describe('write methods', () => {
    it.each([...DAV_WRITE_METHODS, 'POST', 'MOVE'])(
      'opens no socket for %s even when the caller bypasses the envelope parser',
      async (method) => {
        const refusal = await refusalFrom(
          relay.forward(target(), request({ method: method as DavRelayRequest['method'], path: `${HOME}x.ics` })),
        )

        expect(
          (DAV_WRITE_METHODS as readonly string[]).includes(method) ? 'dav-writes-disabled' : 'dav-method-not-allowed',
        ).toBe(refusal.tag)
        expect(attempts).toHaveLength(0)
        expect(remote.received).toHaveLength(0)
      },
    )
  })

  describe('path pin', () => {
    it.each([
      ['the calendar home itself', HOME],
      ['a calendar under it', `${HOME}personal/`],
      ['an entry under it', `${HOME}personal/1.ics`],
      ['the principal', PRINCIPAL],
    ])('forwards to %s', async (_label, path) => {
      await relay.forward(target(), request({ path }))

      expect(attempts.map((attempt) => attempt.path)).toEqual([path])
    })

    it.each([
      ['the files endpoint', '/remote.php/dav/files/alice/'],
      ['the contacts endpoint', '/remote.php/dav/addressbooks/users/alice/contacts/'],
      ["another user's calendars", '/remote.php/dav/calendars/bob/'],
      ['a sibling that shares the prefix as text', '/remote.php/dav/calendars/alice-admin/'],
      ['the calendar home without its slash', '/remote.php/dav/calendars/alice'],
      ['the server root', '/'],
      ['the status page', '/status.php'],
      ['a different spelling of the pinned path', '/remote.php/dav/calendars/%61lice/'],
    ])('refuses %s and opens no socket', async (_label, path) => {
      const refusal = await refusalFrom(relay.forward(target(), request({ path })))

      expect(refusal.tag).toBe('dav-path-not-allowed')
      expect(refusal.httpStatus).toBe(403)
      expect(refusal.logTag).toBe('outside-pin')
      expect(attempts).toHaveLength(0)
    })

    it('refuses every read method outside the pin, not only GET', async () => {
      for (const method of DAV_READ_METHODS) {
        const refusal = await refusalFrom(
          relay.forward(target(), request({ method, path: '/remote.php/dav/files/alice/' })),
        )

        expect(refusal.tag).toBe('dav-path-not-allowed')
      }
      expect(attempts).toHaveLength(0)
    })
  })

  describe('discovery window', () => {
    it('forwards OPTIONS and PROPFIND anywhere on the origin while it is open and nothing is pinned', async () => {
      for (const method of ['OPTIONS', 'PROPFIND'] as const) {
        await relay.forward(
          target({ pin: null, discoveryOpen: true }),
          request({ method, path: '/.well-known/caldav' }),
        )
      }

      expect(attempts.map((attempt) => `${attempt.method} ${attempt.path}`)).toEqual([
        'OPTIONS /.well-known/caldav',
        'PROPFIND /.well-known/caldav',
      ])
    })

    it.each(['GET', 'REPORT'] as const)(
      'does not forward %s outside a pin even while the window is open',
      async (method) => {
        const refusal = await refusalFrom(
          relay.forward(
            target({ pin: null, discoveryOpen: true }),
            request({ method, path: '/remote.php/dav/files/alice/secret.txt' }),
          ),
        )

        expect(refusal.tag).toBe('dav-path-not-allowed')
        expect(refusal.logTag).toBe('not-pinned')
        expect(attempts).toHaveLength(0)
      },
    )

    it('forwards nothing at all once the window has closed without a pin', async () => {
      for (const method of DAV_READ_METHODS) {
        const refusal = await refusalFrom(
          relay.forward(target({ pin: null, discoveryOpen: false }), request({ method, path: '/.well-known/caldav' })),
        )

        expect(refusal.tag).toBe('dav-discovery-closed')
        expect(refusal.httpStatus).toBe(409)
      }
      expect(attempts).toHaveLength(0)
    })

    it('lets a reopened window look outside an existing pin with PROPFIND, and still not with GET', async () => {
      await relay.forward(target({ discoveryOpen: true }), request({ method: 'PROPFIND', path: '/.well-known/caldav' }))
      const refusal = await refusalFrom(
        relay.forward(
          target({ discoveryOpen: true }),
          request({ method: 'GET', path: '/remote.php/dav/files/alice/a' }),
        ),
      )

      expect(attempts).toHaveLength(1)
      expect(refusal.tag).toBe('dav-path-not-allowed')
    })
  })

  describe('redirects', () => {
    it('follows a same-origin redirect, keeps method and body, and reports where it ended', async () => {
      remote.respond((received) =>
        received.url === '/.well-known/caldav'
          ? { status: 301, headers: { Location: '/remote.php/dav/' } }
          : { status: 207, body: '<ok/>' },
      )

      const outcome = await relay.forward(
        target({ pin: null, discoveryOpen: true }),
        request({
          path: '/.well-known/caldav',
          headers: { Depth: '0', 'Content-Type': 'application/xml' },
          body: Buffer.from('<d:propfind/>'),
        }),
      )

      expect(attempts.map((attempt) => `${attempt.method} ${attempt.path}`)).toEqual([
        'PROPFIND /.well-known/caldav',
        'PROPFIND /remote.php/dav/',
      ])
      expect(remote.received[1].body).toBe('<d:propfind/>')
      expect(remote.received[1].headers.authorization).toBe(remote.received[0].headers.authorization)
      expect(outcome).toMatchObject({ answer: { status: 207, path: '/remote.php/dav/', redirects: 1 } })
    })

    it('accepts an absolute Location that names the same origin', async () => {
      remote.respond((received) =>
        received.url === HOME
          ? { status: 308, headers: { Location: `${ORIGIN}${HOME}personal/` } }
          : { status: 207, body: '<ok/>' },
      )

      expect(await relay.forward(target(), request())).toMatchObject({
        answer: { path: `${HOME}personal/`, redirects: 1 },
      })
    })

    it.each([
      ['another host', 'https://dav.example.net/dav/', { origin: 'https://dav.example.net', path: '/dav/' }],
      [
        'another port',
        'https://cloud.example.org:8443/dav/',
        { origin: 'https://cloud.example.org:8443', path: '/dav/' },
      ],
      [
        'https to http',
        'http://cloud.example.org/remote.php/dav/',
        { origin: 'http://cloud.example.org', path: '/remote.php/dav/' },
      ],
      [
        'a loopback address',
        'http://127.0.0.1:3000/healthcheck',
        { origin: 'http://127.0.0.1:3000', path: '/healthcheck' },
      ],
      [
        'the metadata address',
        'http://169.254.169.254/latest/meta-data/',
        { origin: 'http://169.254.169.254', path: '/latest/meta-data/' },
      ],
      ['a file URL', 'file:///etc/passwd', { origin: 'unsupported', path: '/' }],
    ])('never follows a redirect to %s', async (_label, location, expected) => {
      remote.respond(() => ({ status: 302, headers: { Location: location } }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-redirect-other-origin')
      expect(refusal.httpStatus).toBe(409)
      expect(refusal.extra).toEqual({ location: expected })
      // One connection: the request that got the redirect. Nothing after it.
      expect(attempts).toHaveLength(1)
      expect(remote.received).toHaveLength(1)
    })

    it('drops a query and credentials from the reported redirect target', async () => {
      remote.respond(() => ({
        status: 302,
        headers: { Location: 'https://user:hunter2@dav.example.net/dav/?token=abc#frag' },
      }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(JSON.stringify(refusal.toBody())).not.toMatch(/hunter2|token=abc|frag|user:/)
      expect(refusal.extra).toEqual({ location: { origin: 'https://dav.example.net', path: '/dav/' } })
    })

    it('puts a redirect hop through the pin: a redirect out of the calendar home is refused', async () => {
      remote.respond(() => ({ status: 307, headers: { Location: '/remote.php/dav/files/alice/' } }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-path-not-allowed')
      expect(attempts.map((attempt) => attempt.path)).toEqual([HOME])
    })

    it('refuses a redirect that needs a query string rather than following it without one', async () => {
      remote.respond(() => ({ status: 302, headers: { Location: `${HOME}?next=1` } }))

      expect((await refusalFrom(relay.forward(target(), request()))).tag).toBe('dav-invalid-path')
      expect(attempts).toHaveLength(1)
    })

    it('stops after three redirects', async () => {
      let hop = 0
      remote.respond(() => ({ status: 302, headers: { Location: `${HOME}hop${++hop}/` } }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-too-many-redirects')
      // The first request and three followed hops; the fourth redirect is not followed.
      expect(attempts).toHaveLength(4)
    })

    it('re-resolves on every hop, so a name that turns private after the first answer is not connected to', async () => {
      const recording = recordingFactory(remote)
      const flipping = jest.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['10.0.0.5'])
      relay = new DavRelay(
        new DavNetworkPolicy({
          resolveHost: flipping,
          requestFactory: recording.factory,
          resolveOwnServiceName: async () => [],
          ownInterfaceAddresses: () => [],
        }),
      )
      remote.respond(() => ({ status: 302, headers: { Location: `${HOME}next/` } }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-address-not-allowed')
      expect(flipping).toHaveBeenCalledTimes(2)
      expect(recording.attempts.map((attempt) => attempt.address)).toEqual(['93.184.216.34'])
    })

    it('hands a 303 and a 304 back as answers', async () => {
      remote.respond(() => ({ status: 303, headers: { Location: `${HOME}other/` } }))
      expect(await relay.forward(target(), request())).toMatchObject({
        answer: { status: 303, headers: { location: `${HOME}other/` }, redirects: 0 },
      })

      remote.respond(() => ({ status: 304, headers: { ETag: '"same"' } }))
      expect(
        await relay.forward(
          target(),
          request({ method: 'GET', path: `${HOME}a.ics`, headers: { 'If-None-Match': '"same"' } }),
        ),
      ).toMatchObject({ answer: { status: 304, headers: { etag: '"same"' } } })
    })

    it('passes a Location on only when it stays on the origin, and then only as a path', async () => {
      remote.respond(() => ({ status: 201, headers: { Location: `${ORIGIN}${HOME}new.ics?x=1` } }))
      expect(await relay.forward(target(), request())).toMatchObject({
        answer: { headers: { location: `${HOME}new.ics` } },
      })

      remote.respond(() => ({ status: 201, headers: { Location: 'https://elsewhere.example/new.ics' } }))
      const outcome = await relay.forward(target(), request())
      expect(outcome.kind === 'remote' && outcome.answer.headers.location).toBeUndefined()
    })
  })

  describe('ceilings', () => {
    it('refuses an answer that declares more than the ceiling without reading it', async () => {
      remote.respond(() => ({
        status: 200,
        headers: { 'Content-Length': String(DAV_RELAY_LIMITS.responseBodyBytes + 1) },
        body: 'x',
      }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-response-too-large')
      expect(refusal.httpStatus).toBe(502)
      expect(refusal.extra).toEqual({ limit: DAV_RELAY_LIMITS.responseBodyBytes })
    })

    it('stops reading an answer that streams past the ceiling without declaring a length', async () => {
      remote.respond(() => ({ status: 200, streamBytes: DAV_RELAY_LIMITS.responseBodyBytes + 256 * 1024 }))

      expect((await refusalFrom(relay.forward(target(), request()))).tag).toBe('dav-response-too-large')
    })

    it('accepts an answer exactly at the ceiling', async () => {
      remote.respond(() => ({ status: 200, streamBytes: DAV_RELAY_LIMITS.responseBodyBytes }))

      expect(await relay.forward(target(), request())).toMatchObject({
        responseBytes: DAV_RELAY_LIMITS.responseBodyBytes,
      })
    })

    it('gives up on a remote that never answers, within the deadline', async () => {
      build(150)
      remote.respond(() => ({ hang: true }))
      const started = Date.now()

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-remote-timeout')
      expect(refusal.httpStatus).toBe(504)
      expect(refusal.extra).toEqual({ host: 'cloud.example.org' })
      expect(Date.now() - started).toBeLessThan(5_000)
    })

    it('applies one deadline to the whole exchange, redirects included', async () => {
      build(400)
      let hop = 0
      remote.respond(() => (++hop < 3 ? { status: 302, headers: { Location: `${HOME}h${hop}/` } } : { hang: true }))

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-remote-timeout')
      expect(attempts).toHaveLength(3)
    })
  })

  describe('failures', () => {
    it('reports a name that does not resolve', async () => {
      const refusal = await refusalFrom(relay.forward(target({ origin: 'https://gone.example.org' }), request()))

      expect(refusal.tag).toBe('dav-host-not-found')
      expect(refusal.httpStatus).toBe(502)
      expect(refusal.extra).toEqual({ host: 'gone.example.org' })
      expect(attempts).toHaveLength(0)
    })

    it('reports a connection that cannot be made, with a log tag from the closed list and no address in the message', async () => {
      await remote.stop()

      const refusal = await refusalFrom(relay.forward(target(), request()))

      expect(refusal.tag).toBe('dav-remote-unreachable')
      expect(refusal.httpStatus).toBe(502)
      expect(refusal.logTag).toBe('refused')
      expect(refusal.message).toBe('cloud.example.org did not answer.')
      expect(JSON.stringify(refusal.toBody())).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|93\.184/)
      await remote.start()
    })

    it('reports a caller that went away as an abort, not as a remote failure', async () => {
      remote.respond(() => ({ hang: true }))
      const controller = new AbortController()
      const pending = relay.forward(target(), request(), controller.signal)
      setTimeout(() => controller.abort(), 50)

      await expect(pending).rejects.toBeInstanceOf(DavRelayAbortedError)
    })

    it('does not disguise a defect in its own code as a remote failure', async () => {
      const broken = new DavRelay({
        assertTargetAcceptable: async () => {
          throw new TypeError('a bug')
        },
      } as unknown as DavNetworkPolicy)

      await expect(broken.forward(target(), request())).rejects.toBeInstanceOf(TypeError)
    })
  })
})
