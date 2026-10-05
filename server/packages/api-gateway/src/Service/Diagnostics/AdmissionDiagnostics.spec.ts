import {
  MAX_REPORTED_ADMISSION_EVENTS,
  MAX_REPORTED_LIVE_SOCKETS,
  MAX_REPORTED_ORIGIN_RULES,
  SOCKET_REJECTION_COUNTER_KEYS,
  admissionProbeFromHeaders,
  readGatewayAdmission,
} from './AdmissionDiagnostics'

/**
 * Standard Red Notes: the reader that carries the gateway's admission block to
 * the admin panel, and the probe that asks the one per-request question.
 *
 * The subject is an ALLOWLIST and a stream of refused clients, so the tests are
 * written against WHAT IS EMITTED rather than against a list of forbidden
 * words: every key must be one this build names, every value must satisfy its
 * declared bound, and a key nobody anticipated fails rather than passing
 * unnoticed.
 */
describe('readGatewayAdmission', () => {
  /** What a conforming, fully-reporting gateway hands over. */
  const healthy = {
    originAdmitted: true,
    allowedOriginCount: 3,
    allowsSameOrigin: true,
    liveSockets: 7,
    ticketsIssued: 11,
    ticketsRefused: 2,
    handshakeRejected: 1,
    rejections: { originNotAllowed: 4, queryStringNotPermitted: 0, unavailable: 5 },
  }

  it('carries every member a conforming gateway reported', () => {
    expect(readGatewayAdmission(healthy)).toEqual(healthy)
  })

  it('reports nothing at all when no gateway is attached', () => {
    // The NOTHING half of the all-or-nothing contract. A gateway that never
    // attached refused nobody and holds no socket; publishing zeros for it
    // would be a measurement no process took, and would render ten rows.
    expect(readGatewayAdmission(undefined)).toBeUndefined()
    expect(readGatewayAdmission(null)).toBeUndefined()
    expect(readGatewayAdmission('admission')).toBeUndefined()
    expect(readGatewayAdmission([healthy])).toBeUndefined()
  })

  it('keeps a reported zero, which is a measurement and not silence', () => {
    const quiet = readGatewayAdmission({
      ...healthy,
      liveSockets: 0,
      ticketsIssued: 0,
      rejections: { originNotAllowed: 0, queryStringNotPermitted: 0, unavailable: 0 },
    })

    expect(quiet).toMatchObject({ liveSockets: 0, ticketsIssued: 0 })
    expect(quiet?.rejections).toEqual({ originNotAllowed: 0, queryStringNotPermitted: 0, unavailable: 0 })
  })

  it('separates an unanswered origin question from an answer of no', () => {
    // `originAdmitted: false` is a conclusive fault the panel renders as broken
    // with a finding behind it. A caller that named no origin asked nothing,
    // and the two must not arrive the same.
    const { originAdmitted: _dropped, ...withoutOrigin } = healthy

    expect(readGatewayAdmission(withoutOrigin)).not.toHaveProperty('originAdmitted')
    expect(readGatewayAdmission({ ...healthy, originAdmitted: false })?.originAdmitted).toBe(false)
  })

  it('drops a figure outside its declared bound rather than clamping it into a plausible reading', () => {
    const outOfBounds = readGatewayAdmission({
      ...healthy,
      allowedOriginCount: MAX_REPORTED_ORIGIN_RULES + 1,
      liveSockets: MAX_REPORTED_LIVE_SOCKETS + 1,
      ticketsIssued: MAX_REPORTED_ADMISSION_EVENTS + 1,
      ticketsRefused: -3,
      handshakeRejected: Number.NaN,
      rejections: { originNotAllowed: Number.POSITIVE_INFINITY, queryStringNotPermitted: 1, unavailable: 10 ** 15 },
    })

    expect(Object.keys(outOfBounds ?? {}).sort()).toEqual(['allowsSameOrigin', 'originAdmitted', 'rejections'])
    expect(outOfBounds?.rejections).toEqual({ queryStringNotPermitted: 1 })
  })

  it('admits the exact ceiling, because that is what a saturating gateway reports', () => {
    const saturated = readGatewayAdmission({
      ...healthy,
      allowedOriginCount: MAX_REPORTED_ORIGIN_RULES,
      liveSockets: MAX_REPORTED_LIVE_SOCKETS,
      ticketsIssued: MAX_REPORTED_ADMISSION_EVENTS,
    })

    expect(saturated).toMatchObject({
      allowedOriginCount: MAX_REPORTED_ORIGIN_RULES,
      liveSockets: MAX_REPORTED_LIVE_SOCKETS,
      ticketsIssued: MAX_REPORTED_ADMISSION_EVENTS,
    })
  })

  it('does not coerce a string, a number or an object into a boolean', () => {
    const coerced = readGatewayAdmission({
      ...healthy,
      originAdmitted: 'true',
      allowsSameOrigin: 1,
    })

    expect(coerced).not.toHaveProperty('originAdmitted')
    expect(coerced).not.toHaveProperty('allowsSameOrigin')
  })

  it('copies no key this build has not been taught, however plausible it looks', () => {
    // The mechanism a passthrough leaks by: a field a newer gateway grows,
    // riding along in a spread. Each of these is a different shape of
    // disclosure and not one may appear.
    const emitted = readGatewayAdmission({
      ...healthy,
      allowedOrigins: ['https://notes.internal.example:8443'],
      lastRefusedOrigin: 'https://evil.example',
      lastRefusedAddress: '10.0.3.14',
      connectionTokenSecret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      socketPath: '/sockets/sync',
      refusalDetail: 'connect ECONNREFUSED 10.0.3.14:3306',
      userUuids: ['00000000-0000-0000-0000-000000000001'],
    })

    expect(Object.keys(emitted ?? {}).sort()).toEqual([
      'allowedOriginCount',
      'allowsSameOrigin',
      'handshakeRejected',
      'liveSockets',
      'originAdmitted',
      'rejections',
      'ticketsIssued',
      'ticketsRefused',
    ])
    const serialized = JSON.stringify(emitted)
    for (const planted of ['evil.example', 'internal.example', '10.0.3.14', 'deadbeef', 'sockets', '0000']) {
      expect(serialized).not.toContain(planted)
    }
  })

  it('reads only the three causes it has rows for, and omits the record when none of them answered', () => {
    const withUnknownCause = readGatewayAdmission({
      ...healthy,
      rejections: { originNotAllowed: 2, tooManyPerIp: 9, 'drop:10.0.3.14': 4 },
    })

    expect(withUnknownCause?.rejections).toEqual({ originNotAllowed: 2 })
    expect(SOCKET_REJECTION_COUNTER_KEYS).toEqual(['originNotAllowed', 'queryStringNotPermitted', 'unavailable'])

    // An empty record would make the panel render all ten rows on the strength
    // of a block that reported no count at all.
    expect(readGatewayAdmission({ ...healthy, rejections: {} })).not.toHaveProperty('rejections')
    expect(readGatewayAdmission({ ...healthy, rejections: 'none' })).not.toHaveProperty('rejections')
  })
})

