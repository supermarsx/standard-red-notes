import {
  accumulateChatTokenUsage,
  EMPTY_CHAT_TOKEN_USAGE,
  normalizeCallTokenUsage,
  observeProviderTokenUsage,
} from './usageMeterProvider'
import type { Provider, ProviderEvent } from './types'

const request = { system: '', messages: [], tools: [] }
const provider = (events: ProviderEvent[]): Provider => ({
  id: 'test',
  async *send() {
    yield* events
  },
})

it('counts cumulative usage once per model call and preserves the stream', async () => {
  const events: ProviderEvent[] = [
    { kind: 'usage', promptTokens: 10, completionTokens: 1 },
    { kind: 'usage', promptTokens: 10, completionTokens: 5, contextWindowTokens: 100 },
    { kind: 'finish', stopReason: 'end_turn' },
  ]
  const report = jest.fn()
  const measured = observeProviderTokenUsage(provider(events), report)
  const seen = []
  for await (const event of measured.send(request)) seen.push(event)
  expect(seen).toEqual(events)
  expect(report).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledWith({ input: 10, output: 5, contextLimit: 100 })
})

it('does not turn missing, invalid or fractional counts into zero or a guessed model window', () => {
  expect(
    normalizeCallTokenUsage({ kind: 'usage', promptTokens: NaN, completionTokens: -2, contextWindowTokens: Infinity }),
  ).toEqual({ input: undefined, output: undefined, contextLimit: undefined })
  expect(normalizeCallTokenUsage({ kind: 'usage', promptTokens: 1.5, contextWindowTokens: 0 }).input).toBeUndefined()
  expect(normalizeCallTokenUsage({ kind: 'usage', promptTokens: 0, completionTokens: 0 })).toMatchObject({
    input: 0,
    output: 0,
  })
})

it('keeps reported chat totals while marking the latest missing report unknown', () => {
  let usage = accumulateChatTokenUsage(EMPTY_CHAT_TOKEN_USAGE, { input: 100, output: 20 })
  usage = accumulateChatTokenUsage(usage, { input: 30 })
  usage = accumulateChatTokenUsage(usage, {})
  expect(usage).toEqual({ calls: 3, reportedCalls: 2, input: 130, output: 20, last: {} })
})

it('does not let usage UI errors change provider success or cancellation', async () => {
  const signal = new AbortController().signal
  const send = jest.fn(async function* () {
    yield { kind: 'finish', stopReason: 'end_turn' } as const
  })
  const measured = observeProviderTokenUsage({ id: 'test', send }, () => {
    throw new Error('UI failed')
  })
  for await (const _event of measured.send({ ...request, signal })) {
    /* consume */
  }
  expect(send).toHaveBeenCalledWith({ ...request, signal })
})

it('reports usage already observed when the consumer closes an interrupted stream', async () => {
  const report = jest.fn()
  const measured = observeProviderTokenUsage(provider([{ kind: 'usage', promptTokens: 50 }]), report)
  for await (const _event of measured.send(request)) break
  expect(report).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledWith({ input: 50, output: undefined, contextLimit: undefined })
})
