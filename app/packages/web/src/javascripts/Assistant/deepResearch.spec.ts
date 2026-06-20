import {
  DEFAULT_DEEP_RESEARCH_LIMITS,
  parseRefineDecision,
  ResearchNote,
  runDeepResearch,
} from './deepResearch'

const note = (uuid: string, title: string, text: string): ResearchNote => ({ uuid, title, text })

// A deterministic retrieve stub: returns the corpus in order, capped to `limit`,
// so tests don't depend on BM25 scoring details. Each note must contain the query
// term for the real retriever, but the stub sidesteps that.
const orderedRetrieve = (docs: { uuid: string; title: string; text: string }[], _query: string, limit: number) =>
  docs.slice(0, limit).map((d) => ({ noteUuid: d.uuid, noteTitle: d.title }))

describe('parseRefineDecision', () => {
  it('parses a request for more notes', () => {
    expect(parseRefineDecision('{"done": false, "more": [7, 8]}')).toEqual({ done: false, more: [7, 8] })
  })

  it('treats explicit done as finished', () => {
    expect(parseRefineDecision('{"done": true}')).toEqual({ done: true, more: [] })
  })

  it('treats an empty more list as finished', () => {
    expect(parseRefineDecision('{"done": false, "more": []}')).toEqual({ done: true, more: [] })
  })

  it('finishes on unparseable / chatty replies (never traps the loop)', () => {
    expect(parseRefineDecision('I think I have enough now.')).toEqual({ done: true, more: [] })
    expect(parseRefineDecision('')).toEqual({ done: true, more: [] })
  })

  it('drops non-integer / non-positive note numbers', () => {
    expect(parseRefineDecision('{"done": false, "more": [3, "x", -1, 0, 4]}')).toEqual({ done: false, more: [3, 4] })
  })
})

