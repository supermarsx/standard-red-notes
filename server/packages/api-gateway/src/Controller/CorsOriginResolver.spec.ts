import { decideCorsOrigin, resolveCorsStrictMode } from './CorsOriginResolver'

describe('CorsOriginResolver', () => {
  describe('resolveCorsStrictMode', () => {
    it('defaults to strict when unset', () => {
      expect(resolveCorsStrictMode(undefined)).toBe(true)
      expect(resolveCorsStrictMode('')).toBe(true)
    })

    it('is strict for any value except the literal "false"', () => {
      expect(resolveCorsStrictMode('true')).toBe(true)
      expect(resolveCorsStrictMode('yes')).toBe(true)
    })

    it('is permissive only when explicitly "false"', () => {
      expect(resolveCorsStrictMode('false')).toBe(false)
    })
  })

  describe('decideCorsOrigin (strict mode)', () => {
    const strict = { strictMode: true, allowedOrigins: [] as string[] }

    it('allows a missing or null Origin (native/same-origin/server-to-server)', () => {
      expect(decideCorsOrigin(undefined, strict).allow).toBe(true)
      expect(decideCorsOrigin('null', strict).allow).toBe(true)
    })

    it('allows the desktop app and the browser clippers', () => {
      expect(decideCorsOrigin('file://', strict).allow).toBe(true)
      expect(decideCorsOrigin('moz-extension://abc', strict).allow).toBe(true)
      expect(decideCorsOrigin('chrome-extension://abc', strict).allow).toBe(true)
      expect(decideCorsOrigin('safari-web-extension://abc', strict).allow).toBe(true)
    })

    it('allows a localhost self-host on http or https, with or without a port', () => {
      expect(decideCorsOrigin('http://localhost', strict).allow).toBe(true)
      expect(decideCorsOrigin('http://localhost:3001', strict).allow).toBe(true)
      expect(decideCorsOrigin('https://localhost:8443', strict).allow).toBe(true)
    })

    it('does NOT allow an arbitrary origin when the allow-list is empty', () => {
      expect(decideCorsOrigin('https://evil.example.com', strict).allow).toBe(false)
      // A look-alike host that merely contains "localhost" must not slip through.
      expect(decideCorsOrigin('https://localhost.evil.com', strict).allow).toBe(false)
      expect(decideCorsOrigin('http://notlocalhost', strict).allow).toBe(false)
      // The unanchored-regex bypass the home-server inline block had: a "port" that
      // is actually a subdomain label must be rejected by the anchored regex.
      expect(decideCorsOrigin('http://localhost:1.evil.com', strict).allow).toBe(false)
    })

    it('allows origins explicitly configured in CORS_ALLOWED_ORIGINS', () => {
      const config = { strictMode: true, allowedOrigins: ['https://notes.example.com'] }
      expect(decideCorsOrigin('https://notes.example.com', config).allow).toBe(true)
      expect(decideCorsOrigin('https://other.example.com', config).allow).toBe(false)
    })
  })

  describe('decideCorsOrigin (permissive escape hatch)', () => {
    it('reflects any origin when strict mode is disabled', () => {
      const permissive = { strictMode: false, allowedOrigins: [] as string[] }
      expect(decideCorsOrigin('https://evil.example.com', permissive).allow).toBe(true)
      expect(decideCorsOrigin(undefined, permissive).allow).toBe(true)
    })
  })
})
