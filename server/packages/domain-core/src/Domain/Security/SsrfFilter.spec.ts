jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}))

import { lookup } from 'dns/promises'

import {
  assertPublicHttpUrl,
  isBlockedHostname,
  isBlockedIp,
  resolvePublicHttpUrl,
  SsrfValidationError,
} from './SsrfFilter'

const mockedLookup = lookup as unknown as jest.Mock

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

    it('blocks IANA special-use, documentation, and benchmarking IPv4 ranges at their boundaries', () => {
      for (const ip of [
        '0.0.0.0',
        '0.255.255.255',
        '10.0.0.0',
        '10.255.255.255',
        '100.64.0.0',
        '100.127.255.255',
        '127.0.0.0',
        '127.255.255.255',
        '169.254.0.0',
        '169.254.255.255',
        '172.16.0.0',
        '172.31.255.255',
        '192.0.0.0',
        '192.0.0.255',
        '192.0.2.0',
        '192.0.2.255',
        '192.31.196.0',
        '192.52.193.255',
        '192.88.99.1',
        '192.168.0.0',
        '192.168.255.255',
        '192.175.48.255',
        '198.18.0.0',
        '198.19.255.255',
        '198.51.100.0',
        '198.51.100.255',
        '203.0.113.0',
        '203.0.113.255',
        '224.0.0.0',
        '255.255.255.255',
      ]) {
        expect(isBlockedIp(ip)).toBe(true)
      }
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

    it('normalizes alternate IPv6 spellings before applying ranges', () => {
      for (const ip of [
        '0:0:0:0:0:0:0:1',
        '0:0:0:0:0:ffff:7f00:1',
        '0:0:0:0:0:ffff:127.0.0.1',
        'FE90:0:0:0:0:0:0:1',
        'febf::1',
        'fe90::1%eth0',
      ]) {
        expect(isBlockedIp(ip)).toBe(true)
      }
    })

    it('blocks reserved, documentation, site-local, and tunnel IPv6 ranges', () => {
      for (const ip of [
        '::8.8.8.8',
        '64:ff9b::808:808',
        '64:ff9b:1::808:808',
        '100::1',
        '2001::1',
        '2001:2::1',
        '2001:10::1',
        '2001:20::1',
        '2001:db8::1',
        '2002:808:808::1',
        '3fff::1',
        '5f00::1',
        'fec0::1',
        'feff::1',
      ]) {
        expect(isBlockedIp(ip)).toBe(true)
      }
    })

    it('blocks invalid IPv4 octets and short forms', () => {
      expect(isBlockedIp('1.2.3')).toBe(true)
      expect(isBlockedIp('999.1.1.1')).toBe(true)
    })

    it('allows public IPs', () => {
      expect(isBlockedIp('8.8.8.8')).toBe(false)
      expect(isBlockedIp('1.1.1.1')).toBe(false)
      expect(isBlockedIp('93.184.216.34')).toBe(false)
      expect(isBlockedIp('100.63.255.255')).toBe(false)
      expect(isBlockedIp('100.128.0.0')).toBe(false)
      expect(isBlockedIp('172.15.255.255')).toBe(false)
      expect(isBlockedIp('172.32.0.0')).toBe(false)
      expect(isBlockedIp('198.17.255.255')).toBe(false)
      expect(isBlockedIp('198.20.0.0')).toBe(false)
      expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
      expect(isBlockedIp('2001:4860:4860::8888')).toBe(false)
    })

    it('fails closed for non-IP input', () => {
      expect(isBlockedIp('not-an-ip')).toBe(true)
      expect(isBlockedIp('fe80::1%eth0')).toBe(true)
      expect(isBlockedIp('2606:4700:4700::1111%eth0')).toBe(true)
      expect(isBlockedIp('fe80::1%')).toBe(true)
      expect(isBlockedIp('2001:::1')).toBe(true)
      expect(isBlockedIp(undefined as never)).toBe(true)
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
      await expect(
        assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/', resolveToPublic),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
      await expect(assertPublicHttpUrl('http://192.0.2.1/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
      await expect(assertPublicHttpUrl('http://[::1]/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
      await expect(assertPublicHttpUrl('http://[0:0:0:0:0:0:0:1]/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
      await expect(assertPublicHttpUrl('http://[0:0:0:0:0:ffff:7f00:1]/x', resolveToPublic)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
    })

    it('rejects a hostname that resolves to a private address (DNS-rebinding defense)', async () => {
      const resolveToPrivate = async (): Promise<string[]> => ['10.0.0.5']
      await expect(assertPublicHttpUrl('https://evil.example.com/x', resolveToPrivate)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
    })

    it('rejects a hostname that resolves to an IANA special-use address', async () => {
      await expect(
        assertPublicHttpUrl('https://special-use.example.com/x', async () => ['198.51.100.7']),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it('rejects when ANY resolved address is private', async () => {
      const resolveMixed = async (): Promise<string[]> => ['93.184.216.34', '127.0.0.1']
      await expect(assertPublicHttpUrl('https://mixed.example.com/x', resolveMixed)).rejects.toMatchObject({
        tag: 'blocked-host',
      })
    })

    it('rejects alternate and special IPv6 forms returned by DNS', async () => {
      for (const address of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:7f00:1', 'fe90::1', 'fec0::1', '2002::1']) {
        await expect(
          assertPublicHttpUrl('https://rebinding.example.com/x', async () => [address]),
        ).rejects.toMatchObject({
          tag: 'blocked-host',
        })
      }
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

    it('returns the exact validated address set for connection pinning without re-resolving', async () => {
      const resolveHost = jest.fn().mockResolvedValue(['93.184.216.34', '2606:4700:4700::1111'])

      const resolved = await resolvePublicHttpUrl('https://example.com/hook', resolveHost)

      expect(resolveHost).toHaveBeenCalledTimes(1)
      expect(resolved.url.hostname).toBe('example.com')
      expect(resolved.addresses).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ])
    })

    it('uses the system DNS resolver when no resolver is injected', async () => {
      mockedLookup.mockResolvedValueOnce([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ])

      const url = await assertPublicHttpUrl('https://example.com/hook')

      expect(mockedLookup).toHaveBeenCalledWith('example.com', { all: true })
      expect(url.hostname).toBe('example.com')
    })

    it('accepts a literal public IP without resolving', async () => {
      const url = await assertPublicHttpUrl('https://8.8.8.8/x')
      expect(url.hostname).toBe('8.8.8.8')

      const ipv6Url = await assertPublicHttpUrl('https://[2606:4700:4700::1111]/x')
      expect(ipv6Url.hostname).toBe('[2606:4700:4700::1111]')
    })
  })
})
