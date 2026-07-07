import { rewriteComponentUrlForSameOrigin } from './pluginsSameOrigin'

const BASE = 'https://raw.githubusercontent.com/standardnotes/plugins/main/cdn/dist'

describe('rewriteComponentUrlForSameOrigin', () => {
  const on = { repoUrl: BASE, sameOriginRendering: true }
  const off = { repoUrl: BASE, sameOriginRendering: false }

  it('leaves the URL unchanged when the opt-in is off (back-compat)', () => {
    const url = `${BASE}/org.foo/1.2.3/dist/index.html`
    expect(rewriteComponentUrlForSameOrigin(url, off)).toBe(url)
  })

  it('leaves the URL unchanged when there is no config yet', () => {
    const url = `${BASE}/org.foo/1.2.3/dist/index.html`
    expect(rewriteComponentUrlForSameOrigin(url, undefined)).toBe(url)
  })

  it('rewrites a hosted_url under the base to the same-origin component route', () => {
    expect(rewriteComponentUrlForSameOrigin(`${BASE}/org.foo/1.2.3/dist/index.html`, on)).toBe(
      '/v1/plugins/component/org.foo/1.2.3/dist/index.html',
    )
  })

  it('preserves the directory hierarchy so relative asset refs resolve back through the route', () => {
    expect(rewriteComponentUrlForSameOrigin(`${BASE}/a/build/static/js/main.js`, on)).toBe(
      '/v1/plugins/component/a/build/static/js/main.js',
    )
  })

  it('drops a query/hash from the relative path', () => {
    expect(rewriteComponentUrlForSameOrigin(`${BASE}/a/index.html?v=1#x`, on)).toBe(
      '/v1/plugins/component/a/index.html',
    )
  })

  it('does NOT rewrite a URL hosted outside the trusted base (never proxies arbitrary hosts)', () => {
    const external = 'https://evil.example.com/org.foo/dist/index.html'
    expect(rewriteComponentUrlForSameOrigin(external, on)).toBe(external)
  })

  it('does NOT rewrite a sibling whose name merely prefixes the base', () => {
    const sibling = `${BASE}-evil/org.foo/dist/index.html`
    expect(rewriteComponentUrlForSameOrigin(sibling, on)).toBe(sibling)
  })

  it('leaves a native/same-origin component URL (not under the base) unchanged', () => {
    const native = 'https://my-sn.example.com/components/assets/org.sn.editor/index.html'
    expect(rewriteComponentUrlForSameOrigin(native, on)).toBe(native)
  })

  it('returns an empty url unchanged', () => {
    expect(rewriteComponentUrlForSameOrigin('', on)).toBe('')
  })

  it('tolerates a base with a trailing slash', () => {
    expect(rewriteComponentUrlForSameOrigin(`${BASE}/a/index.html`, { repoUrl: `${BASE}/`, sameOriginRendering: true })).toBe(
      '/v1/plugins/component/a/index.html',
    )
  })
})
