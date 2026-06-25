import { isBlockedHostname, isBlockedIp, WebFetchLike, WebService, WebValidationError } from './WebService'

type Step = { status: number; location?: string; body?: string; contentType?: string }

/** A scripted fetchFn returning the given steps in order (last step repeats). */
const scriptedFetch = (steps: Step[]): { fn: WebFetchLike; calls: string[] } => {
  const calls: string[] = []
  let i = 0
  const fn: WebFetchLike = async (url) => {
    calls.push(url)
    const step = steps[Math.min(i++, steps.length - 1)]
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      headers: {
        get: (name: string) => {
          const n = name.toLowerCase()
          if (n === 'location') {
            return step.location ?? null
          }
          if (n === 'content-type') {
            return step.contentType ?? null
          }
          return null
        },
      },
      text: async () => step.body ?? '',
    }
  }
  return { fn, calls }
}

const makeService = (steps: Step[], resolveTo: Record<string, string[]> = {}) => {
  const { fn, calls } = scriptedFetch(steps)
  const resolveHost = async (host: string): Promise<string[]> => resolveTo[host] ?? ['93.184.216.34'] // example.com public
  return { service: new WebService(fn, {}, resolveHost), calls }
}

describe('WebService.fetch — SSRF guard', () => {
  it('fetches a public URL and returns readable text', async () => {
    const { service } = makeService([{ status: 200, contentType: 'text/html', body: '<title>Hi</title><p>hello world</p>' }])
    const result = await service.fetch('https://example.com/page')
    expect(result.status).toBe(200)
    expect(result.title).toBe('Hi')
    expect(result.text).toContain('hello world')
  })

  it('rejects non-http(s) schemes', async () => {
    const { service } = makeService([{ status: 200 }])
    await expect(service.fetch('file:///etc/passwd')).rejects.toMatchObject({ tag: 'invalid-scheme' })
  })

  it('rejects a literal private/metadata host up front', async () => {
    const { service } = makeService([{ status: 200 }])
    await expect(service.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ tag: 'blocked-host' })
    await expect(service.fetch('http://127.0.0.1:6379/')).rejects.toMatchObject({ tag: 'blocked-host' })
    await expect(service.fetch('http://localhost/')).rejects.toMatchObject({ tag: 'blocked-host' })
  })

  it('rejects a hostname that RESOLVES to a private address', async () => {
    const { service } = makeService([{ status: 200 }], { 'rebind.evil': ['10.0.0.5'] })
    await expect(service.fetch('https://rebind.evil/')).rejects.toMatchObject({ tag: 'blocked-host' })
  })

  it('BLOCKS a redirect to a private/metadata host (the SSRF bypass)', async () => {
    const { service, calls } = makeService([{ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }])
    await expect(service.fetch('https://example.com/redirect')).rejects.toBeInstanceOf(WebValidationError)
    // It must NOT have fetched the metadata endpoint — only the initial URL.
    expect(calls).toEqual(['https://example.com/redirect'])
  })

  it('follows a redirect to a public host', async () => {
    const { service } = makeService(
      [
        { status: 302, location: 'https://elsewhere.test/final' },
        { status: 200, contentType: 'text/html', body: '<p>final page</p>' },
      ],
      { 'elsewhere.test': ['198.51.100.7'] },
    )
    const result = await service.fetch('https://example.com/start')
    expect(result.text).toContain('final page')
  })

  it('stops after too many redirects', async () => {
    let n = 0
    const fn: WebFetchLike = async () => ({
      status: 302,
      ok: false,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? `https://hop${n++}.test/` : null) },
      text: async () => '',
    })
    const service = new WebService(fn, {}, async () => ['198.51.100.7'])
    await expect(service.fetch('https://example.com/')).rejects.toMatchObject({ tag: 'too-many-redirects' })
  })
})

describe('isBlockedIp / isBlockedHostname', () => {
  it('blocks private/loopback/link-local IPv4', () => {
    for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1']) {
      expect(isBlockedIp(ip)).toBe(true)
    }
  })

  it('allows public IPv4', () => {
    expect(isBlockedIp('1.1.1.1')).toBe(false)
    expect(isBlockedIp('93.184.216.34')).toBe(false)
  })

  it('blocks IPv6 loopback, ULA, link-local, multicast', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1']) {
      expect(isBlockedIp(ip)).toBe(true)
    }
  })

  it('blocks IPv4-mapped and NAT64 IPv6 that embed a private IPv4 (dotted and hex)', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:7f00:1')).toBe(true) // 127.0.0.1 in hextets
    expect(isBlockedIp('64:ff9b::169.254.169.254')).toBe(true)
    expect(isBlockedIp('64:ff9b::a9fe:a9fe')).toBe(true) // 169.254.169.254 in hextets
    expect(isBlockedIp('64:ff9b::')).toBe(true) // any NAT64 prefix fails closed
  })

  it('allows a public IPv6', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false)
  })

  it('blocks internal hostnames', () => {
    for (const h of ['localhost', 'foo.localhost', 'svc.internal', 'box.local', 'metadata']) {
      expect(isBlockedHostname(h)).toBe(true)
    }
    expect(isBlockedHostname('example.com')).toBe(false)
  })
})
