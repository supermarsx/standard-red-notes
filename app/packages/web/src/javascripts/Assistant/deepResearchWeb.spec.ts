import { runDeepWebResearch } from './deepResearchWeb'
import { normalizeDeepResearchWebLimits } from './deepResearchSettings'

const sources = (offset: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    title: `Source ${offset + i}`,
    url: `https://source.example/${offset + i}`,
    text: 'Evidence '.repeat(1000),
  }))

it('collects up to 600 unique sources in staged batches with bounded model context', async () => {
  let offset = 0
  let plans = 0
  const gather = jest.fn(async (_query, options) => {
    expect(options.maxSources).toBeLessThanOrEqual(10)
    const batch = sources(offset, options.maxSources)
    offset += batch.length
    return { sources: batch, status: 'retrieved' as const }
  })
  const complete = jest.fn(async (system, user) => {
    expect(user.length).toBeLessThan(100000)
    return system.startsWith('Plan') ? JSON.stringify({ query: `followup ${++plans}` }) : 'Evidence digest [W1]'
  })
  const result = await runDeepWebResearch('topic', { gather, complete }, { limits: { maxSources: 9999 } })
  expect(result.evidence.sources).toHaveLength(600)
  expect(result.stopReason).toBe('source-limit')
  expect(gather).toHaveBeenCalledTimes(60)
  expect(result.evidence.sources.every((source) => source.text === '')).toBe(true)
})

it('deduplicates canonical URLs and stops early when evidence is sufficient', async () => {
  const gather = jest.fn().mockResolvedValue({
    sources: [
      { ...sources(0, 1)[0], url: 'https://source.example/0#a' },
      { ...sources(0, 1)[0], url: 'https://source.example/0#b' },
    ],
    status: 'retrieved',
  })
  const complete = jest.fn().mockResolvedValueOnce('Digest [W1]').mockResolvedValueOnce('{"done":true}')
  const result = await runDeepWebResearch('topic', { gather, complete })
  expect(result.evidence.sources).toHaveLength(1)
  expect(result.stopReason).toBe('sufficient-evidence')
  expect(result.rounds).toBe(1)
})

it('returns a truthful partial digest at the time budget without starting another model call', async () => {
  let now = 0
  const complete = jest.fn(async () => {
    now = 60001
    return 'Partial digest [W1]'
  })
  const result = await runDeepWebResearch(
    'topic',
    { gather: async () => ({ sources: sources(0, 1), status: 'retrieved' }), complete },
    { limits: { timeBudgetMinutes: 1 }, now: () => now },
  )
  expect(result.stopReason).toBe('time-limit')
  expect(result.summary).toBe('Partial digest [W1]')
  expect(complete).toHaveBeenCalledTimes(1)
})

it('cancels a stalled dependency even if it ignores its abort signal', async () => {
  const controller = new AbortController()
  const complete = jest.fn()
  const pending = runDeepWebResearch(
    'topic',
    { gather: () => new Promise(() => undefined), complete },
    { signal: controller.signal },
  )
  controller.abort()
  await expect(pending).resolves.toMatchObject({ stopReason: 'aborted', rounds: 1 })
  expect(complete).not.toHaveBeenCalled()
})

it('permits over one hour but keeps strict source and duration ceilings', () => {
  expect(normalizeDeepResearchWebLimits()).toEqual({ maxSources: 600, timeBudgetMinutes: 90 })
  expect(normalizeDeepResearchWebLimits({ maxSources: Infinity, timeBudgetMinutes: 500 })).toEqual({
    maxSources: 600,
    timeBudgetMinutes: 120,
  })
})

it('does not plan another search round after a rate-limited page batch', async () => {
  const gather = jest.fn().mockResolvedValue({ sources: sources(0, 1), status: 'unavailable', rateLimited: true })
  const complete = jest.fn().mockResolvedValue('Digest [W1]')
  const result = await runDeepWebResearch('topic', { gather, complete })
  expect(result.stopReason).toBe('rate-limited')
  expect(gather).toHaveBeenCalledTimes(1)
  expect(complete).toHaveBeenCalledTimes(1)
})
