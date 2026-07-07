import { isWithinBase, PluginsFetchLike, PluginsProxyService, resolveWithinBase } from './PluginsProxyService'

const BASE = 'https://raw.githubusercontent.com/standardnotes/plugins/main/cdn/dist'

type FetchDoubleResult = {
  status: number
  ok: boolean
  contentType?: string
  contentLength?: string
  location?: string
  /** Buffered body (arrayBuffer fallback path — no stream). */
  body?: Buffer
  /** Streamed body chunks (exercises the readCappedBody streaming path). */
  bodyChunks?: Buffer[]
}

/**
 * A fetch double that records URLs and can model redirects, streamed bodies, and
 * response headers. `streamReads` counts how many chunks were pulled from the
 * stream so a test can assert an oversized body is rejected WITHOUT full buffering.
 */
const makeFetch = (
  impl: (url: string) => FetchDoubleResult,
): { fn: PluginsFetchLike; calls: string[]; streamReads: () => number } => {
  const calls: string[] = []
  let readChunks = 0
  const fn: PluginsFetchLike = async (url) => {
    calls.push(url)
    const result = impl(url)
    const headerFor = (name: string): string | null => {
      switch (name.toLowerCase()) {
        case 'content-type':
          return result.contentType ?? null
        case 'content-length':
          return result.contentLength ?? null
        case 'location':
          return result.location ?? null
        default:
          return null
      }
    }

    const allBytes = result.body ?? Buffer.concat(result.bodyChunks ?? [])

    return {
      status: result.status,
      ok: result.ok,
      headers: { get: headerFor },
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        const ab = new ArrayBuffer(allBytes.length)
        new Uint8Array(ab).set(allBytes)
        return ab
      },
      body: result.bodyChunks
        ? {
            getReader: () => {
              let index = 0
              let cancelled = false
              return {
                read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                  if (cancelled || index >= (result.bodyChunks as Buffer[]).length) {
                    return { done: true }
                  }
                  const chunk = (result.bodyChunks as Buffer[])[index++]
                  readChunks += 1
                  return { done: false, value: new Uint8Array(chunk) }
                },
                cancel: async (): Promise<void> => {
                  cancelled = true
                },
                releaseLock: (): void => undefined,
              }
            },
          }
        : undefined,
    }
  }
  return { fn, calls, streamReads: () => readChunks }
}

describe('resolveWithinBase (SSRF guard)', () => {
  it('resolves a plain relative path under the base directory', () => {
    expect(resolveWithinBase(BASE, 'org.standardnotes.bold-editor/index.html')).toEqual(
      `${BASE}/org.standardnotes.bold-editor/index.html`,
    )
  })

  it('treats a leading slash as still-relative to the base (never host-absolute)', () => {
    expect(resolveWithinBase(BASE, '/packages.json')).toEqual(`${BASE}/packages.json`)
  })

  it('rejects an absolute URL to another host', () => {
    expect(resolveWithinBase(BASE, 'https://evil.example.com/x')).toBeNull()
    expect(resolveWithinBase(BASE, 'http://evil.example.com/x')).toBeNull()
  })

  it('rejects a scheme-relative host', () => {
    expect(resolveWithinBase(BASE, '//evil.example.com/x')).toBeNull()
  })

  it('rejects ../ traversal that climbs above the base directory', () => {
    expect(resolveWithinBase(BASE, '../../../../etc/passwd')).toBeNull()
    expect(resolveWithinBase(BASE, 'ok/../../../secret')).toBeNull()
  })

  it('rejects percent-encoded dot/slash traversal (..%2f — WHATWG does not decode it)', () => {
    expect(resolveWithinBase(BASE, '..%2f..%2f..%2fetc/passwd')).toBeNull()
    expect(resolveWithinBase(BASE, 'ok%2F..%2F..%2Fsecret')).toBeNull()
    expect(resolveWithinBase(BASE, 'a/%2e%2e/%2e%2e/secret')).toBeNull()
    // case-insensitive
    expect(resolveWithinBase(BASE, 'a%2Fb')).toBeNull()
  })

  it('allows traversal that stays within the base directory', () => {
    expect(resolveWithinBase(BASE, 'a/b/../c.js')).toEqual(`${BASE}/a/c.js`)
  })

  it('rejects an empty or non-string path', () => {
    expect(resolveWithinBase(BASE, '')).toBeNull()
    expect(resolveWithinBase(BASE, undefined as never)).toBeNull()
  })

  it('rejects a non-http(s) base', () => {
    expect(resolveWithinBase('ftp://x/y', 'packages.json')).toBeNull()
  })

  it('does not let a sibling directory with the base as a name-prefix leak through', () => {
    // base ".../dist" must not match ".../dist-evil/..." (prefix check is on the
    // directory form ".../dist/").
    expect(resolveWithinBase('https://host/dist', 'https://host/dist-evil/x')).toBeNull()
  })
})

