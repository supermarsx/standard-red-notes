import { assertPublicHttpUrl, isBlockedHostname, isBlockedIp, SsrfValidationError } from './SsrfFilter'

describe('SsrfFilter', () => {
  describe('isBlockedHostname', () => {
    it('blocks localhost and internal names', () => {
      expect(isBlockedHostname('localhost')).toBe(true)
      expect(isBlockedHostname('app.localhost')).toBe(true)
      expect(isBlockedHostname('foo.internal')).toBe(true)
      expect(isBlockedHostname('printer.local')).toBe(true)
      expect(isBlockedHostname('metadata')).toBe(true)
      expect(isBlockedHostname('')).toBe(true)
    })

    it('allows public hostnames', () => {
      expect(isBlockedHostname('example.com')).toBe(false)
      expect(isBlockedHostname('api.github.com')).toBe(false)
    })
  })

  describe('isBlockedIp', () => {
    it('blocks private / loopback / link-local / metadata IPv4', () => {
      expect(isBlockedIp('127.0.0.1')).toBe(true)
      expect(isBlockedIp('10.0.0.1')).toBe(true)
      expect(isBlockedIp('172.16.5.4')).toBe(true)
      expect(isBlockedIp('192.168.1.1')).toBe(true)
      expect(isBlockedIp('169.254.169.254')).toBe(true) // cloud metadata
      expect(isBlockedIp('100.64.0.1')).toBe(true) // CGNAT
      expect(isBlockedIp('0.0.0.0')).toBe(true)
      expect(isBlockedIp('224.0.0.1')).toBe(true) // multicast
    })

    it('blocks loopback / link-local / ULA / mapped IPv6', () => {
      expect(isBlockedIp('::1')).toBe(true)
      expect(isBlockedIp('::')).toBe(true)
      expect(isBlockedIp('fe80::1')).toBe(true)
      expect(isBlockedIp('fc00::1')).toBe(true)
      expect(isBlockedIp('fd12::1')).toBe(true)
      expect(isBlockedIp('ff02::1')).toBe(true)
      expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true) // IPv4-mapped loopback
      expect(isBlockedIp('::ffff:7f00:1')).toBe(true) // IPv4-mapped loopback (hextet form)
      expect(isBlockedIp('64:ff9b::169.254.169.254')).toBe(true) // NAT64 metadata
      expect(isBlockedIp('64:ff9b::a9fe:a9fe')).toBe(true) // NAT64 metadata (hextet form)
      expect(isBlockedIp('64:ff9b:1::1')).toBe(true) // any other NAT64 -> fail closed
    })

    it('blocks invalid IPv4 octets and short forms', () => {
      expect(isBlockedIp('1.2.3')).toBe(true)
    })

    it('allows public IPs', () => {
      expect(isBlockedIp('8.8.8.8')).toBe(false)
      expect(isBlockedIp('1.1.1.1')).toBe(false)
      expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
    })

    it('fails closed for non-IP input', () => {
      expect(isBlockedIp('not-an-ip')).toBe(true)
    })
  })

  describe('assertPublicHttpUrl', () => {
    const resolveToPublic = async (): Promise<string[]> => ['93.184.216.34']

    it('rejects an empty URL', async () => {
      await expect(assertPublicHttpUrl('', resolveToPublic)).rejects.toThrow(SsrfValidationError)
    })

    it('rejects a malformed URL', async () => {
      await expect(assertPublicHttpUrl('http://', resolveToPublic)).rejects.toThrow(SsrfValidationError)
    })

    it('rejects non-http(s) schemes', async () => {
      await expect(assertPublicHttpUrl('file:///etc/passwd', resolveToPublic)).rejects.toMatchObject({
        tag: 'invalid-scheme',
      })
      await expect(assertPublicHttpUrl('javascript:alert(1)', resolveToPublic)).rejects.toThrow(SsrfValidationError)
      await expect(assertPublicHttpUrl('gopher://example.com', resolveToPublic)).rejects.toThrow(SsrfValidationError)
    })

    it('rejects localhost / internal hostnames', async () => {
      await expect(assertPublicHttpUrl('http://localhost/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
      await expect(assertPublicHttpUrl('https://foo.internal/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
    })

    it('rejects literal private / loopback / metadata IPs', async () => {
      await expect(assertPublicHttpUrl('http://127.0.0.1/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
      await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/', resolveToPublic)).rejects.toMatchObject(
        { tag: 'blocked-host' },
      )
      await expect(assertPublicHttpUrl('http://[::1]/x', resolveToPublic)).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it('rejects a hostname that resolves to a private address (DNS-rebinding defense)', async () => {
      const resolveToPrivate = async (): Promise<string[]> => ['10.0.0.5']
      await expect(assertPublicHttpUrl('https://evil.example.com/x', resolveToPrivate)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
    })

    it('rejects when ANY resolved address is private', async () => {
      const resolveMixed = async (): Promise<string[]> => ['93.184.216.34', '127.0.0.1']
      await expect(assertPublicHttpUrl('https://mixed.example.com/x', resolveMixed)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
    })

    it('rejects an unresolvable host', async () => {
      const failResolve = async (): Promise<string[]> => {
        throw new Error('ENOTFOUND')
      }
      await expect(assertPublicHttpUrl('https://nope.example.com/x', failResolve)).rejects.toMatchObject({
        tag: 'unresolvable-host',
      })
    })

    it('accepts a public https URL and returns the parsed URL', async () => {
      const url = await assertPublicHttpUrl('https://example.com/hook', resolveToPublic)
      expect(url).toBeInstanceOf(URL)
      expect(url.hostname).toBe('example.com')
      expect(url.pathname).toBe('/hook')
    })

    it('accepts a literal public IP without resolving', async () => {
      const url = await assertPublicHttpUrl('https://8.8.8.8/x')
      expect(url.hostname).toBe('8.8.8.8')
    })
  })
})
