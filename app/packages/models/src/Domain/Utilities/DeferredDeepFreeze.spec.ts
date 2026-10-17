import { deferDeepFreeze, DEFERRED_FREEZE_BATCH_SIZE, DEFERRED_FREEZE_BUDGET_MS } from './DeferredDeepFreeze'
import { createNote } from './Test/SpecUtils'

describe('deferred model freezing', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['Date'] }))
  afterEach(() => {
    jest.runAllTimers()
    jest.useRealTimers()
  })

  it('shares one bounded timer queue across payload and item construction', () => {
    const timers = jest.spyOn(globalThis, 'setTimeout')
    const notes = Array.from({ length: 5_000 }, () => createNote({ title: 'Note', text: 'Body' }))
    expect(jest.getTimerCount()).toBe(1)
    expect(Object.isFrozen(notes[0])).toBe(false)
    jest.runOnlyPendingTimers()
    expect(Object.isFrozen(notes[0])).toBe(true)
    expect(Object.isFrozen(notes[DEFERRED_FREEZE_BATCH_SIZE])).toBe(false)
    expect(jest.getTimerCount()).toBe(1)
    jest.runAllTimers()
    for (const note of notes) {
      expect(Object.isFrozen(note)).toBe(true)
      expect(Object.isFrozen(note.payload)).toBe(true)
      expect(Object.isFrozen(note.payload.content)).toBe(true)
      expect(note.title).toBe('Note')
    }
    expect(timers).toHaveBeenCalledTimes(Math.ceil(10_000 / DEFERRED_FREEZE_BATCH_SIZE))
    timers.mockRestore()
  })
  it('yields between expensive roots when its elapsed-time budget is reached', () => {
    const roots = [{ nested: {} }, { nested: {} }, { nested: {} }]
    roots.forEach(deferDeepFreeze)
    let clock = 0
    const time = jest.spyOn(performance, 'now').mockImplementation(() => {
      clock += DEFERRED_FREEZE_BUDGET_MS
      return clock
    })
    try {
      jest.runOnlyPendingTimers()
      expect(Object.isFrozen(roots[0])).toBe(true)
      expect(Object.isFrozen(roots[1])).toBe(false)
      expect(jest.getTimerCount()).toBe(1)
    } finally {
      time.mockRestore()
    }
    jest.runAllTimers()
    expect(roots.every(Object.isFrozen)).toBe(true)
  })

  it('finishes subclass fields and nested immutability before freezing', () => {
    class Base {
      constructor() {
        deferDeepFreeze(this)
      }
    }
    class Child extends Base {
      nested = { value: 'initialized by subclass' }
    }
    const child = new Child()
    expect(Object.isFrozen(child)).toBe(false)
    jest.runAllTimers()
    expect(child.nested.value).toBe('initialized by subclass')
    expect(Object.isFrozen(child)).toBe(true)
    expect(Object.isFrozen(child.nested)).toBe(true)
    expect(() => {
      child.nested.value = 'changed'
    }).toThrow()
  })

  it('continues after an observable freeze exception without stranding later roots', () => {
    const failure = new Error('cannot freeze fixture')
    const broken = Object.defineProperty({}, 'value', {
      get: () => {
        throw failure
      },
    })
    const later = { value: { ready: true } }
    deferDeepFreeze(broken)
    deferDeepFreeze(later)
    expect(() => jest.runOnlyPendingTimers()).toThrow(failure)
    expect(Object.isFrozen(later)).toBe(false)
    expect(jest.getTimerCount()).toBe(1)
    jest.runAllTimers()
    expect(Object.isFrozen(later.value)).toBe(true)
  })

  it('queues objects added during a freeze for a later task', () => {
    const next = { nested: {} }
    let queued = false
    const first = new Proxy(
      {},
      {
        ownKeys: () => {
          if (!queued) {
            queued = true
            deferDeepFreeze(next)
          }
          return []
        },
      },
    )
    deferDeepFreeze(first)
    jest.runOnlyPendingTimers()
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(next)).toBe(false)
    expect(jest.getTimerCount()).toBe(1)
    jest.runAllTimers()
    expect(Object.isFrozen(next.nested)).toBe(true)
  })

  it('ignores roots already frozen by an earlier payload or duplicate enqueue', () => {
    const object = { value: { ready: true } }
    deferDeepFreeze(object)
    deferDeepFreeze(object)
    expect(() => jest.runAllTimers()).not.toThrow()
    expect(Object.isFrozen(object.value)).toBe(true)
  })
})
