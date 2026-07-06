import { PluginsFetchLike, PluginsProxyService, resolveWithinBase } from './PluginsProxyService'

const BASE = 'https://raw.githubusercontent.com/standardnotes/plugins/main/cdn/dist'

/** A minimal fetch double that records the URL and returns canned bytes. */
const makeFetch = (
  impl: (url: string) => { status: number; ok: boolean; contentType?: string; body?: Buffer },
): { fn: PluginsFetchLike; calls: string[] } => {
  const calls: string[] = []
  const fn: PluginsFetchLike = async (url) => {
    calls.push(url)
    const result = impl(url)
    return {
      status: result.status,
      ok: result.ok,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? result.contentType ?? null : null) },
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        const buf = result.body ?? Buffer.from('')
        const ab = new ArrayBuffer(buf.length)
        new Uint8Array(ab).set(buf)
        return ab
      },
    }
  }
  return { fn, calls }
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

  it('enforces the response size cap', async () => {
    const { fn } = makeFetch(() => ({ status: 200, ok: true, body: Buffer.alloc(2048) }))
    const service = new PluginsProxyService(fn, { baseUrlResolver: async () => BASE, maxBytes: 1024 })

    expect(await service.fetchIndex()).toEqual({ error: 'too-large' })
  })
})