describe('isWithinBase (redirect-target containment guard)', () => {
  it('accepts an absolute URL under the base directory', () => {
    expect(isWithinBase(BASE, `${BASE}/org.foo/dist/index.js`)).toBe(true)
    expect(isWithinBase(BASE, `${BASE}/packages.json`)).toBe(true)
  })

  it('rejects a redirect to a different host', () => {
    expect(isWithinBase(BASE, 'https://evil.example.com/x')).toBe(false)
    expect(isWithinBase(BASE, 'http://169.254.169.254/latest/meta-data/')).toBe(false)
  })

  it('rejects a protocol downgrade / different scheme on the same host', () => {
    expect(isWithinBase('https://host/dist', 'http://host/dist/x')).toBe(false)
  })

  it('rejects a path that climbs out of the base directory', () => {
    expect(isWithinBase(BASE, 'https://raw.githubusercontent.com/other/secret')).toBe(false)
  })

  it('rejects a sibling directory sharing the base as a name-prefix', () => {
    expect(isWithinBase('https://host/dist', 'https://host/dist-evil/x')).toBe(false)
  })
})

describe('PluginsProxyService', () => {
  it('fetchIndex fetches <base>/packages.json and returns the body', async () => {
    const { fn, calls } = makeFetch(() => ({
      status: 200,
      ok: true,
      contentType: 'text/plain',
      body: Buffer.from('{"a":{}}'),
    }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    const result = await service.fetchIndex()
    expect(calls).toEqual([`${BASE}/packages.json`])
    expect('body' in result && result.body.toString()).toEqual('{"a":{}}')
  })

  it('fetchIndex uses the RESOLVED base (admin override) per call', async () => {
    let base = BASE
    const { fn, calls } = makeFetch(() => ({ status: 200, ok: true, body: Buffer.from('{}') }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => base })

    await service.fetchIndex()
    base = 'https://mirror.example.com/plugins'
    await service.fetchIndex()

    expect(calls).toEqual([`${BASE}/packages.json`, 'https://mirror.example.com/plugins/packages.json'])
  })

  it('fetchFile fetches a path under the base', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 200, ok: true, body: Buffer.from('JS') }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    const result = await service.fetchFile('org.foo/dist/index.js')
    expect(calls).toEqual([`${BASE}/org.foo/dist/index.js`])
    expect('body' in result).toBe(true)
  })

  it('fetchFile REJECTS a request outside the base without fetching (SSRF guard)', async () => {
    const { fn, calls } = makeFetch(() => ({ status: 200, ok: true, body: Buffer.from('x') }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    const result = await service.fetchFile('https://evil.example.com/x')
    expect(result).toEqual({ error: 'outside-base' })
    expect(calls).toEqual([]) // never fetched
  })

  it('maps an upstream non-2xx to an upstream error', async () => {
    const { fn } = makeFetch(() => ({ status: 404, ok: false }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    expect(await service.fetchIndex()).toEqual({ error: 'upstream', status: 404 })
  })

  it('maps a thrown fetch (network/abort) to unreachable', async () => {
    const fn: PluginsFetchLike = async () => {
      throw new Error('boom')
    }
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    expect(await service.fetchIndex()).toEqual({ error: 'unreachable' })
  })

  it('enforces the response size cap (buffered fallback: no stream body)', async () => {
    const { fn } = makeFetch(() => ({ status: 200, ok: true, body: Buffer.alloc(2048) }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE, maxBytes: 1024 })

    expect(await service.fetchIndex()).toEqual({ error: 'too-large' })
  })

  it('rejects an oversized Content-Length WITHOUT reading the body (pre-check)', async () => {
    const { fn, streamReads } = makeFetch(() => ({
      status: 200,
      ok: true,
      contentLength: '999999999',
      bodyChunks: [Buffer.alloc(512), Buffer.alloc(512)],
    }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE, maxBytes: 1024 })

    expect(await service.fetchIndex()).toEqual({ error: 'too-large' })
    // Never pulled a single chunk — the declared length alone rejected it.
    expect(streamReads()).toBe(0)
  })

  it('rejects an oversized STREAMED body without buffering it all (running counter aborts)', async () => {
    // Ten 512B chunks (5120B) with NO content-length; the cap is 1024B, so the
    // counter must trip after ~3 chunks and stop — never reading all ten.
    const { fn, streamReads } = makeFetch(() => ({
      status: 200,
      ok: true,
      bodyChunks: Array.from({ length: 10 }, () => Buffer.alloc(512)),
    }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE, maxBytes: 1024 })

    expect(await service.fetchIndex()).toEqual({ error: 'too-large' })
    expect(streamReads()).toBeLessThan(10)
  })

  it('streams a within-cap body and returns the concatenated bytes', async () => {
    const { fn } = makeFetch(() => ({
      status: 200,
      ok: true,
      contentType: 'text/javascript',
      bodyChunks: [Buffer.from('hello '), Buffer.from('world')],
    }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    const result = await service.fetchIndex()
    expect('body' in result && result.body.toString()).toEqual('hello world')
  })

  it('does NOT auto-follow a redirect: a Location to another host is rejected (never fetched)', async () => {
    const { fn, calls } = makeFetch((url) =>
      url.endsWith('/packages.json')
        ? { status: 302, ok: false, location: 'https://evil.example.com/steal' }
        : { status: 200, ok: true, body: Buffer.from('should-never-reach') },
    )
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    expect(await service.fetchIndex()).toEqual({ error: 'outside-base' })
    // Only the first (redirecting) URL was ever fetched; the evil host was not.
    expect(calls).toEqual([`${BASE}/packages.json`])
  })

  it('follows a redirect that STAYS within the configured base', async () => {
    const target = `${BASE}/mirror/packages.json`
    const { fn, calls } = makeFetch((url) =>
      url === `${BASE}/packages.json`
        ? { status: 301, ok: false, location: target }
        : { status: 200, ok: true, body: Buffer.from('{"ok":true}') },
    )
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    const result = await service.fetchIndex()
    expect('body' in result && result.body.toString()).toEqual('{"ok":true}')
    expect(calls).toEqual([`${BASE}/packages.json`, target])
  })

  it('bounds a redirect loop that stays within base (does not spin forever)', async () => {
    // Always redirects to a sibling in-base URL → must give up after MAX_REDIRECTS.
    const { fn, calls } = makeFetch((url) => ({
      status: 302,
      ok: false,
      location: `${url}/again`,
    }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE })

    expect(await service.fetchIndex()).toEqual({ error: 'unreachable' })
    // 1 initial + MAX_REDIRECTS (5) follow attempts before bailing.
    expect(calls.length).toBe(6)
  })
})
