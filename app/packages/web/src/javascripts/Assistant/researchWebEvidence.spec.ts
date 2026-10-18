import type { WebApplication } from '@/Application/WebApplication'
import { gatherResearchWebEvidence, researchWebSourcesMarkdown } from './researchWebEvidence'
import { webFetch, webSearch } from './webTools'

jest.mock('./webTools', () => ({ ...jest.requireActual('./webTools'), webSearch: jest.fn(), webFetch: jest.fn() }))
const search = jest.mocked(webSearch)
const fetchPage = jest.mocked(webFetch)
const application = {
  getPreference: (key: string, fallback: unknown) => (key === 'assistantWebAccessMode' ? 'strict' : fallback),
} as WebApplication
const result = (n: number) => ({ title: `Page ${n}`, url: `https://example.com/${n}`, snippet: 'Search snippet' })

beforeEach(() => {
  jest.clearAllMocks()
  search.mockResolvedValue({ results: [result(1), result(2), result(3), result(4)] })
  fetchPage.mockResolvedValue({ title: 'Fetched page', text: 'Actual page evidence' })
})

it('stops further page requests on rate limiting while retaining already retrieved sources', async () => {
  fetchPage
    .mockResolvedValueOnce({ title: 'First', text: 'Evidence' })
    .mockResolvedValueOnce({ error: 'Rate limited', rateLimited: true })
  const onToolResult = jest.fn()
  const evidence = await gatherResearchWebEvidence(application, 'topic', {
    isCurrent: () => true,
    requestConfirmation: async () => true,
    onToolResult,
  })
  expect(fetchPage).toHaveBeenCalledTimes(2)
  expect(evidence).toMatchObject({ status: 'unavailable', rateLimited: true })
  expect(evidence.sources).toHaveLength(1)
  expect(onToolResult).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'failed')
})

it('approves exactly one topic query and at most three pages before server dispatch', async () => {
  const approve = jest.fn(async () => true)
  search.mockImplementation(async () => {
    expect(approve).toHaveBeenLastCalledWith('search', 'topic')
    return { results: [result(1), result(2), result(3), result(4)] }
  })
  fetchPage.mockImplementation(async (_app, url) => {
    expect(approve).toHaveBeenLastCalledWith('fetch', url)
    return { title: 'Fetched', text: 'x'.repeat(15000) }
  })
  const evidence = await gatherResearchWebEvidence(application, ' topic ', {
    isCurrent: () => true,
    requestConfirmation: approve,
  })
  expect(search).toHaveBeenCalledWith(application, 'topic', { limit: 3, signal: undefined })
  expect(fetchPage).toHaveBeenCalledTimes(3)
  expect(evidence.status).toBe('retrieved')
  expect(evidence.sources).toHaveLength(3)
  expect(evidence.sources[0].text).toHaveLength(12000)
  expect(researchWebSourcesMarkdown(evidence)).toContain('[W1] [Fetched](<https://example.com/1>)')
})

it('does not dispatch a declined query or URL', async () => {
  await expect(
    gatherResearchWebEvidence(application, 'topic', {
      isCurrent: () => true,
      requestConfirmation: async () => false,
    }),
  ).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_NOT_ALLOWED' })
  expect(search).not.toHaveBeenCalled()
  await expect(
    gatherResearchWebEvidence(application, 'topic', {
      isCurrent: () => true,
      requestConfirmation: async (action) => action === 'search',
    }),
  ).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_NOT_ALLOWED' })
  expect(fetchPage).not.toHaveBeenCalled()
})

it.each(['search', 'fetch'])('stops when the server denies the %s request', async (action) => {
  const denied = {
    error: 'Server policy denied access.',
    message: 'Server policy denied access.',
    cancelled: true as const,
  }
  if (action === 'search') {
    search.mockResolvedValue(denied)
  } else {
    fetchPage.mockResolvedValue(denied)
  }
  await expect(
    gatherResearchWebEvidence(application, 'topic', {
      isCurrent: () => true,
      requestConfirmation: async () => true,
    }),
  ).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_NOT_ALLOWED', message: 'Server policy denied access.' })
  expect(fetchPage).toHaveBeenCalledTimes(action === 'search' ? 0 : 1)
})

