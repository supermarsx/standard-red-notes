/**
 * @jest-environment node
 */
import { PEER_TYPING_LINGER_MS, PeerActivityTracker } from './PeerActivity'
import { PresenceRegistry } from './PresenceRegistry'

/** A clock the test moves by hand; timers fire in deadline order as it advances. */
function manualClock(startAt = 1_000_000) {
  let current = startAt
  let nextHandle = 0
  const timers = new Map<number, { at: number; run(): void }>()
  return {
    now: () => current,
    setTimeout: (run: () => void, milliseconds: number) => {
      nextHandle += 1
      timers.set(nextHandle, { at: current + milliseconds, run })
      return nextHandle
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number)
    },
    pending: () => timers.size,
    advance(milliseconds: number) {
      const target = current + milliseconds
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) {
          break
        }
        timers.delete(due[0])
        current = due[1].at
        due[1].run()
      }
      current = target
    },
  }
}

describe('PeerActivityTracker', () => {
  it('reports a peer as typing from its edits and takes that down by itself when they stop', () => {
    const clock = manualClock()
    const onChange = jest.fn()
    const tracker = new PeerActivityTracker(onChange, clock)

    expect(tracker.describe(7)).toEqual({ typing: false })

    tracker.noteEdit(7)
    expect(tracker.describe(7)).toEqual({ typing: true, lastActiveAt: 1_000_000 })
    expect(onChange).toHaveBeenCalledTimes(1)

    // More keystrokes keep it up without announcing a change that did not happen.
    clock.advance(1_000)
    tracker.noteEdit(7)
    tracker.noteEdit(7)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(tracker.describe(7)).toEqual({ typing: true, lastActiveAt: 1_001_000 })

    // The linger is measured from the LAST edit, not the first.
    clock.advance(PEER_TYPING_LINGER_MS - 1)
    expect(tracker.describe(7).typing).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)

    // Nothing arrives to say a peer stopped; the tracker has to say so itself.
    clock.advance(1)
    expect(tracker.describe(7)).toEqual({ typing: false, lastActiveAt: 1_001_000 })
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(clock.pending()).toBe(0)
  })

  it('keeps each peer on its own deadline', () => {
    const clock = manualClock()
    const onChange = jest.fn()
    const tracker = new PeerActivityTracker(onChange, clock)

    tracker.noteEdit(1)
    clock.advance(2_000)
    tracker.noteEdit(2)
    expect(onChange).toHaveBeenCalledTimes(2)

    clock.advance(PEER_TYPING_LINGER_MS - 2_000)
    expect(tracker.describe(1).typing).toBe(false)
    expect(tracker.describe(2).typing).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(3)

    clock.advance(2_000)
    expect(tracker.describe(2).typing).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('counts a caret that MOVED as activity, never the first position seen nor a renewal of the same one', () => {
    const clock = manualClock()
    const onChange = jest.fn()
    const tracker = new PeerActivityTracker(onChange, clock)
    const at = (clock: number) => ({ type: null, tname: 'root', item: { client: 9, clock }, assoc: 0 })

    tracker.observeCaret(9, at(4), at(4))
    expect(tracker.describe(9)).toEqual({ typing: false })

    clock.advance(15_000)
    tracker.observeCaret(9, at(4), at(4))
    expect(tracker.describe(9)).toEqual({ typing: false })

    clock.advance(500)
    tracker.observeCaret(9, at(4), at(9))
    expect(tracker.describe(9)).toEqual({ typing: false, lastActiveAt: 1_015_500 })
    // Moving a caret is not typing, and is not a change of anything the tracker announces.
    expect(onChange).not.toHaveBeenCalled()

    // Losing the selection altogether is a change too.
    clock.advance(100)
    tracker.observeCaret(9, null, undefined)
    expect(tracker.describe(9).lastActiveAt).toBe(1_015_600)
  })

  it('forgets a peer that left, and stops its timer when disposed', () => {
    const clock = manualClock()
    const onChange = jest.fn()
    const tracker = new PeerActivityTracker(onChange, clock)

    tracker.noteEdit(1)
    tracker.noteEdit(2)
    tracker.retain(new Set([2]))
    expect(tracker.describe(1)).toEqual({ typing: false })
    expect(tracker.describe(2).typing).toBe(true)

    tracker.dispose()
    expect(clock.pending()).toBe(0)
    clock.advance(PEER_TYPING_LINGER_MS * 2)
    // Two "started typing" calls and nothing after the dispose.
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})

describe('PresenceRegistry activity fields', () => {
  const ROOM = 'peer-activity-room'

  afterEach(() => PresenceRegistry.clearRoom(ROOM))

  it('carries typing, focusing and lastActiveAt to subscribers exactly as given', () => {
    const seen: unknown[] = []
    const unsubscribe = PresenceRegistry.subscribe(ROOM, (peers) => seen.push(peers))

    PresenceRegistry.setPeers(ROOM, [
      { clientId: 1, name: 'Bob', color: '#2563eb', typing: true, focusing: true, lastActiveAt: 1_700_000_000_000 },
      { clientId: 2, name: 'Carol', color: '#16a34a', typing: false, focusing: false },
      { clientId: 3, name: 'Dave', color: '#dc2626' },
    ])
    unsubscribe()

    expect(seen).toEqual([
      [
        { clientId: 1, name: 'Bob', color: '#2563eb', typing: true, focusing: true, lastActiveAt: 1_700_000_000_000 },
        { clientId: 2, name: 'Carol', color: '#16a34a', typing: false, focusing: false },
        { clientId: 3, name: 'Dave', color: '#dc2626' },
      ],
    ])
  })

  it('drops an activity field of the wrong type instead of passing it on', () => {
    PresenceRegistry.setPeers(ROOM, [
      {
        clientId: 1,
        name: 'Bob',
        color: '#2563eb',
        typing: 'yes' as unknown as boolean,
        focusing: 1 as unknown as boolean,
        lastActiveAt: Number.NaN,
      },
    ])

    expect(PresenceRegistry.getPeers(ROOM)).toEqual([{ clientId: 1, name: 'Bob', color: '#2563eb' }])
  })
})