describe('runDeepResearch (bounded orchestration with mocked provider)', () => {
  const makeCorpus = (n: number): ResearchNote[] =>
    Array.from({ length: n }, (_, i) => note(`n${i}`, `Note ${i}`, `Body of note ${i} about the topic.`))

  it('returns a no-candidates report and never calls the provider for an empty question', async () => {
    const complete = jest.fn()
    const result = await runDeepResearch('   ', makeCorpus(5), complete, { retrieve: orderedRetrieve })
    expect(result.stopReason).toBe('no-candidates')
    expect(result.sources).toHaveLength(0)
    expect(complete).not.toHaveBeenCalled()
  })

  it('returns a no-candidates report when retrieval finds nothing', async () => {
    const complete = jest.fn()
    const result = await runDeepResearch('topic', makeCorpus(5), complete, {
      retrieve: () => [],
    })
    expect(result.stopReason).toBe('no-candidates')
    expect(complete).not.toHaveBeenCalled()
  })

  it('runs the happy path: reads notes, model finishes, returns a cited report', async () => {
    // First call is the refine decision (done immediately); second is synthesis.
    const complete = jest
      .fn()
      .mockResolvedValueOnce('{"done": true}')
      .mockResolvedValueOnce('## Summary\nFindings about the topic. [1][2]')
    const result = await runDeepResearch('topic', makeCorpus(10), complete, {
      retrieve: orderedRetrieve,
      limits: { initialNotes: 3 },
    })
    expect(result.stopReason).toBe('model-finished')
    expect(result.report).toContain('Summary')
    // Read the initial 3 notes; all are cited.
    expect(result.sources.map((s) => s.uuid)).toEqual(['n0', 'n1', 'n2'])
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('pulls in MORE notes when the model requests them, then synthesizes', async () => {
    // initialNotes=2 → reads n0,n1. Model requests candidate #3 (n2). Then done.
    const complete = jest
      .fn()
      .mockResolvedValueOnce('{"done": false, "more": [3]}') // round 1: read more
      .mockResolvedValueOnce('{"done": true}') // round 2: finished
      .mockResolvedValueOnce('synthesis') // synthesis
    const result = await runDeepResearch('topic', makeCorpus(10), complete, {
      retrieve: orderedRetrieve,
      limits: { initialNotes: 2, notesPerRound: 2 },
    })
    expect(result.sources.map((s) => s.uuid)).toEqual(['n0', 'n1', 'n2'])
  })

  it('respects the maxNotes cap regardless of how many the model requests', async () => {
    // Model always asks for the next 3 candidates; cap total notes at 5.
    const complete = jest.fn().mockImplementation((system: string) => {
      if (system.includes('research assistant working ONLY')) {
        return Promise.resolve('{"done": false, "more": [6, 7, 8, 9, 10]}')
      }
      return Promise.resolve('final report')
    })
    const result = await runDeepResearch('topic', makeCorpus(30), complete, {
      retrieve: orderedRetrieve,
      limits: { maxNotes: 5, initialNotes: 2, notesPerRound: 3, maxRounds: 5 },
    })
    expect(result.sources.length).toBeLessThanOrEqual(5)
  })

  it('respects the maxRounds cap and always terminates', async () => {
    // Model never says done and keeps requesting; loop must stop at maxRounds.
    let refineCalls = 0
    const complete = jest.fn().mockImplementation((system: string, user: string) => {
      if (system.includes('research assistant working ONLY')) {
        refineCalls++
        // Always request the first unread candidate (its absolute number varies;
        // request a high-but-valid number — fall back handled by the loop).
        return Promise.resolve(`{"done": false, "more": [${3 + refineCalls}]}`)
      }
      return Promise.resolve('report')
    })
    const result = await runDeepResearch('topic', makeCorpus(40), complete, {
      retrieve: orderedRetrieve,
      limits: { maxRounds: 3, maxNotes: 20, initialNotes: 2, notesPerRound: 1 },
    })
    expect(result.rounds).toBeLessThanOrEqual(3)
    // One synthesis call always happens at the end.
    expect(result.report).toBe('report')
  })

  it('clamps an out-of-bounds caller limit to the hard ceiling', async () => {
    const complete = jest.fn().mockResolvedValue('{"done": true}')
    // Ask for 999 rounds / 999 notes; must be clamped so it still terminates.
    const result = await runDeepResearch('topic', makeCorpus(3), complete, {
      retrieve: orderedRetrieve,
      limits: { maxRounds: 999, maxNotes: 999, initialNotes: 999 },
    })
    expect(result.sources.length).toBeLessThanOrEqual(3)
    expect(result.rounds).toBeLessThanOrEqual(5)
  })

  it('truncates source snippets (bounded exposure)', async () => {
    const complete = jest.fn().mockResolvedValueOnce('{"done": true}').mockResolvedValueOnce('report')
    const longBody = 'word '.repeat(500)
    const corpus = [note('n0', 'Long', longBody)]
    const result = await runDeepResearch('word', corpus, complete, { retrieve: orderedRetrieve })
    expect(result.sources[0].snippet.length).toBeLessThanOrEqual(201)
  })

  it('stops early with no-new-notes when the corpus is smaller than the read budget', async () => {
    const complete = jest.fn().mockResolvedValueOnce('report')
    const result = await runDeepResearch('topic', makeCorpus(2), complete, {
      retrieve: orderedRetrieve,
      limits: { initialNotes: 5, maxNotes: 5 },
    })
    // Both notes read; no unread candidates → goes straight to synthesis.
    expect(result.stopReason).toBe('no-new-notes')
    expect(result.sources.map((s) => s.uuid)).toEqual(['n0', 'n1'])
    // Only the synthesis call (no refine round needed).
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('honors an abort signal before synthesis', async () => {
    const controller = new AbortController()
    const complete = jest.fn().mockImplementation(() => {
      controller.abort()
      return Promise.resolve('{"done": false, "more": [4]}')
    })
    const result = await runDeepResearch('topic', makeCorpus(10), complete, {
      retrieve: orderedRetrieve,
      signal: controller.signal,
      limits: { initialNotes: 2 },
    })
    expect(result.stopReason).toBe('aborted')
  })

  it('exposes sane default limits', () => {
    expect(DEFAULT_DEEP_RESEARCH_LIMITS.maxRounds).toBeLessThanOrEqual(5)
    expect(DEFAULT_DEEP_RESEARCH_LIMITS.maxNotes).toBeLessThanOrEqual(20)
  })
})
