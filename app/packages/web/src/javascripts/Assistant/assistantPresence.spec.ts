import { AssistantPresence, bridgeAssistantPresence, AssistantActivityAwareness } from './assistantPresence'

it('does not notify on unchanged remote activity and isolates sibling bridge cleanup', () => {
  const one = Symbol()
  const two = Symbol()
  const listener = jest.fn()
  const stop = AssistantPresence.subscribe('remote', listener)
  const entries = [{ noteUuid: 'remote', userUuid: 'user', runId: 'run', status: 'working' as const, clientId: 1 }]
  AssistantPresence.setRemote('remote', one, entries)
  listener.mockClear()
  AssistantPresence.setRemote(
    'remote',
    one,
    entries.map((entry) => ({ ...entry })),
  )
  expect(listener).not.toHaveBeenCalled()
  AssistantPresence.setRemote('remote', two, entries)
  AssistantPresence.clearRemote('remote', one)
  expect(AssistantPresence.getRemote('remote')).toHaveLength(1)
  AssistantPresence.clearRemote('remote', two)
  stop()
})

it('isolates concurrent runs and removes each activity on completion without clearing siblings', () => {
  const first = AssistantPresence.start({ noteUuid: 'note', runId: 'one', userUuid: 'user', status: 'working' })
  const second = AssistantPresence.start({ noteUuid: 'note', runId: 'two', userUuid: 'user', status: 'reading' })
  expect(AssistantPresence.getLocal('note')).toHaveLength(2)
  first.update('other', 'editing')
  expect(AssistantPresence.getLocal('note')).toHaveLength(1)
  expect(AssistantPresence.getLocal('other')[0].status).toBe('editing')
  first.dispose()
  first.update('note', 'working')
  expect(AssistantPresence.getLocal('note')).toHaveLength(1)
  second.dispose()
  expect(AssistantPresence.getLocal('note')).toEqual([])
  expect(AssistantPresence.getLocal('other')).toEqual([])
})

it('never manufactures human awareness and only publishes matching account bounded activity', () => {
  let state: Record<string, unknown> | null = null
  const callbacks = new Set<() => void>()
  const awareness: AssistantActivityAwareness = {
    clientID: 1,
    getLocalState: () => state,
    getStates: () => new Map(),
    setLocalStateField: jest.fn((field, value) => {
      state = { ...state, [field]: value }
      callbacks.forEach((cb) => cb())
    }),
    on: (_, cb) => {
      callbacks.add(cb)
    },
    off: (_, cb) => {
      callbacks.delete(cb)
    },
  }
  const own = AssistantPresence.start({ noteUuid: 'wire', runId: 'one', userUuid: 'user', status: 'reading' })
  const other = AssistantPresence.start({ noteUuid: 'wire', runId: 'two', userUuid: 'other', status: 'editing' })
  const stop = bridgeAssistantPresence(awareness, 'wire', 'user')
  expect(awareness.setLocalStateField).not.toHaveBeenCalled()
  state = { name: 'Human', anchorPos: 'caret', awarenessData: { userUuid: 'user', deviceId: 'device' } }
  callbacks.forEach((cb) => cb())
  expect(state).toMatchObject({
    name: 'Human',
    anchorPos: 'caret',
    awarenessData: { userUuid: 'user', deviceId: 'device', assistantActivity: [{ runId: 'one', status: 'reading' }] },
  })
  stop()
  own.dispose()
  other.dispose()
  expect(state?.awarenessData).toEqual({ userUuid: 'user', deviceId: 'device' })
})
