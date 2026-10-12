import {
  isBlockedIp,
  isOperatorAllowablePrivateIp,
  resolveHttpUrlForOutboundConnection,
  SsrfValidationError,
} from './SsrfFilter'

const neverResolve = async (): Promise<string[]> => {
  throw new Error('a literal host must not be resolved')
}

const resolveTo =
  (...addresses: string[]) =>
  async (): Promise<string[]> =>
    addresses

const trusted = (origin: string, scope?: 'any' | 'private-ranges') => ({
  allowedPrivateOrigins: new Set([origin]),
  ...(scope ? { allowedPrivateOriginScope: scope } : {}),
})

describe('SsrfFilter operator trust scope', () => {
  describe('isOperatorAllowablePrivateIp', () => {
    it('admits RFC 1918, carrier-grade NAT and unique-local space at its boundaries', () => {
      for (const ip of [
        '10.0.0.0',
        '10.255.255.255',
        '172.16.0.0',
        '172.31.255.255',
        '192.168.0.0',
        '192.168.255.255',
        '100.64.0.0',
        '100.127.255.255',
        'fc00::',
        'fd12:3456:789a::1',
        'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      ]) {
        expect([ip, isOperatorAllowablePrivateIp(ip)]).toEqual([ip, true])
      }
    })

    it('never admits loopback, link-local, metadata, unspecified, multicast or the neighbours of a private range', () => {
      for (const ip of [
        '127.0.0.1',
        '127.255.255.255',
        '169.254.169.254',
        '169.254.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '255.255.255.255',
        '9.255.255.255',
        '11.0.0.0',
        '172.15.255.255',
        '172.32.0.0',
        '192.167.255.255',
        '192.169.0.0',
        '100.63.255.255',
        '100.128.0.0',
        '192.0.2.1',
        '198.18.0.1',
        '::1',
        '::',
        'fe80::1',
        'ff02::1',
        'fbff:ffff::1',
        'fe00::1',
        '2001:db8::1',
      ]) {
        expect([ip, isOperatorAllowablePrivateIp(ip)]).toEqual([ip, false])
      }
    })

    it('turns away an IPv4-mapped IPv6 address even when the IPv4 inside it is private', () => {
      // Node's BlockList matches an IPv4 rule against the mapped form, so without
      // the explicit mapped check these would ride in on the 10/8 rule.
      for (const ip of ['::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:192.168.1.1', '::ffff:127.0.0.1']) {
        expect([ip, isOperatorAllowablePrivateIp(ip)]).toEqual([ip, false])
      }
    })

    it('is false for public addresses and for anything that is not an address', () => {
      for (const value of ['8.8.8.8', '2606:4700:4700::1111', '', 'nextcloud', '10.0.0.1%eth0', 'fd00::1%eth0']) {
        expect([value, isOperatorAllowablePrivateIp(value)]).toEqual([value, false])
      }
      expect(isOperatorAllowablePrivateIp(undefined as unknown as string)).toBe(false)
    })

    it('admits only addresses the public filter blocks, so it can never widen public reach', () => {
      for (const ip of ['10.1.2.3', '172.20.0.9', '192.168.50.1', '100.100.100.100', 'fd00::5']) {
        expect(isOperatorAllowablePrivateIp(ip)).toBe(true)
        expect(isBlockedIp(ip)).toBe(true)
      }
    })
  })

  describe("scope 'private-ranges'", () => {
    const origin = 'http://nextcloud.lan'
    const policy = trusted(origin, 'private-ranges')

    it('lets a trusted origin resolve to a LAN address and returns that address for pinning', async () => {
      const resolved = await resolveHttpUrlForOutboundConnection(`${origin}/dav`, resolveTo('192.168.1.20'), policy)

      expect(resolved.addresses).toEqual([{ address: '192.168.1.20', family: 4 }])
    })

    it('lets a trusted origin resolve to a public address as well', async () => {
      const resolved = await resolveHttpUrlForOutboundConnection(`${origin}/dav`, resolveTo('93.184.216.34'), policy)

      expect(resolved.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    })

    it.each([
      ['loopback', '127.0.0.1'],
      ['loopback inside the block', '127.8.9.10'],
      ['the cloud metadata address', '169.254.169.254'],
      ['link-local', '169.254.10.10'],
      ['unspecified', '0.0.0.0'],
      ['multicast', '224.0.0.251'],
      ['IPv6 loopback', '::1'],
      ['IPv6 link-local', 'fe80::1'],
      ['IPv6 unspecified', '::'],
      ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
      ['IPv4-mapped private', '::ffff:10.0.0.5'],
      ['NAT64', '64:ff9b::7f00:1'],
    ])('still refuses a trusted origin that resolves to %s', async (_label, address) => {
      await expect(
        resolveHttpUrlForOutboundConnection(`${origin}/dav`, resolveTo(address), policy),
      ).rejects.toMatchObject({ name: 'SsrfValidationError', tag: 'blocked-host' })
    })

    it('refuses when one of several answers is loopback, even though another is a LAN address', async () => {
      await expect(
        resolveHttpUrlForOutboundConnection(`${origin}/dav`, resolveTo('192.168.1.20', '127.0.0.1'), policy),
      ).rejects.toBeInstanceOf(SsrfValidationError)
    })

    it.each([
      'http://127.0.0.1',
      'http://[::1]',
      'http://169.254.169.254',
      'http://0.0.0.0',
      'http://[::ffff:7f00:1]',
      'http://[fe80::1]',
    ])('refuses the literal host %s although the operator listed that exact origin', async (literalOrigin) => {
      await expect(
        resolveHttpUrlForOutboundConnection(
          `${literalOrigin}/`,
          neverResolve,
          trusted(literalOrigin, 'private-ranges'),
        ),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it.each(['http://10.0.0.5', 'http://192.168.1.20:8080', 'http://[fd00::5]'])(
      'accepts the literal private host %s when the operator listed that exact origin',
      async (literalOrigin) => {
        const resolved = await resolveHttpUrlForOutboundConnection(
          `${literalOrigin}/dav`,
          neverResolve,
          trusted(literalOrigin, 'private-ranges'),
        )

        expect(resolved.addresses).toHaveLength(1)
      },
    )

    it('gives an origin that is not on the list no private reach at all', async () => {
      await expect(
        resolveHttpUrlForOutboundConnection('http://other.lan/dav', resolveTo('192.168.1.20'), policy),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
      // Same host, another port: a different origin, so not trusted.
      await expect(
        resolveHttpUrlForOutboundConnection('http://nextcloud.lan:8080/dav', resolveTo('192.168.1.20'), policy),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
      // Same host, another scheme.
      await expect(
        resolveHttpUrlForOutboundConnection('https://nextcloud.lan/dav', resolveTo('192.168.1.20'), policy),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })
  })

  describe("scope 'any' (the default) keeps the behaviour existing callers rely on", () => {
    it('lets a trusted origin resolve to loopback when no scope is given', async () => {
      const resolved = await resolveHttpUrlForOutboundConnection(
        'http://search.internal:8080/',
        resolveTo('127.0.0.1'),
        trusted('http://search.internal:8080'),
      )

      expect(resolved.addresses).toEqual([{ address: '127.0.0.1', family: 4 }])
    })

    it("does the same when the scope is spelled out as 'any'", async () => {
      const resolved = await resolveHttpUrlForOutboundConnection(
        'http://127.0.0.1:7700/',
        neverResolve,
        trusted('http://127.0.0.1:7700', 'any'),
      )

      expect(resolved.addresses).toEqual([{ address: '127.0.0.1', family: 4 }])
    })
  })

  describe('isAddressDenied', () => {
    const denied = new Set(['172.18.0.4', '93.184.216.34'])
    const isAddressDenied = (address: string): boolean => denied.has(address)

    it('refuses a denied address for a trusted origin', async () => {
      await expect(
        resolveHttpUrlForOutboundConnection('http://nextcloud.lan/', resolveTo('172.18.0.4'), {
          ...trusted('http://nextcloud.lan', 'private-ranges'),
          isAddressDenied,
        }),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it('refuses a denied address even when it is public and the origin is ordinary', async () => {
      await expect(
        resolveHttpUrlForOutboundConnection('https://example.com/', resolveTo('93.184.216.34'), { isAddressDenied }),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it('refuses a denied literal host without resolving', async () => {
      await expect(
        resolveHttpUrlForOutboundConnection('http://172.18.0.4/', neverResolve, {
          ...trusted('http://172.18.0.4', 'private-ranges'),
          isAddressDenied,
        }),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it('refuses when any one of several answers is denied', async () => {
      await expect(
        resolveHttpUrlForOutboundConnection('http://nextcloud.lan/', resolveTo('172.18.0.9', '172.18.0.4'), {
          ...trusted('http://nextcloud.lan', 'private-ranges'),
          isAddressDenied,
        }),
      ).rejects.toMatchObject({ tag: 'blocked-host' })
    })

    it('leaves an address it does not name to the ordinary rules', async () => {
      const resolved = await resolveHttpUrlForOutboundConnection('http://nextcloud.lan/', resolveTo('172.18.0.9'), {
        ...trusted('http://nextcloud.lan', 'private-ranges'),
        isAddressDenied,
      })

      expect(resolved.addresses).toEqual([{ address: '172.18.0.9', family: 4 }])
    })
  })
})
