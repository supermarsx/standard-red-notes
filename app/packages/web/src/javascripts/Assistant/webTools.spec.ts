import { WebApplication } from '@/Application/WebApplication'
import { WEB_FETCH_ROUTE, WEB_SEARCH_ROUTE, webFetch, webSearch } from './webTools'

const makeApplication = (response: unknown) => {
  const serverJsonRequest = jest.fn().mockResolvedValue(response)
  return { application: { serverJsonRequest } as unknown as WebApplication, serverJsonRequest }
}

describe('assistant web tools', () => {
  it.each([
    ['github', 'github.com'],
    ['gitlab', 'gitlab.com'],
    ['codeberg', 'codeberg.org'],
    ['bitbucket', 'bitbucket.org'],
    ['sourcehut', 'sr.ht'],
    ['npm', 'npmjs.com'],
    ['pypi', 'pypi.org'],
  ])('scopes %s discovery and excludes lookalike and unrelated hosts', async (site, domain) => {
    const { application, serverJsonRequest } = makeApplication({
      ok: true,
      status: 200,
      data: {
        results: [
          { title: 'Repo', url: `https://${domain}/owner/project`, snippet: 'readme' },
          { title: 'Wrong', url: `https://${domain}.evil.test/project`, snippet: '' },
          { title: 'Other', url: 'https://example.test/project', snippet: '' },
        ],
      },
    })
    await expect(webSearch(application, 'collaborative editor', { site, kind: 'repositories' })).resolves.toEqual({
      results: [{ title: 'Repo', url: `https://${domain}/owner/project`, snippet: 'readme' }],
    })
    expect(serverJsonRequest).toHaveBeenCalledWith(
      WEB_SEARCH_ROUTE,
      { query: `collaborative editor repositories site:${domain}`, limit: 10 },
      undefined,
    )
  })

  it('rejects invalid filters and over-budget expanded queries without network access', async () => {
    const { application, serverJsonRequest } = makeApplication({})
    for (const options of [{ site: '__proto__' }, { kind: 'private' }, { site: 'github' }]) {
      expect(await webSearch(application, 'x'.repeat(1000), options)).toHaveProperty('error')
    }
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })

  it('finds literal page text case-insensitively and bounds excerpts', async () => {
    const { application, serverJsonRequest } = makeApplication({
      ok: true,
      status: 200,
      data: {
        title: 'README',
        text: Array.from({ length: 12 }, () => `INSTALL${'.'.repeat(1200)}`).join(''),
      },
    })
    const result = await webFetch(application, 'https://github.com/example/repo', { find: 'install' })
    expect(result).toMatchObject({ title: 'README', matches: 12, truncated: true })
    expect('text' in result && result.text.length).toBeLessThan(9000)
    expect(serverJsonRequest).toHaveBeenCalledWith(
      WEB_FETCH_ROUTE,
      { url: 'https://github.com/example/repo' },
      undefined,
    )
    await expect(webFetch(application, 'https://github.com/example/repo', { find: 'absent' })).resolves.toMatchObject({
      text: '',
      matches: 0,
      truncated: false,
    })
  })

  it('rejects empty or excessive find text without fetching', async () => {
    const { application, serverJsonRequest } = makeApplication({})
    for (const find of [' ', 'x'.repeat(201)]) {
      expect(await webFetch(application, 'https://example.test', { find })).toHaveProperty('error')
    }
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })
  it('honors typed upstream throttling even when the gateway request succeeds', async () => {
    const search = makeApplication({
      ok: true,
      status: 200,
      data: { results: [], error: 'Upstream unavailable', rateLimited: true },
    })
    await expect(webSearch(search.application, 'research')).resolves.toMatchObject({ rateLimited: true })
    const fetch = makeApplication({ ok: true, status: 200, data: { status: 429, text: 'Rate limit page' } })
    await expect(webFetch(fetch.application, 'https://example.test')).resolves.toMatchObject({ rateLimited: true })
    const missing = makeApplication({ ok: true, status: 200, data: { status: 404, text: 'Missing page' } })
    expect(await webFetch(missing.application, 'https://example.test')).not.toHaveProperty('text')
  })
  it('marks HTTP 429 as rate-limited, not permission denied', async () => {
    const { application } = makeApplication({ ok: false, status: 429, data: {} })
    for (const response of [
      await webSearch(application, 'research'),
      await webFetch(application, 'https://example.test'),
    ]) {
      expect(response).toMatchObject({ rateLimited: true })
      expect(response).not.toHaveProperty('cancelled')
    }
  })
  it.each([401, 403])('marks HTTP %i as a terminal permission refusal for search and fetch', async (status) => {
    const { application } = makeApplication({ ok: false, status, data: { error: { message: 'Access denied.' } } })
    await expect(webSearch(application, 'research')).resolves.toMatchObject({
      cancelled: true,
      message: 'Access denied.',
    })
    await expect(webFetch(application, 'https://example.test')).resolves.toMatchObject({
      cancelled: true,
      message: 'Access denied.',
    })
  })

  it('treats a blocked host policy as denied while leaving ordinary HTTP 400 errors recoverable', async () => {
    const { application, serverJsonRequest } = makeApplication({
      ok: false,
      status: 400,
      data: { error: { tag: 'blocked-host', message: 'The requested host is not allowed.' } },
    })
    await expect(webFetch(application, 'https://example.test')).resolves.toMatchObject({ cancelled: true })
    serverJsonRequest.mockResolvedValue({
      ok: false,
      status: 400,
      data: { error: { tag: 'invalid-url', message: 'Invalid URL.' } },
    })
    await expect(webFetch(application, 'https://example.test')).resolves.toEqual({ error: 'Invalid URL.' })
  })
  it('blocks search and page reads before network access when the account setting disables internet', async () => {
    const { application, serverJsonRequest } = makeApplication({ ok: true, status: 200, data: {} })
    application.getPreference = jest.fn().mockReturnValue(false)
    await expect(webSearch(application, 'public research')).resolves.toEqual({
      error: expect.stringContaining('disabled in Assistant settings'),
      cancelled: true,
      message: expect.stringContaining('disabled in Assistant settings'),
    })
    await expect(webFetch(application, 'https://example.test')).resolves.toEqual({
      error: expect.stringContaining('disabled in Assistant settings'),
      cancelled: true,
      message: expect.stringContaining('disabled in Assistant settings'),
    })
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })
  it('returns safe normalized search results through the authenticated same-origin route', async () => {
    const { application, serverJsonRequest } = makeApplication({
      ok: true,
      status: 200,
      data: {
        results: [
          { title: '  Result\n title ', url: 'https://example.test/a', snippet: ' first\tresult ' },
          { title: 'unsafe', url: 'javascript:alert(1)', snippet: 'must not pass' },
          { title: 'credentials', url: 'https://secret@example.test/', snippet: 'must not pass' },
          { title: 'control', url: 'https://example.test/\nignored', snippet: 'must not pass' },
        ],
      },
    })

    await expect(webSearch(application, '  privacy research  ', { limit: 3 })).resolves.toEqual({
      results: [{ title: 'Result title', url: 'https://example.test/a', snippet: 'first result' }],
    })
    expect(serverJsonRequest).toHaveBeenCalledWith(WEB_SEARCH_ROUTE, { query: 'privacy research', limit: 3 }, undefined)
  })

  it('surfaces a configured-server error instead of misrepresenting it as no results', async () => {
    const { application } = makeApplication({
      ok: true,
      status: 200,
      data: { results: [], error: 'web search not configured' },
    })

    await expect(webSearch(application, 'latest notes')).resolves.toEqual({
      error: 'Web search is unavailable: web search not configured',
    })
  })

  it('surfaces an invalid successful response instead of silently producing an empty result set', async () => {
    const { application } = makeApplication({ ok: true, status: 200, data: { provider: 'unexpected' } })

    await expect(webSearch(application, 'latest notes')).resolves.toEqual({
      error: 'Web search returned an invalid response. Please try again later.',
    })
  })

  it('keeps a genuine zero-result response distinct from a search failure', async () => {
    const { application } = makeApplication({ ok: true, status: 200, data: { results: [] } })

    await expect(webSearch(application, 'obscure exact phrase')).resolves.toEqual({ results: [] })
  })

  it('rejects an oversized query locally and never sends it to the server', async () => {
    const { application, serverJsonRequest } = makeApplication({ ok: true, status: 200, data: { results: [] } })

    await expect(webSearch(application, 'q'.repeat(1_001))).resolves.toEqual({
      error: 'The search query must be 1,000 characters or fewer.',
    })
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })

  it('bounds model-provided result limits and the returned result count', async () => {
    const { application, serverJsonRequest } = makeApplication({
      ok: true,
      status: 200,
      data: {
        results: Array.from({ length: 30 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://example.test/${index}`,
          snippet: '',
        })),
      },
    })

    const result = await webSearch(application, 'bounded', { limit: Number.MAX_SAFE_INTEGER })

    expect('results' in result ? result.results : []).toHaveLength(20)
    expect(serverJsonRequest).toHaveBeenCalledWith(WEB_SEARCH_ROUTE, { query: 'bounded', limit: 20 }, undefined)
  })

  it('does not pass credential-bearing URLs to the server fetch proxy', async () => {
    const { application, serverJsonRequest } = makeApplication({ ok: true, status: 200, data: {} })

    await expect(webFetch(application, 'https://secret@example.test/private')).resolves.toEqual({
      error: 'The "url" must be an absolute http(s) URL without credentials.',
    })
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })

  it('uses the server fetch route only for a valid public web URL', async () => {
    const { application, serverJsonRequest } = makeApplication({
      ok: true,
      status: 200,
      data: { title: 'Page', text: 'Readable text' },
    })

    await expect(webFetch(application, 'https://example.test/read')).resolves.toEqual({
      title: 'Page',
      text: 'Readable text',
    })
    expect(serverJsonRequest).toHaveBeenCalledWith(WEB_FETCH_ROUTE, { url: 'https://example.test/read' }, undefined)
  })

  it('surfaces structured server fetch failures returned with a successful HTTP status', async () => {
    const { application } = makeApplication({
      ok: true,
      status: 200,
      data: { error: { tag: 'fetch-failed', message: 'upstream refused the request' } },
    })

    await expect(webFetch(application, 'https://example.test/read')).resolves.toEqual({
      error: 'Web fetch is unavailable: upstream refused the request',
    })
  })
})
