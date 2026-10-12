import { DavBridgeRefusal } from './DavBridgeRefusal'
import { canonicalAddress, DAV_OWN_SERVICE_NAMES, DAV_OWN_SERVICE_PORTS, DavNetworkPolicy } from './DavNetworkPolicy'
import { DavRelay, DavRelayTarget } from './DavRelay'
import { SecretString } from './SecretString'
import { AttemptedConnection, FakeRemote, recordingFactory, resolver } from './DavBridgeTestKit.spec'

/**
 * The network policy, as a table of targets. Every row is driven two ways,
 * because the address is checked twice in production: when an account is saved
 * (`assertSavable`, which opens no connection at all) and when a request is
 * relayed (`DavRelay.forward`, through the real pinned transport).
 *
 * The assertion that matters is the count of connection attempts recorded by
 * the socket factory: ZERO for a refused target, ONE (to the expected address)
 * for the control. "It threw" alone would be satisfied by a relay that refuses
 * everything, and "the status was not 200" by one that connected first.
 */

const DNS: Record<string, string[]> = {
  'cloud.example.org': ['93.184.216.34'],
  'v6.example.org': ['2606:4700:4700::1111'],
  'nextcloud.lan': ['192.168.1.20'],
  'nextcloud.home.arpa': ['10.20.30.40'],
  'tailnet.example': ['100.64.10.20'],
  'ula.example': ['fd12:3456:789a::20'],
  'printer.local': ['192.168.1.30'],
  'nas.internal': ['10.0.0.9'],
  'to-loopback.example': ['127.0.0.1'],
  'to-loopback6.example': ['::1'],
  'to-metadata.example': ['169.254.169.254'],
  'to-linklocal.example': ['169.254.7.7'],
  'to-unspecified.example': ['0.0.0.0'],
  'to-multicast.example': ['224.0.0.251'],
  'to-mapped.example': ['::ffff:10.0.0.5'],
  'to-mapped-loopback.example': ['::ffff:127.0.0.1'],
  'mixed.example': ['93.184.216.34', '127.0.0.1'],
  'mixed-private.example': ['192.168.1.20', '169.254.169.254'],
  'alias-of-db.lan': ['172.18.0.4'],
  // An address of THIS machine that is not one of the named services.
  'alias-of-self.lan': ['172.18.0.77'],
  localhost: ['127.0.0.1'],
  'app.localhost': ['127.0.0.1'],
  metadata: ['169.254.169.254'],
  'metadata.google.internal': ['169.254.169.254'],
  // The stack's own names, as Docker's DNS would answer them.
  db: ['172.18.0.4'],
  cache: ['172.18.0.5'],
  server: ['172.18.0.7'],
}

const OWN_SERVICES: Record<string, string[]> = {
  db: ['172.18.0.4'],
  cache: ['172.18.0.5'],
  server: ['172.18.0.7'],
}

