import {
  applyAiOrdering,
  buildRerankPrompt,
  DEFAULT_AI_RERANK_CANDIDATE_LIMIT,
  parseRerankResponse,
  RerankCandidate,
  rerankCandidates,
  selectCandidates,
} from './contextualSearchRanking'

const candidate = (uuid: string, title = uuid, text = ''): RerankCandidate => ({ uuid, title, text })

describe('contextual search ranking (pure)', () => {
  describe('selectCandidates (bounding exposure)', () => {
    it('caps the number of candidates to the default limit', () => {
      const items = Array.from({ length: 50 }, (_, i) => candidate(`n${i}`))
      const bounded = selectCandidates(items)
      expect(bounded.length).toBe(DEFAULT_AI_RERANK_CANDIDATE_LIMIT)
      // Preserves incoming (algorithmic) order.
      expect(bounded[0].uuid).toBe('n0')
      expect(bounded[DEFAULT_AI_RERANK_CANDIDATE_LIMIT - 1].uuid).toBe(`n${DEFAULT_AI_RERANK_CANDIDATE_LIMIT - 1}`)
    })

    it('honors an explicit smaller limit', () => {
      const items = Array.from({ length: 10 }, (_, i) => candidate(`n${i}`))
      expect(selectCandidates(items, { limit: 3 }).map((c) => c.uuid)).toEqual(['n0', 'n1', 'n2'])
    })

    it('truncates each snippet to the configured length and collapses whitespace', () => {
      const longBody = 'word '.repeat(200)
      const [bounded] = selectCandidates([candidate('n1', 'Title', longBody)], { snippetChars: 20 })
      expect(bounded.text.length).toBeLessThanOrEqual(21) // 20 + ellipsis
      expect(bounded.text.endsWith('…')).toBe(true)
      expect(bounded.text).not.toMatch(/\s{2,}/)
    })
  })

  describe('buildRerankPrompt', () => {
    it('numbers candidates 1..N and includes the query', () => {
      const prompt = buildRerankPrompt('budget', [candidate('a', 'Alpha', 'aa'), candidate('b', 'Beta', 'bb')])
      expect(prompt).toContain('Query: budget')
      expect(prompt).toContain('1. Alpha — aa')
      expect(prompt).toContain('2. Beta — bb')
    })

    it('labels empty titles as Untitled note', () => {
      expect(buildRerankPrompt('q', [candidate('a', '')])).toContain('1. Untitled note')
    })
  })

  describe('parseRerankResponse', () => {
    const candidates = [candidate('a'), candidate('b'), candidate('c')]

    it('parses a JSON array of 1-based indices into a uuid ordering', () => {
      expect(parseRerankResponse('[3,1,2]', candidates)).toEqual(['c', 'a', 'b'])
    })

    it('appends omitted candidates in their original order (stable, complete)', () => {
      // Model only ranked candidate 2; a and c are appended in original order.
      expect(parseRerankResponse('[2]', candidates)).toEqual(['b', 'a', 'c'])
    })

    it('ignores out-of-range and duplicate indices', () => {
      expect(parseRerankResponse('[9, 2, 2, 0, 1]', candidates)).toEqual(['b', 'a', 'c'])
    })

    it('tolerates loosely formatted numeric replies', () => {
      expect(parseRerankResponse('Order: 3 then 1 then 2', candidates)).toEqual(['c', 'a', 'b'])
    })

    it('returns null when nothing usable is present', () => {
      expect(parseRerankResponse('no numbers here', candidates)).toBeNull()
      expect(parseRerankResponse('', candidates)).toBeNull()
    })
  })

  describe('applyAiOrdering (applying the order to the list)', () => {
    type Item = { uuid: string; tag: string }
    const items: Item[] = [
      { uuid: 'a', tag: 'A' },
      { uuid: 'b', tag: 'B' },
      { uuid: 'c', tag: 'C' },
      { uuid: 'd', tag: 'D' },
    ]

    it('reorders listed items first, keeping the rest stable after them', () => {
      const result = applyAiOrdering(items, ['c', 'a'])
      expect(result.map((i) => i.uuid)).toEqual(['c', 'a', 'b', 'd'])
    })

    it('is a no-op (returns input unchanged) when there is no ordering — default-off path', () => {
      expect(applyAiOrdering(items, null)).toBe(items)
      expect(applyAiOrdering(items, [])).toBe(items)
    })

    it('does not mutate the input array', () => {
      const copy = [...items]
      applyAiOrdering(items, ['d', 'c', 'b', 'a'])
      expect(items).toEqual(copy)
    })
  })

  describe('rerankCandidates (orchestration with injected provider)', () => {
    const candidates = [candidate('a', 'Alpha'), candidate('b', 'Beta'), candidate('c', 'Gamma')]

    it('calls the provider once and returns the parsed ordering', async () => {
      const complete = jest.fn().mockResolvedValue('[2,3,1]')
      const result = await rerankCandidates('q', candidates, complete)
      expect(complete).toHaveBeenCalledTimes(1)
      expect(result?.orderedUuids).toEqual(['b', 'c', 'a'])
    })

    it('passes the system prompt and a bounded user prompt to the provider', async () => {
      const complete = jest.fn().mockResolvedValue('[1,2,3]')
      await rerankCandidates('budget review', candidates, complete, { limit: 2 })
      const [system, user] = complete.mock.calls[0]
      expect(system).toMatch(/re-ranking/i)
      expect(user).toContain('Query: budget review')
      // Only 2 candidates sent (bounded); 'Gamma' must not be in the prompt.
      expect(user).toContain('Alpha')
      expect(user).toContain('Beta')
      expect(user).not.toContain('Gamma')
    })

    it('does not call the provider for an empty query', async () => {
      const complete = jest.fn()
      expect(await rerankCandidates('   ', candidates, complete)).toBeNull()
      expect(complete).not.toHaveBeenCalled()
    })

    it('does not call the provider when there are fewer than two candidates', async () => {
      const complete = jest.fn()
      expect(await rerankCandidates('q', [candidate('a')], complete)).toBeNull()
      expect(complete).not.toHaveBeenCalled()
    })

    it('returns null (keep algorithmic order) when the reply is unparseable', async () => {
      const complete = jest.fn().mockResolvedValue('sorry, I cannot')
      expect(await rerankCandidates('q', candidates, complete)).toBeNull()
    })
  })
})
