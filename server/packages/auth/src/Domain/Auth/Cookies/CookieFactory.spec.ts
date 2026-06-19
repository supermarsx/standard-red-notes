import { CookieFactory } from './CookieFactory'

describe('CookieFactory', () => {
  const refreshTokenExpiration = new Date('2026-06-19T12:00:00.000Z')

  const createFactory = (
    sameSite: 'None' | 'Lax' | 'Strict' = 'None',
    domain = 'example.com',
    secure = true,
    partitioned = true,
  ) => new CookieFactory(sameSite, domain, secure, partitioned)

  const dto = {
    sessionUuid: '1-2-3',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshTokenExpiration,
  }

  it('should instantiate', () => {
    expect(createFactory()).toBeInstanceOf(CookieFactory)
  })

  it('should return an array of two cookie header values', () => {
    const cookies = createFactory().createCookieHeaderValue(dto)

    expect(Array.isArray(cookies)).toBe(true)
    expect(cookies).toHaveLength(2)
  })

  it('should name the cookies using the session uuid', () => {
    const [accessTokenCookie, refreshTokenCookie] = createFactory().createCookieHeaderValue(dto)

    expect(accessTokenCookie.startsWith('access_token_1-2-3=access-token;')).toBe(true)
    expect(refreshTokenCookie.startsWith('refresh_token_1-2-3=refresh-token;')).toBe(true)
  })

  describe('Domain attribute', () => {
    it('should include the Domain attribute when a domain is configured', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        'my.host.tld',
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).toContain('Domain=my.host.tld;')
      expect(refreshTokenCookie).toContain('Domain=my.host.tld;')
    })

    it('should OMIT the Domain attribute entirely when the domain is empty (host-only cookie)', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        '',
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).not.toContain('Domain=')
      expect(refreshTokenCookie).not.toContain('Domain=')
    })
  })

  describe('Secure attribute', () => {
    it('should include Secure when secure is true', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        'example.com',
        true,
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).toContain('Secure;')
      expect(refreshTokenCookie).toContain('Secure;')
    })

    it('should omit Secure when secure is false', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        'example.com',
        false,
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).not.toContain('Secure')
      expect(refreshTokenCookie).not.toContain('Secure')
    })
  })

  describe('Partitioned attribute', () => {
    it('should include Partitioned when partitioned is true', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        'example.com',
        true,
        true,
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).toContain('Partitioned;')
      expect(refreshTokenCookie).toContain('Partitioned;')
    })

    it('should omit Partitioned when partitioned is false', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        'example.com',
        true,
        false,
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).not.toContain('Partitioned')
      expect(refreshTokenCookie).not.toContain('Partitioned')
    })
  })

  describe('SameSite attribute', () => {
    it.each(['None', 'Lax', 'Strict'] as const)('should reflect SameSite=%s', (sameSite) => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(sameSite).createCookieHeaderValue(dto)

      expect(accessTokenCookie).toContain(`SameSite=${sameSite};`)
      expect(refreshTokenCookie).toContain(`SameSite=${sameSite};`)
    })
  })

  describe('Path attribute', () => {
    it('should use Path=/ for the access token cookie', () => {
      const [accessTokenCookie] = createFactory().createCookieHeaderValue(dto)

      expect(accessTokenCookie).toContain('Path=/;')
      expect(accessTokenCookie).not.toContain('Path=/v1/sessions/refresh')
    })

    it('should use Path=/v1/sessions/refresh for the refresh token cookie', () => {
      const [, refreshTokenCookie] = createFactory().createCookieHeaderValue(dto)

      expect(refreshTokenCookie).toContain('Path=/v1/sessions/refresh;')
    })
  })

  describe('Expires attribute', () => {
    it('should reflect the refreshTokenExpiration on both cookies', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory().createCookieHeaderValue(dto)

      const expectedExpires = `Expires=${refreshTokenExpiration.toUTCString()};`
      expect(accessTokenCookie).toContain(expectedExpires)
      expect(refreshTokenCookie).toContain(expectedExpires)
    })
  })

  describe('attribute formatting', () => {
    it('should separate every attribute with "; " so the Set-Cookie value is well-formed', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        'example.com',
        true,
        true,
      ).createCookieHeaderValue(dto)

      // A well-formed Set-Cookie header separates attributes with "; ".
      // Any ";" that is not followed by a space (and is not the trailing ";")
      // indicates two attributes glued together, e.g. "HttpOnly;Secure".
      const malformed = /;(?=\S)(?!$)/

      expect(accessTokenCookie).not.toMatch(malformed)
      expect(refreshTokenCookie).not.toMatch(malformed)
    })

    it('should not emit an empty Domain= attribute when the domain is empty', () => {
      const [accessTokenCookie, refreshTokenCookie] = createFactory(
        'None',
        '',
      ).createCookieHeaderValue(dto)

      expect(accessTokenCookie).not.toMatch(/Domain=;/)
      expect(accessTokenCookie).not.toMatch(/Domain=\s/)
      expect(refreshTokenCookie).not.toMatch(/Domain=;/)
      expect(refreshTokenCookie).not.toMatch(/Domain=\s/)
    })
  })
})
