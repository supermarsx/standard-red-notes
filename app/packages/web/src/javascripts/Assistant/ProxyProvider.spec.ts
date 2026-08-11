import { TextDecoder as NodeTextDecoder } from 'node:util'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { ProxyProvider } from './ProxyProvider'
import { buildAssistantProvider } from './selectionActions'
import { Provider, ProviderEvent, ProviderRequest } from './types'

const request: ProviderRequest = {
  system: 'system',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
}

const collect = async (provider: Provider): Promise<ProviderEvent[]> => {
  const events: ProviderEvent[] = []
  for await (const event of provider.send(request)) {
    events.push(event)
  }
  return events
}

describe('ProxyProvider automatic profile routing', () => {
  it('omits empty provider/model so the server can resolve the assigned/default profile', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    let submitted: unknown
    const frame = 'data: {"kind":"finish","stopReason":"end_turn"}\n\n'
    const bytes = Uint8Array.from([...frame].map((character) => character.charCodeAt(0)))
    let reads = 0
    const postStream = jest.fn(async (body: unknown) => {
      submitted = body
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({
            read: async () => (reads++ === 0 ? { done: false, value: bytes } : { done: true, value: undefined }),
          }),
        },
      } as unknown as Response
    })

    const events = await collect(new ProxyProvider({ provider: '', model: '', postStream }))

    expect(submitted).not.toHaveProperty('provider')
    expect(submitted).not.toHaveProperty('model')
    expect(events).toContainEqual({ kind: 'finish', stopReason: 'end_turn' })
  })

  it('does not send stale Direct-mode provider/model preferences in proxy mode', async () => {
    ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
    let submitted: unknown
    const application = {
      getPreference: (key: PrefKey, defaultValue?: unknown) => {
        const prefs: Partial<Record<PrefKey, unknown>> = {
          [PrefKey.AssistantConnectionMode]: 'proxy',
          [PrefKey.AssistantProvider]: 'openai',
          [PrefKey.AssistantModel]: 'stale-direct-model',
        }
        return prefs[key] ?? defaultValue
      },
      assistantStreamRequest: async (_path: string, body: unknown) => {
        submitted = body
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'text/event-stream' },
          body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
        } as unknown as Response
      },
    } as unknown as WebApplication

    await collect(buildAssistantProvider(application))

    expect(submitted).not.toHaveProperty('provider')
    expect(submitted).not.toHaveProperty('model')
  })
})