describe('admissionProbeFromHeaders', () => {
  it('takes the Origin header when the browser sent one', () => {
    expect(admissionProbeFromHeaders({ origin: 'https://app.example.test', host: 'api.example.test' })).toMatchObject({
      origin: 'https://app.example.test',
      host: 'api.example.test',
    })
  })

  it('falls back to the ORIGIN of the referrer, which is all a same-origin GET carries', () => {
    // The bundled single container serves the app and the API from ONE origin,
    // so the pane's fetch is same-origin and carries no Origin header at all.
    // Without this the headline row reads "not reported" on exactly the
    // deployment an operator is most likely debugging.
    expect(
      admissionProbeFromHeaders({ referer: 'http://localhost:3001/preferences?tab=diagnostics#admin' }).origin,
    ).toBe('http://localhost:3001')
    expect(admissionProbeFromHeaders({ referrer: 'https://notes.example/' }).origin).toBe('https://notes.example')
  })

  it('prefers Origin over the referrer when both are present', () => {
    expect(
      admissionProbeFromHeaders({ origin: 'https://app.example.test', referer: 'https://evil.example/page' }).origin,
    ).toBe('https://app.example.test')
  })

  it('names no origin at all rather than guessing one', () => {
    for (const headers of [
      undefined,
      {},
      { origin: '' },
      { referer: '' },
      { referer: 'not-a-url' },
      { referer: 'file:///etc/passwd' },
      { origin: ['https://a.example', 'https://b.example'] },
    ]) {
      expect(admissionProbeFromHeaders(headers)).not.toHaveProperty('origin')
    }
  })

  it('asks for the proxy widening, which only a diagnostics caller may do', () => {
    expect(admissionProbeFromHeaders({}).proxyNormalizedHostPort).toBe(true)
  })

  it('carries the forwarded scheme and the socket encryption the origin rule reads', () => {
    expect(admissionProbeFromHeaders({ 'x-forwarded-proto': 'https' }, false)).toMatchObject({
      forwardedProto: 'https',
      encrypted: false,
    })
    expect(admissionProbeFromHeaders({}, true).encrypted).toBe(true)
  })

  it('carries nothing but the four inputs the origin decision reads', () => {
    // A probe is handed to another package. It must not become a place a
    // credential travels: the decision reads an origin, a host and a scheme,
    // and the probe carries exactly those plus the widening flag.
    const probe = admissionProbeFromHeaders({
      origin: 'https://app.example.test',
      host: 'api.example.test',
      'x-forwarded-proto': 'https',
      cookie: 'session=secret-session-value',
      authorization: 'Bearer secret-bearer-token',
      'x-auth-token': 'secret-cross-service-token',
      'x-forwarded-for': '10.0.3.14',
      'user-agent': 'Mozilla/5.0',
    })

    expect(Object.keys(probe).sort()).toEqual([
      'encrypted',
      'forwardedProto',
      'host',
      'origin',
      'proxyNormalizedHostPort',
    ])
    const serialized = JSON.stringify(probe)
    for (const planted of ['secret-session-value', 'secret-bearer-token', 'secret-cross-service-token', '10.0.3.14']) {
      expect(serialized).not.toContain(planted)
    }
  })
})
