import { accumulateUsage, EMPTY_USAGE } from './AssistantUsageService'

describe('accumulateUsage', () => {
  it('folds prompt/completion/total tokens and counts the request', () => {
    const result = accumulateUsage(EMPTY_USAGE, { promptTokens: 100, completionTokens: 40, totalTokens: 140 })
    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      requests: 1,
      requestsWithTokens: 1,
    })
  })

  it('derives total from prompt + completion when no total is reported', () => {
    const result = accumulateUsage(EMPTY_USAGE, { promptTokens: 30, completionTokens: 12 })
    expect(result.totalTokens).toBe(42)
    expect(result.requestsWithTokens).toBe(1)
  })

  it('prefers an explicit provider total over the derived sum', () => {
    const result = accumulateUsage(EMPTY_USAGE, { promptTokens: 30, completionTokens: 12, totalTokens: 99 })
    expect(result.totalTokens).toBe(99)
  })

  it('counts a request with no token usage but does not bump requestsWithTokens', () => {
    const result = accumulateUsage(EMPTY_USAGE, {})
    expect(result.requests).toBe(1)
    expect(result.requestsWithTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
  })

  it('accumulates across multiple reports', () => {
    let usage = EMPTY_USAGE
    usage = accumulateUsage(usage, { promptTokens: 10, completionTokens: 5 })
    usage = accumulateUsage(usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 })
    usage = accumulateUsage(usage, {})
    expect(usage).toEqual({
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
      requests: 3,
      requestsWithTokens: 2,
    })
  })

  it('ignores negative / non-finite values defensively', () => {
    const result = accumulateUsage(EMPTY_USAGE, {
      promptTokens: -5,
      completionTokens: Number.NaN,
      totalTokens: Number.POSITIVE_INFINITY,
    })
    expect(result.promptTokens).toBe(0)
    expect(result.completionTokens).toBe(0)
    expect(result.totalTokens).toBe(0)
    expect(result.requestsWithTokens).toBe(0)
  })

  it('does not mutate the input usage object', () => {
    const start = { ...EMPTY_USAGE }
    accumulateUsage(start, { promptTokens: 1, completionTokens: 1 })
    expect(start).toEqual(EMPTY_USAGE)
  })
})
