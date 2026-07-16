import { ClientIpResolvable, DEFAULT_CLIENT_IP_HEADER, parseClientIpHeaderName, resolveClientIp } from './ClientIp'

const req = (overrides: Partial<ClientIpResolvable> = {}): ClientIpResolvable => ({
  ip: undefined,
  socket: { remoteAddress: undefined },
  headers: {},
  ...overrides,
})

describe('parseClientIpHeaderName', () => {
  it('defaults to off (empty) when unset', () => {
    expect(parseClientIpHeaderName(undefined)).toBe('')
    expect(parseClientIpHeaderName(null)).toBe('')
    expect(DEFAULT_CLIENT_IP_HEADER).toBe('')
  })

  it('lower-cases + trims the configured header name', () => {
    expect(parseClientIpHeaderName('  X-Real-IP  ')).toBe('x-real-ip')
    expect(parseClientIpHeaderName('CF-Connecting-IP')).toBe('cf-connecting-ip')
  })
})

describe('resolveClientIp — DEFAULT (no CLIENT_IP_HEADER)', () => {
  it('uses request.ip (TRUST_PROXY-resolved) and IGNORES a spoofed X-Forwarded-For', () => {
    // The security property: with no configured header, a direct client cannot
    // spoof its IP via X-Forwarded-For — resolution is request.ip.
    const ip = resolveClientIp(
      req({ ip: '2.2.2.2', socket: { remoteAddress: '1.1.1.1' }, headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' } }),
    )
    expect(ip).toBe('2.2.2.2')
  })

  it('falls back to the socket remote address when request.ip is undefined', () => {
    const ip = resolveClientIp(req({ ip: undefined, socket: { remoteAddress: '1.1.1.1' } }))
    expect(ip).toBe('1.1.1.1')
  })

  it('returns empty string when nothing is available', () => {
    expect(resolveClientIp(req({ ip: undefined, socket: null }))).toBe('')
  })

  it('normalizes an IPv4-mapped IPv6 address to dotted-quad', () => {
    expect(resolveClientIp(req({ ip: '::ffff:203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('drops an IPv6 zone id and lower-cases IPv6', () => {
    expect(resolveClientIp(req({ ip: 'FE80::1%eth0' }))).toBe('fe80::1')
  })
})

describe('resolveClientIp — CLIENT_IP_HEADER configured', () => {
  it('reads the named header (leftmost, normalized) and it takes precedence over request.ip', () => {
    const ip = resolveClientIp(req({ ip: '2.2.2.2', headers: { 'x-real-ip': '203.0.113.5' } }), 'x-real-ip')
    expect(ip).toBe('203.0.113.5')
  })

  it('takes only the leftmost value from a comma-joined header', () => {
    const ip = resolveClientIp(
      req({ ip: '2.2.2.2', headers: { 'cf-connecting-ip': '203.0.113.5, 10.0.0.1' } }),
      'cf-connecting-ip',
    )
    expect(ip).toBe('203.0.113.5')
  })

  it('honors the header only when explicitly configured — an unconfigured header is ignored', () => {
    const ip = resolveClientIp(req({ ip: '2.2.2.2', headers: { 'x-real-ip': '203.0.113.5' } }))
    expect(ip).toBe('2.2.2.2')
  })

  it('falls back to request.ip when the configured header is absent on the request', () => {
    const ip = resolveClientIp(req({ ip: '2.2.2.2', headers: {} }), 'x-real-ip')
    expect(ip).toBe('2.2.2.2')
  })

  it('normalizes an IPv4-mapped IPv6 value from the header too', () => {
    const ip = resolveClientIp(req({ headers: { 'x-real-ip': '::ffff:203.0.113.9' } }), 'x-real-ip')
    expect(ip).toBe('203.0.113.9')
  })
})
