/**
 * @jest-environment node
 */
import * as Y from 'yjs'
import {
  CollaborativeDocumentRegistryImpl,
  documentStateOf,
  type LiveCollaborativeDocument,
} from './CollaborativeDocumentRegistry'
import { createCollaborationRevisionStamp, type CollaborationRevisionStamp } from './CollaborationRevisionStamp'

const EPOCH = 'room_epoch_0000000000000001'
const ROOM = 'note-uuid'

/** A clock the test moves by hand. */
function manualClock() {
  let now = 0
  let nextHandle = 0
  const timers = new Map<number, { at: number; run(): void }>()
  return {
    setTimeout: (run: () => void, milliseconds: number) => {
      nextHandle += 1
      timers.set(nextHandle, { at: now + milliseconds, run })
      return nextHandle
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number)
    },
    pending: () => timers.size,
    advance(milliseconds: number) {
      now += milliseconds
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(handle)
          timer.run()
        }
      }
    },
  }
}

function documentOf(clientId: number): Y.Doc {
  const document = new Y.Doc()
  document.clientID = clientId
  return document
}

const type = (document: Y.Doc, text: string): void => {
  const body = document.getText('body')
  body.insert(body.length, text)
}

/** The live document exactly as the collaboration plugin registers it. */
function live(
  document: Y.Doc,
  options: { epoch?: string; ready?: () => boolean } = {},
): LiveCollaborativeDocument & { listeners(): number } {
  let listeners = 0
  return {
    epoch: options.epoch ?? EPOCH,
    state: () => ((options.ready?.() ?? true) ? documentStateOf(document) : undefined),
    subscribe: (listener) => {
      listeners += 1
      document.on('update', listener)
      return () => {
        listeners -= 1
        document.off('update', listener)
      }
    },
    listeners: () => listeners,
  }
}

const stampOf = (document: Y.Doc, epoch = EPOCH): CollaborationRevisionStamp =>
  createCollaborationRevisionStamp(
    epoch,
    documentStateOf(document),
    document.getText('body').toString(),
    Date.UTC(2026, 9, 6, 9, 30),
  ) as CollaborationRevisionStamp

const erase = (document: Y.Doc, text: string): void => {
  const body = document.getText('body')
  const index = body.toString().indexOf(text)
  expect(index).toBeGreaterThanOrEqual(0)
  body.delete(index, text.length)
}

describe('documentStateOf', () => {
  it('says what a real document holds and which of it has been deleted, per client', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'Alpha Beta ')
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    type(bob, 'Gamma')
    erase(bob, 'Beta ')
    erase(bob, 'mm')

    const state = documentStateOf(bob)

    expect([...state.stateVector].sort()).toEqual([
      [1, 11],
      [2, 5],
    ])
    // Bob deleted five of Alice's characters and two of his own. Garbage collection has already
    // replaced their content; the runs are still there, which is what makes them comparable.
    expect([...state.deleted].sort()).toEqual([
      [1, [[6, 5]]],
      [2, [[2, 2]]],
    ])
    expect(documentStateOf(alice).deleted.size).toBe(0)
  })
})

describe('CollaborativeDocumentRegistry.covers', () => {
  it('is true only for a revision the registered document contains', () => {
    const registry = new CollaborativeDocumentRegistryImpl(manualClock())
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'Alpha')
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    registry.set(ROOM, live(bob))

    const merged = stampOf(alice)
    type(alice, ' and one more word Bob has not received')
    const ahead = stampOf(alice)

    expect(registry.covers(ROOM, merged)).toBe(true)
    expect(registry.covers(ROOM, ahead)).toBe(false)
  })

  it('is false for a revision that only DELETED something the registered document still holds', () => {
    const registry = new CollaborativeDocumentRegistryImpl(manualClock())
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'Keep this. Remove this.')
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    registry.set(ROOM, live(bob))

    erase(alice, ' Remove this.')
    const onlyDeleted = stampOf(alice)

    // Bob holds every operation Alice ever made; what he has not got is her deletion.
    expect(onlyDeleted.sv).toEqual(stampOf(bob).sv)
    expect(registry.covers(ROOM, onlyDeleted)).toBe(false)
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    expect(registry.covers(ROOM, onlyDeleted)).toBe(true)
  })

  it('never vouches across rooms, across epochs, or for a document that has not established its state', () => {
    const registry = new CollaborativeDocumentRegistryImpl(manualClock())
    const document = documentOf(1)
    type(document, 'Alpha')
    let ready = false
    registry.set(ROOM, live(document, { ready: () => ready }))
    const stamp = stampOf(document)

    // A newcomer still waiting for a peer's copy: its vector is not evidence of anything yet.
    expect(registry.covers(ROOM, stamp)).toBe(false)
    ready = true
    expect(registry.covers(ROOM, stamp)).toBe(true)

    expect(registry.covers('another-note', stamp)).toBe(false)
    // The room emptied and was rebuilt from text: same client ids would be a coincidence.
    expect(registry.covers(ROOM, stampOf(document, 'room_epoch_0000000000000002'))).toBe(false)
  })

  it('removes exactly the registration it was given', () => {
    const registry = new CollaborativeDocumentRegistryImpl(manualClock())
    const first = live(documentOf(1))
    const second = live(documentOf(2))
    const removeFirst = registry.set(ROOM, first)
    registry.set(ROOM, second)

    // The first editor's teardown runs late, after a remount registered its successor.
    removeFirst()

    expect(registry.get(ROOM)).toBe(second)
  })
})

