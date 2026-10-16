import { OllamaProvider } from './ollama'
import { ProviderEvent } from './types'
const request = { system: 's', messages: [{ role: 'user' as const, content: 'hello' }], tools: [] }
const previousFetch = global.fetch
afterEach(() => {
  global.fetch = previousFetch
})
it.each([true, false])('forwards Ollama final actual counts, newline terminated=%s', async (newline) => {
  const payload = JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 3 }) + (newline ? '\n' : '')
  global.fetch = jest.fn().mockResolvedValue(new Response(payload))
  const events: ProviderEvent[] = []
  for await (const event of new OllamaProvider('m').send(request)) {
    events.push(event)
  }
  expect(events).toEqual([
    { kind: 'usage', promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    { kind: 'finish', stopReason: 'end_turn' },
  ])
})
it.each([{}, { prompt_eval_count: -1, eval_count: '3' }, { prompt_eval_count: 1.5, eval_count: NaN }])(
  'does not invent absent or malformed counts %j',
  async (counts) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ done: true, ...counts }) + '\n'))
    const events: ProviderEvent[] = []
    for await (const event of new OllamaProvider('m').send(request)) {
      events.push(event)
    }
    expect(events).toEqual([{ kind: 'finish', stopReason: 'end_turn' }])
  },
)
