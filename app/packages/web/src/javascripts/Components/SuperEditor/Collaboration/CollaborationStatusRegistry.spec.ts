import { CollaborationStatusRegistry } from './CollaborationStatusRegistry'

it('publishes read-only transitions even when the preparation or retry reason stays the same', () => {
  const room = 'joining-guard-test'
  const listener = jest.fn()
  const unsubscribe = CollaborationStatusRegistry.subscribe(room, listener)
  try {
    CollaborationStatusRegistry.setStatus(room, { kind: 'preparing' })
    CollaborationStatusRegistry.setStatus(room, { kind: 'preparing', readonly: true })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(CollaborationStatusRegistry.getState(room)?.status).toEqual({ kind: 'preparing', readonly: true })
    CollaborationStatusRegistry.setStatus(room, { kind: 'preparing', readonly: true })
    expect(listener).toHaveBeenCalledTimes(2)
    CollaborationStatusRegistry.setStatus(room, { kind: 'unavailable', reason: 'Retrying', readonly: true })
    CollaborationStatusRegistry.setStatus(room, { kind: 'unavailable', reason: 'Retrying', readonly: false })
    expect(listener).toHaveBeenCalledTimes(4)
    expect(CollaborationStatusRegistry.getState(room)?.status).toEqual({ kind: 'unavailable', reason: 'Retrying' })
  } finally {
    unsubscribe()
    CollaborationStatusRegistry.clearRoom(room)
  }
})

it('publishes a terminal change even when the reason and read-only state are unchanged', () => {
  const room = 'recovery-hint-test'
  const listener = jest.fn()
  const unsubscribe = CollaborationStatusRegistry.subscribe(room, listener)
  try {
    CollaborationStatusRegistry.setStatus(room, { kind: 'active' })
    CollaborationStatusRegistry.setStatus(room, {
      kind: 'unavailable',
      reason: 'Waiting',
      readonly: true,
      recovery: 'transient',
    })
    CollaborationStatusRegistry.setStatus(room, {
      kind: 'unavailable',
      reason: 'Waiting',
      readonly: true,
      recovery: 'terminal',
    })
    expect(listener).toHaveBeenCalledTimes(3)
    expect(CollaborationStatusRegistry.getState(room)).toMatchObject({
      hasBeenActive: true,
      status: { kind: 'unavailable', recovery: 'terminal' },
    })
  } finally {
    unsubscribe()
    CollaborationStatusRegistry.clearRoom(room)
  }
})
