import { WebApplication } from '@/Application/WebApplication'
import { WEB_FETCH_ROUTE, WEB_SEARCH_ROUTE, webFetch, webSearch } from './webTools'

const makeApplication = (response: unknown) => {
  const serverJsonRequest = jest.fn().mockResolvedValue(response)
  return { application: { serverJsonRequest } as unknown as WebApplication, serverJsonRequest }
}

describe('assistant web tools', () => {
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
