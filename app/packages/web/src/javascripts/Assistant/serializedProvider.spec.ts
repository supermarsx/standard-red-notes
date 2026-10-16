import { serializeAssistantProvider } from './serializedProvider'
import { Provider, ProviderRequest } from './types'
const request: ProviderRequest = { system: '', messages: [], tools: [] }
it('serializes concurrent delegates under one shared proof', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0,
    max = 0,
    started = 0
  const provider: Provider = {
    id: 'test',
    async *send() {
      started++
      active++
      max = Math.max(max, active)
      try {
        if (started === 1) await wait
        yield { kind: 'finish', stopReason: 'end_turn' }
      } finally {
        active--
      }
    },
  }
  const serial = serializeAssistantProvider(provider)
  const consume = async () => {
    for await (const _event of serial.send(request)) {
      /* drain */
    }
  }
  const one = consume(),
    two = consume()
  await Promise.resolve()
  await Promise.resolve()
  expect(started).toBe(1)
  release()
  await Promise.all([one, two])
  expect(max).toBe(1)
  expect(started).toBe(2)
})
it('cancels a queued delegate without letting a following request overlap its predecessor', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = 0
  const serial = serializeAssistantProvider({
    id: 'test',
    async *send() {
      started++
      if (started === 1) await wait
      yield { kind: 'finish', stopReason: 'end_turn' }
    },
  })
  const consume = async (signal?: AbortSignal) => {
    for await (const _event of serial.send({ ...request, signal })) {
      /* drain */
    }
  }
  const one = consume()
  const controller = new AbortController()
  const two = consume(controller.signal)
  controller.abort()
  await expect(two).rejects.toBeDefined()
  const three = consume()
  await Promise.resolve()
  expect(started).toBe(1)
  release()
  await Promise.all([one, three])
  expect(started).toBe(2)
})
