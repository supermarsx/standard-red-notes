import { confirmDialog } from '@standardnotes/ui-services'
import type { WebApplication } from '@/Application/WebApplication'
import { gatherResearchWebEvidence } from './researchWebEvidence'

jest.mock('@standardnotes/ui-services', () => ({ confirmDialog: jest.fn() }))

it('uses authenticated server routes only after actual approval and preserves the abort signal', async () => {
  jest.mocked(confirmDialog).mockResolvedValue(true)
  const controller = new AbortController()
  const serverJsonRequest = jest.fn(async (route: string) => {
    expect(confirmDialog).toHaveBeenCalledTimes(route.endsWith('/search') ? 1 : 2)
    return {
      ok: true,
      status: 200,
      data: route.endsWith('/search')
        ? { results: [{ title: 'Official', url: 'https://example.com/page', snippet: 'Snippet' }] }
        : { title: 'Official page', text: 'Actual retrieved text' },
    }
  })
  const application = {
    serverJsonRequest,
    getPreference: (key: string, fallback: unknown) => (key === 'assistantWebAccessMode' ? 'strict' : fallback),
  } as unknown as WebApplication
  const evidence = await gatherResearchWebEvidence(application, 'public topic', {
    isCurrent: () => true,
    signal: controller.signal,
  })
  expect(serverJsonRequest.mock.calls).toEqual([
    ['/v1/web/search', { query: 'public topic', limit: 3 }, controller.signal],
    ['/v1/web/fetch', { url: 'https://example.com/page' }, controller.signal],
  ])
  expect(confirmDialog).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ text: expect.stringContaining('Search query: public topic') }),
  )
  expect(confirmDialog).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ text: expect.stringContaining('Page URL: https://example.com/page') }),
  )
  expect(evidence.sources).toEqual([
    { title: 'Official page', url: 'https://example.com/page', text: 'Actual retrieved text' },
  ])
})
