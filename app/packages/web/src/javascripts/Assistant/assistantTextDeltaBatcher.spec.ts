import { createAssistantTextDeltaBatcher } from './assistantTextDeltaBatcher'

describe('assistant text delta batcher', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('coalesces a large stream into bounded UI updates', () => {
    const writes: string[] = []
    const batcher = createAssistantTextDeltaBatcher((text) => writes.push(text), 40)
    for (let index = 0; index < 1_000; index += 1) {
      batcher.push('x')
    }
    expect(writes).toHaveLength(0)
    jest.advanceTimersByTime(40)
    expect(writes).toEqual(['x'.repeat(1_000)])
  })

  it('flushes terminal text immediately and discards disposed text', () => {
    const writes: string[] = []
    const batcher = createAssistantTextDeltaBatcher((text) => writes.push(text))
    batcher.push('done')
    batcher.flush()
    batcher.push('discard')
    batcher.dispose()
    jest.runAllTimers()
    expect(writes).toEqual(['done'])
  })
})
