import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from './anthropic'
import { ProviderEvent } from './types'
jest.mock('@anthropic-ai/sdk')
const stream = jest.fn()
const request = { system: 's', messages: [{ role: 'user' as const, content: 'hello' }], tools: [] }
it.each([
  [{ input_tokens: 12, output_tokens: 3 }, 12, 3],
  [{ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 }, 72, 3],
  [{ input_tokens: 0, output_tokens: 0 }, 0, 0],
])('forwards actual final Anthropic input/output usage before finish', async (usage, input, output) => {
  ;(Anthropic as unknown as jest.Mock).mockImplementation(() => ({ messages: { stream } }))
  stream.mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_stop' }
    },
    finalMessage: async () => ({ stop_reason: 'end_turn', usage }),
  })
  const events: ProviderEvent[] = []
  for await (const event of new AnthropicProvider('m', 'key').send(request)) {
    events.push(event)
  }
  expect(events).toEqual([
    { kind: 'usage', promptTokens: input, completionTokens: output, totalTokens: input + output },
    { kind: 'finish', stopReason: 'end_turn' },
  ])
})
