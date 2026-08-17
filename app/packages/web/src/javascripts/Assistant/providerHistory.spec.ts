import { boundProviderHistory, providerHistoryCharacterCost } from './providerHistory'
import { ChatMessage } from './types'

describe('boundProviderHistory', () => {
  it('keeps a contiguous suffix of the newest complete turns', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: `old request ${'x'.repeat(300)}` },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
    ]

    expect(boundProviderHistory(history, 140)).toEqual([
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
    ])
  })

  it('truncates an oversized newest turn without exceeding the exact budget', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: `important beginning ${'x'.repeat(1_000)} important ending` },
      { role: 'assistant', content: `answer beginning ${'y'.repeat(1_000)} answer ending` },
    ]

    const bounded = boundProviderHistory(history, 300)
    expect(bounded.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(providerHistoryCharacterCost(bounded)).toBeLessThanOrEqual(300)
    expect(bounded.some((message) => message.content.includes('truncated'))).toBe(true)
  })

  it('drops live protocol records and never mutates the input', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'not persisted history' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: 'working',
        toolCalls: [{ id: 'call-1', name: 'notes.read', args: { uuid: 'note-1' } }],
      },
      { role: 'tool', content: 'secret tool result', toolCallId: 'call-1', name: 'notes.read' },
    ]
    const snapshot = JSON.stringify(history)

    expect(boundProviderHistory(history, 1_000)).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'working' },
    ])
    expect(JSON.stringify(history)).toBe(snapshot)
  })

  it('fails closed for invalid or zero budgets', () => {
    expect(boundProviderHistory([{ role: 'user', content: 'hello' }], 0)).toEqual([])
    expect(boundProviderHistory([{ role: 'user', content: 'hello' }], Number.NaN)).toEqual([])
  })
})