describe('CollaborativeDocumentRegistry.whenCovers', () => {
  it('answers at once for a revision the document already contains', async () => {
    const clock = manualClock()
    const registry = new CollaborativeDocumentRegistryImpl(clock)
    const document = documentOf(1)
    type(document, 'Alpha')
    const registered = live(document)
    registry.set(ROOM, registered)

    await expect(registry.whenCovers(ROOM, stampOf(document), 10_000)).resolves.toBe(true)
    expect(clock.pending()).toBe(0)
    expect(registered.listeners()).toBe(0)
  })

  it('waits for the relay to deliver what the author wrote while away, then says yes', async () => {
    const clock = manualClock()
    const registry = new CollaborativeDocumentRegistryImpl(clock)
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'shared ')
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    const registered = live(bob)
    registry.set(ROOM, registered)

    // Alice was offline: her stored revision reaches Bob BEFORE her operations do.
    type(alice, 'written offline')
    const answer = registry.whenCovers(ROOM, stampOf(alice), 10_000)
    let settled: boolean | undefined
    void answer.then((value) => (settled = value))

    // An unrelated update (Bob's own typing) is not the merge.
    type(bob, 'bob keeps typing')
    await Promise.resolve()
    expect(settled).toBeUndefined()

    // She rejoins; the relay delivers the difference.
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    await expect(answer).resolves.toBe(true)
    expect(clock.pending()).toBe(0)
    expect(registered.listeners()).toBe(0)
  })

  it('waits for a deletion its author made while away, and keeps saying no if it never comes', async () => {
    const clock = manualClock()
    const registry = new CollaborativeDocumentRegistryImpl(clock)
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'Keep this. Remove this.')
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    registry.set(ROOM, live(bob))
    erase(alice, ' Remove this.')
    const onlyDeleted = stampOf(alice)

    // Her deletion reaches the room: the revision is contained, nothing is copied.
    const merged = registry.whenCovers(ROOM, onlyDeleted, 10_000)
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice))
    await expect(merged).resolves.toBe(true)

    // The same revision against a room her deletion never reaches (she closed the tab): the
    // revision is NOT contained, and whoever asked keeps it as a conflicted copy.
    const carol = documentOf(3)
    const unreached = documentOf(4)
    type(carol, 'Keep this. Remove this.')
    Y.applyUpdate(unreached, Y.encodeStateAsUpdate(carol))
    registry.set(ROOM, live(unreached))
    erase(carol, ' Remove this.')
    const lost = registry.whenCovers(ROOM, stampOf(carol), 10_000)
    type(unreached, ' Someone else keeps typing.')
    clock.advance(10_000)
    await expect(lost).resolves.toBe(false)
  })

  it('says no once the wait is over and the operations never came', async () => {
    const clock = manualClock()
    const registry = new CollaborativeDocumentRegistryImpl(clock)
    const alice = documentOf(1)
    const bob = documentOf(2)
    const registered = live(bob)
    type(bob, 'bob')
    registry.set(ROOM, registered)
    type(alice, 'alice, who closed her tab while offline')

    const answer = registry.whenCovers(ROOM, stampOf(alice), 10_000)
    clock.advance(9_999)
    let settled: boolean | undefined
    void answer.then((value) => (settled = value))
    await Promise.resolve()
    expect(settled).toBeUndefined()

    clock.advance(1)
    await expect(answer).resolves.toBe(false)
    expect(registered.listeners()).toBe(0)
  })

  it('does not wait at all when there is no live document of that epoch to merge into', async () => {
    const clock = manualClock()
    const registry = new CollaborativeDocumentRegistryImpl(clock)
    const document = documentOf(1)
    type(document, 'Alpha')
    const stamp = stampOf(document)

    await expect(registry.whenCovers(ROOM, stamp, 10_000)).resolves.toBe(false)

    registry.set(ROOM, live(documentOf(2), { epoch: 'room_epoch_0000000000000002' }))
    await expect(registry.whenCovers(ROOM, stamp, 10_000)).resolves.toBe(false)
    expect(clock.pending()).toBe(0)
  })

  it('reads whichever document holds the room when the merge lands, after a remount', async () => {
    const clock = manualClock()
    const registry = new CollaborativeDocumentRegistryImpl(clock)
    const alice = documentOf(1)
    type(alice, 'offline words')
    const stamp = stampOf(alice)
    const beforeRemount = documentOf(2)
    type(beforeRemount, 'bob')
    registry.set(ROOM, live(beforeRemount))

    const answer = registry.whenCovers(ROOM, stamp, 10_000)

    // The editor remounts on a new lease with a document that already holds her words.
    const afterRemount = documentOf(3)
    Y.applyUpdate(afterRemount, Y.encodeStateAsUpdate(alice))
    registry.set(ROOM, live(afterRemount))
    clock.advance(10_000)

    await expect(answer).resolves.toBe(true)
  })
})