it('stops after account changes during approval, before any request', async () => {
  let current = true
  await expect(
    gatherResearchWebEvidence(application, 'private topic', {
      isCurrent: () => current,
      requestConfirmation: async () => {
        current = false
        return true
      },
    }),
  ).rejects.toThrow('active account changed')
  expect(search).not.toHaveBeenCalled()
})

it('stops after cancellation during search without fetching pages', async () => {
  const controller = new AbortController()
  search.mockImplementation(async () => {
    controller.abort()
    return { results: [result(1)] }
  })
  await expect(
    gatherResearchWebEvidence(application, 'topic', {
      signal: controller.signal,
      isCurrent: () => true,
      requestConfirmation: async () => true,
    }),
  ).rejects.toThrow('cancelled')
  expect(fetchPage).not.toHaveBeenCalled()
})

it('reports unavailable web access honestly without inventing retrieved sources', async () => {
  search.mockResolvedValue({ error: 'Unavailable' })
  const evidence = await gatherResearchWebEvidence(application, 'topic', {
    isCurrent: () => true,
    requestConfirmation: async () => true,
  })
  expect(evidence).toEqual({ status: 'unavailable', sources: [] })
  expect(researchWebSourcesMarkdown(evidence)).toContain('not based on live web evidence')
  expect(fetchPage).not.toHaveBeenCalled()
})

it('deduplicates returned URLs and records only successfully retrieved pages', async () => {
  search.mockResolvedValue({ results: [result(1), result(1), result(2)] })
  fetchPage.mockResolvedValueOnce({ error: 'failed' }).mockResolvedValueOnce({ title: 'Read', text: 'Evidence' })
  const evidence = await gatherResearchWebEvidence(application, 'topic', {
    isCurrent: () => true,
    requestConfirmation: async () => true,
  })
  expect(fetchPage).toHaveBeenCalledTimes(2)
  expect(evidence.sources.map((source) => source.url)).toEqual(['https://example.com/2'])
})

it.each(['allow', 'safe'])('uses %s web policy for research with explicit denials still enforced', async (mode) => {
  const app = {
    getPreference: (key: string, fallback: unknown) => (key === 'assistantWebAccessMode' ? mode : fallback),
  } as WebApplication
  const requestConfirmation = jest.fn(async () => true)
  await gatherResearchWebEvidence(app, 'topic', { isCurrent: () => true, requestConfirmation })
  expect(requestConfirmation).toHaveBeenCalledTimes(mode === 'safe' ? 1 : 0)
  await expect(
    gatherResearchWebEvidence(app, 'topic', {
      isCurrent: () => true,
      requestConfirmation,
      isWebToolDenied: () => true,
    }),
  ).rejects.toMatchObject({ code: 'ASSISTANT_ACTION_NOT_ALLOWED' })
})

it('reports each actual web request as a correlated tool activity and skips duplicates', async () => {
  const onToolCall = jest.fn()
  const onToolResult = jest.fn()
  await gatherResearchWebEvidence(application, 'topic', {
    isCurrent: () => true,
    requestConfirmation: async () => true,
    excludeUrls: new Set([result(1).url]),
    onToolCall,
    onToolResult,
  })
  expect(onToolCall.mock.calls.map(([call]) => call.name)).toEqual(['web.search', 'web.fetch', 'web.fetch'])
  expect(onToolResult.mock.calls.map(([id, , outcome]) => [id, outcome])).toEqual(
    onToolCall.mock.calls.map(([call]) => [call.id, 'succeeded']),
  )
  expect(new Set(onToolCall.mock.calls.map(([call]) => call.id)).size).toBe(3)
})