describe('DAV network policy', () => {
  let remote: FakeRemote
  let attempts: AttemptedConnection[]
  let policy: DavNetworkPolicy
  let relay: DavRelay
  let dns: ReturnType<typeof resolver>

  beforeEach(async () => {
    remote = new FakeRemote()
    await remote.start()
    const recording = recordingFactory(remote)
    attempts = recording.attempts
    dns = resolver(DNS)
    policy = new DavNetworkPolicy({
      resolveHost: dns,
      requestFactory: recording.factory,
      resolveOwnServiceName: async (name) => {
        const answer = OWN_SERVICES[name]
        if (!answer) {
          throw new Error('ENOTFOUND')
        }
        return answer
      },
      ownInterfaceAddresses: () => ['172.18.0.77', '127.0.0.1', '::1'],
    })
    relay = new DavRelay(policy)
  })

  afterEach(async () => {
    await remote.stop()
  })

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

  const save = (origin: string, listed: string[] = []): Promise<unknown> =>
    policy.assertSavable(new URL(origin), new Set(listed))

  const relayTo = (origin: string, listed: string[] = []): Promise<unknown> => {
    const target: DavRelayTarget = {
      origin,
      credentialKind: 'basic',
      username: 'alice',
      secret: new SecretString('app-password'),
      pin: null,
      discoveryOpen: true,
      allowedPrivateOrigins: new Set(listed),
    }
    return relay.forward(target, { method: 'PROPFIND', path: '/', headers: {}, body: undefined })
  }

  describe('controls: what must work', () => {
    it('saves and relays to a public https origin on 443, connecting to the address DNS gave', async () => {
      await save('https://cloud.example.org')
      expect(attempts).toHaveLength(0)

      await relayTo('https://cloud.example.org')

      expect(attempts).toEqual([
        expect.objectContaining({
          protocol: 'https:',
          address: '93.184.216.34',
          port: undefined,
          host: 'cloud.example.org',
        }),
      ])
      expect(remote.received[0].headers.authorization).toBe(
        `Basic ${Buffer.from('alice:app-password').toString('base64')}`,
      )
    })

    it('relays to a public IPv6 address', async () => {
      await relayTo('https://v6.example.org')

      expect(attempts.map((attempt) => attempt.address)).toEqual(['2606:4700:4700::1111'])
    })

    it.each([
      ['an RFC 1918 host over plain http', 'http://nextcloud.lan', '192.168.1.20', 'http:'],
      ['a 10.x host over https on a custom port', 'https://nextcloud.home.arpa:8443', '10.20.30.40', 'https:'],
      ['a carrier-grade NAT (tailnet) host', 'http://tailnet.example', '100.64.10.20', 'http:'],
      ['a unique-local IPv6 host', 'http://ula.example', 'fd12:3456:789a::20', 'http:'],
      ['a .local name', 'http://printer.local', '192.168.1.30', 'http:'],
      ['a .internal name', 'http://nas.internal:8080', '10.0.0.9', 'http:'],
      ['a literal private address', 'http://192.168.1.20:8080', '192.168.1.20', 'http:'],
      ['a literal unique-local address', 'http://[fd12:3456:789a::20]', 'fd12:3456:789a::20', 'http:'],
    ])('reaches %s once the operator has listed its exact origin', async (_label, origin, address, protocol) => {
      await save(origin, [origin])
      await relayTo(origin, [origin])

      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ address, protocol })
    })
  })

  describe('private space is closed unless the operator listed that exact origin', () => {
    it.each([
      ['an RFC 1918 host', 'https://nextcloud.lan'],
      ['a 10.x host', 'https://nextcloud.home.arpa'],
      ['a carrier-grade NAT host', 'https://tailnet.example'],
      ['a unique-local IPv6 host', 'https://ula.example'],
      ['a .local name', 'https://printer.local'],
      ['a .internal name', 'https://nas.internal'],
      ['a literal 10.x address', 'https://10.0.0.5'],
      ['a literal 192.168.x address', 'https://192.168.1.20'],
      ['a literal 172.16.x address', 'https://172.16.0.9'],
      ['a literal 100.64.x address', 'https://100.64.0.1'],
      ['a literal unique-local address', 'https://[fd12:3456:789a::20]'],
    ])('refuses %s, with one sentence, and opens no socket', async (_label, origin) => {
      const saving = await refusalFrom(save(origin))
      const relaying = await refusalFrom(relayTo(origin))

      for (const refusal of [saving, relaying]) {
        expect(refusal.tag).toBe('dav-address-not-allowed')
        expect(refusal.httpStatus).toBe(403)
        expect(refusal.message).toBe(
          `This address is not allowed by this server's network policy. Ask the administrator to allow ${new URL(origin).origin}.`,
        )
      }
      expect(attempts).toHaveLength(0)
      expect(remote.received).toHaveLength(0)
    })

    it('does not extend a listed origin to another scheme, port or host', async () => {
      const listed = ['http://nextcloud.lan']

      for (const origin of ['https://nextcloud.lan', 'http://nextcloud.lan:8080', 'http://nextcloud.home.arpa']) {
        expect((await refusalFrom(relayTo(origin, listed))).tag).toBe('dav-address-not-allowed')
        expect((await refusalFrom(save(origin, listed))).tag).toBe('dav-address-not-allowed')
      }
      expect(attempts).toHaveLength(0)
    })
  })

  describe('the never-allow class: refused whatever the operator listed', () => {
    const NEVER: Array<[string, string]> = [
      ['loopback', 'http://127.0.0.1'],
      ['loopback on the gateway port', 'http://127.0.0.1:3000'],
      ['another loopback address', 'http://127.8.9.10'],
      ['loopback, decimal spelling', 'http://2130706433'],
      ['loopback, hexadecimal spelling', 'http://0x7f.0.0.1'],
      ['loopback, octal spelling', 'http://0177.0.0.1'],
      ['loopback, short spelling', 'http://127.1'],
      ['IPv6 loopback', 'http://[::1]'],
      ['IPv6 loopback, long spelling', 'http://[0:0:0:0:0:0:0:1]'],
      ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]'],
      ['IPv4-mapped loopback, hex spelling', 'http://[::ffff:7f00:1]'],
      ['an IPv4-mapped private address', 'http://[::ffff:10.0.0.5]'],
      ['the cloud metadata address', 'http://169.254.169.254'],
      ['link-local', 'http://169.254.7.7'],
      ['IPv6 link-local', 'http://[fe80::1]'],
      ['the unspecified address', 'http://0.0.0.0'],
      ['the unspecified address, short spelling', 'http://0'],
      ['the IPv6 unspecified address', 'http://[::]'],
      ['multicast', 'http://224.0.0.251'],
      ['the name localhost', 'http://localhost'],
      ['a name under .localhost', 'http://app.localhost'],
      ['the name metadata', 'http://metadata'],
      ['a cloud metadata host name', 'http://metadata.google.internal'],
      ['a name that resolves to loopback', 'http://to-loopback.example'],
      ['a name that resolves to IPv6 loopback', 'http://to-loopback6.example'],
      ['a name that resolves to the metadata address', 'http://to-metadata.example'],
      ['a name that resolves to link-local', 'http://to-linklocal.example'],
      ['a name that resolves to the unspecified address', 'http://to-unspecified.example'],
      ['a name that resolves to multicast', 'http://to-multicast.example'],
      ['a name that resolves to an IPv4-mapped private address', 'http://to-mapped.example'],
      ['a name that resolves to IPv4-mapped loopback', 'http://to-mapped-loopback.example'],
      ['a name with a public and a loopback answer', 'http://mixed.example'],
      ['a name with a private and a metadata answer', 'http://mixed-private.example'],
    ]

    it.each(NEVER)('%s: refused when not listed', async (_label, origin) => {
      const saving = await refusalFrom(save(origin))
      const relaying = await refusalFrom(relayTo(origin))

      expect(saving.tag).toBe('dav-address-not-allowed')
      expect(relaying.tag).toBe('dav-address-not-allowed')
      expect(attempts).toHaveLength(0)
    })

    it.each(NEVER)('%s: STILL refused when the operator listed that exact origin', async (_label, origin) => {
      const exact = new URL(origin).origin
      const saving = await refusalFrom(save(origin, [exact]))
      const relaying = await refusalFrom(relayTo(origin, [exact]))

      expect(saving.tag).toBe('dav-address-not-allowed')
      expect(relaying.tag).toBe('dav-address-not-allowed')
      expect(attempts).toHaveLength(0)
      expect(remote.received).toHaveLength(0)
    })
  })

  describe("this deployment's own services", () => {
    it('the fixed list names the services of the shipped compose file', () => {
      expect([...DAV_OWN_SERVICE_NAMES].sort()).toEqual(
        ['app', 'cache', 'db', 'docker-socket-proxy', 'floci', 'mcp', 'n8n', 'server'].sort(),
      )
      expect(DAV_OWN_SERVICE_PORTS).toEqual(expect.arrayContaining([3000, 3101, 3103, 3104, 3105, 50051, 50052]))
    })

    it.each([
      'http://db:3306',
      'http://db',
      'http://cache:6379',
      'http://server:3000',
      'http://server:3103',
      'http://app:8080',
      'http://floci:4566',
      'http://mcp',
      'http://n8n:5678',
      'http://docker-socket-proxy:2375',
      'http://DB:3306',
      'http://db.:3306',
      'https://db',
    ])('refuses %s by name, listed or not, without a DNS lookup', async (origin) => {
      const exact = new URL(origin).origin

      for (const listed of [[], [exact]]) {
        const saving = await refusalFrom(save(origin, listed))
        const relaying = await refusalFrom(relayTo(origin, listed))

        expect(saving.tag).toBe('dav-address-not-allowed')
        expect(saving.logTag).toBe('own-service-name')
        expect(relaying.logTag).toBe('own-service-name')
      }
      expect(attempts).toHaveLength(0)
      expect(dns.lookups).toHaveLength(0)
    })

    it('refuses a listed name that is an alias for one of them, by the address it resolves to', async () => {
      const origin = 'http://alias-of-db.lan:3306'

      expect((await refusalFrom(save(origin, [origin]))).tag).toBe('dav-address-not-allowed')
      expect((await refusalFrom(relayTo(origin, [origin]))).tag).toBe('dav-address-not-allowed')
      expect(attempts).toHaveLength(0)
    })

    it('refuses the literal address of one of them when the operator listed it', async () => {
      const origin = 'http://172.18.0.5:6379'

      expect((await refusalFrom(relayTo(origin, [origin]))).tag).toBe('dav-address-not-allowed')
      expect(attempts).toHaveLength(0)
    })

    it("refuses this machine's own address on one of the server's own ports", async () => {
      for (const port of [3000, 3103, 50051]) {
        const origin = `http://alias-of-self.lan:${port}`

        expect((await refusalFrom(relayTo(origin, [origin]))).tag).toBe('dav-address-not-allowed')
        expect((await refusalFrom(save(origin, [origin]))).tag).toBe('dav-address-not-allowed')
      }
      expect(attempts).toHaveLength(0)
    })

    it("reaches this machine's own address on a port that is not the server's (a Nextcloud beside it)", async () => {
      const origin = 'http://alias-of-self.lan:8080'

      await save(origin, [origin])
      await relayTo(origin, [origin])

      expect(attempts).toEqual([expect.objectContaining({ address: '172.18.0.77', port: '8080' })])
    })

    it('looks the own names up at most once a minute, not once per request', async () => {
      const ownLookups: string[] = []
      const recording = recordingFactory(remote)
      let now = 1_000_000
      const counting = new DavNetworkPolicy({
        resolveHost: dns,
        requestFactory: recording.factory,
        resolveOwnServiceName: async (name) => {
          ownLookups.push(name)
          return OWN_SERVICES[name] ?? []
        },
        ownInterfaceAddresses: () => [],
        now: () => now,
      })
      const origin = new URL('http://nextcloud.lan')
      const listed = new Set([origin.origin])

      await counting.assertSavable(origin, listed)
      await counting.assertSavable(origin, listed)
      expect(ownLookups).toHaveLength(DAV_OWN_SERVICE_NAMES.length)

      now += 61_000
      await counting.assertSavable(origin, listed)
      expect(ownLookups).toHaveLength(DAV_OWN_SERVICE_NAMES.length * 2)
    })

    it('does not look the own names up at all for an origin that is not listed', async () => {
      const ownLookups: string[] = []
      const unlisted = new DavNetworkPolicy({
        resolveHost: dns,
        resolveOwnServiceName: async (name) => {
          ownLookups.push(name)
          return []
        },
        ownInterfaceAddresses: () => [],
      })

      await unlisted.assertSavable(new URL('https://cloud.example.org'), new Set())

      expect(ownLookups).toHaveLength(0)
    })

    it('still works where none of the own names resolve (every topology but compose)', async () => {
      const recording = recordingFactory(remote)
      const single = new DavNetworkPolicy({
        resolveHost: dns,
        requestFactory: recording.factory,
        resolveOwnServiceName: async () => {
          throw new Error('ENOTFOUND')
        },
        ownInterfaceAddresses: () => ['127.0.0.1'],
      })
      const origin = 'http://nextcloud.lan'

      await new DavRelay(single).forward(
        {
          origin,
          credentialKind: 'basic',
          username: 'a',
          secret: new SecretString('b'),
          pin: null,
          discoveryOpen: true,
          allowedPrivateOrigins: new Set([origin]),
        },
        { method: 'PROPFIND', path: '/', headers: {}, body: undefined },
      )

      expect(recording.attempts.map((attempt) => attempt.address)).toEqual(['192.168.1.20'])
    })
  })

  describe('scheme and port', () => {
    it('tells a public http address to use https', async () => {
      for (const refusal of [
        await refusalFrom(save('http://cloud.example.org')),
        await refusalFrom(relayTo('http://cloud.example.org')),
      ]) {
        expect(refusal.tag).toBe('dav-https-required')
        expect(refusal.httpStatus).toBe(400)
        expect(refusal.extra).toEqual({ origin: 'http://cloud.example.org' })
      }
      expect(attempts).toHaveLength(0)
    })

    it('does not tell a private http address to use https, because https would be refused as well', async () => {
      expect((await refusalFrom(save('http://nextcloud.lan'))).tag).toBe('dav-address-not-allowed')
      expect((await refusalFrom(relayTo('http://192.168.1.20'))).tag).toBe('dav-address-not-allowed')
      expect(attempts).toHaveLength(0)
    })

    it('allows a public http address the operator listed', async () => {
      await relayTo('http://cloud.example.org', ['http://cloud.example.org'])

      expect(attempts).toEqual([expect.objectContaining({ protocol: 'http:', address: '93.184.216.34' })])
    })

    it('refuses a public https address on another port until the operator lists it', async () => {
      const origin = 'https://cloud.example.org:8443'
      const refusal = await refusalFrom(relayTo(origin))

      expect(refusal.tag).toBe('dav-address-not-allowed')
      expect(refusal.logTag).toBe('port-not-listed')
      expect(attempts).toHaveLength(0)

      await relayTo(origin, [origin])
      expect(attempts).toEqual([expect.objectContaining({ address: '93.184.216.34', port: '8443' })])
    })

    it('treats an explicit :443 as the default port', async () => {
      await relayTo('https://cloud.example.org:443')

      expect(attempts).toHaveLength(1)
    })

    it.each(['ftp://cloud.example.org', 'file:///etc/passwd', 'gopher://cloud.example.org'])(
      'refuses the scheme of %s',
      async (target) => {
        const refusal = await refusalFrom(policy.assertSavable(new URL(target), new Set()))

        expect(refusal.tag).toBe('dav-address-not-allowed')
        expect(refusal.logTag).toBe('scheme')
      },
    )
  })

  describe('names', () => {
    it('reports a name that does not exist as not found while saving (400) and while relaying (502)', async () => {
      const saving = await refusalFrom(save('https://no-such-host.example'))
      const relaying = await refusalFrom(relayTo('https://no-such-host.example'))

      expect(saving).toMatchObject({ tag: 'dav-host-not-found', httpStatus: 400 })
      expect(relaying).toMatchObject({ tag: 'dav-host-not-found', httpStatus: 502 })
      expect(saving.extra).toEqual({ host: 'no-such-host.example' })
    })

    it('connects to what the name resolved to at connect time, not to an earlier answer', async () => {
      const recording = recordingFactory(remote)
      const moving = jest.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['93.184.216.99'])
      const rebinding = new DavNetworkPolicy({
        resolveHost: moving,
        requestFactory: recording.factory,
        resolveOwnServiceName: async () => [],
        ownInterfaceAddresses: () => [],
      })
      const url = new URL('https://moving.example')

      // Saving resolves once and opens nothing.
      await rebinding.assertSavable(url, new Set())
      expect(recording.attempts).toHaveLength(0)

      // Relaying resolves again and pins to THAT answer.
      const transport = await rebinding.transportFor(url, { listed: false })
      const response = await transport.request({ url, method: 'OPTIONS', redirect: 'manual' })
      await response.discard()

      expect(moving).toHaveBeenCalledTimes(2)
      expect(recording.attempts.map((attempt) => attempt.address)).toEqual(['93.184.216.99'])
    })

    it('opens no socket when the name was public at save time and is private at relay time', async () => {
      const recording = recordingFactory(remote)
      const turning = jest.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['10.0.0.5'])
      const rebinding = new DavNetworkPolicy({
        resolveHost: turning,
        requestFactory: recording.factory,
        resolveOwnServiceName: async () => [],
        ownInterfaceAddresses: () => [],
      })

      await rebinding.assertSavable(new URL('https://turning.example'), new Set())
      const refusal = await refusalFrom(
        new DavRelay(rebinding).forward(
          {
            origin: 'https://turning.example',
            credentialKind: 'basic',
            username: 'a',
            secret: new SecretString('b'),
            pin: null,
            discoveryOpen: true,
            allowedPrivateOrigins: new Set(),
          },
          { method: 'PROPFIND', path: '/', headers: {}, body: undefined },
        ),
      )

      expect(refusal.tag).toBe('dav-address-not-allowed')
      expect(recording.attempts).toHaveLength(0)
    })
  })

  describe('canonicalAddress', () => {
    it('gives every spelling of one IPv6 address the same form', () => {
      expect(canonicalAddress('FD12:3456:789A:0:0:0:0:20')).toBe('fd12:3456:789a::20')
      expect(canonicalAddress('fd12:3456:789a::20')).toBe('fd12:3456:789a::20')
      expect(canonicalAddress('0:0:0:0:0:0:0:1')).toBe('::1')
    })

    it('leaves IPv4 and non-addresses alone', () => {
      expect(canonicalAddress('172.18.0.4')).toBe('172.18.0.4')
      expect(canonicalAddress('not-an-address')).toBe('not-an-address')
    })
  })
})
