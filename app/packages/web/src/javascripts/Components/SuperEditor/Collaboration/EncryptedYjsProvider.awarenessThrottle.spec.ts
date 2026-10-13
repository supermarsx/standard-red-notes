/**
 * @jest-environment node
 */
import * as Y from 'yjs'
import { EncryptedYjsProvider, LOCAL_AWARENESS_MIN_INTERVAL_MS, MAX_YJS_TRANSFER_BYTES } from './EncryptedYjsProvider'
import type { RoomCipher } from './RoomCrypto'
import type { CollabFrame } from './CollabChannel'

const TEST_ROOM_EPOCH = 'room_epoch_0000000000000001'

const identityCipher = (): RoomCipher => ({
  encrypt: async (plaintext) => Buffer.from(plaintext).toString('base64'),
  decrypt: async (payload) => new Uint8Array(Buffer.from(payload, 'base64')),
})

type LocalAwareness = {
  setLocalState(state: Record<string, unknown> | null): void
  setLocalStateField(field: string, value: unknown): void
}

function joinedProvider(room: string): { provider: EncryptedYjsProvider; sent: CollabFrame[] } {
  const sent: CollabFrame[] = []
  const lease = {
    requestId: `${room}-lease`,
    shouldBootstrap: true,
    protocolVersion: 3 as const,
    maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
    roomEpoch: TEST_ROOM_EPOCH,
    release: jest.fn(),
  }
  const provider = new EncryptedYjsProvider(
    new Y.Doc(),
    room,
    {
      isConnected: () => true,
      authorize: jest.fn(),
      subscribe: () => () => undefined,
      send: (frame) => sent.push(frame),
    },
    identityCipher(),
    undefined,
    lease.requestId,
    {
      activeLease: lease,
      shouldBootstrap: true,
      expectedRoomEpoch: TEST_ROOM_EPOCH,
      validateAttachment: () => true,
      reactivate: jest.fn(),
      onFatal: jest.fn(),
    },
  )
  return { provider, sent }
}

/** Let queued encrypt/send promises run without advancing the (fake) clock. */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await Promise.resolve()
  }
}

const awarenessFrames = (sent: CollabFrame[]) => sent.filter((frame) => frame.t === 'awareness').length

describe('EncryptedYjsProvider local caret broadcast', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('sends the first caret move at once, collapses a burst into one trailing frame inside the window', async () => {
    jest.useFakeTimers()
    const { provider, sent } = joinedProvider('caret-throttle-room')
    try {
      provider.connect()
      await drainMicrotasks()
      expect(provider.isRoomJoined()).toBe(true)
      // Let the join's own frames clear the throttle window so this test starts from rest.
      jest.advanceTimersByTime(LOCAL_AWARENESS_MIN_INTERVAL_MS)
      await drainMicrotasks()
      const awareness = provider.awareness as unknown as LocalAwareness
      const before = awarenessFrames(sent)

      awareness.setLocalStateField('anchorPos', { move: 1 })
      await drainMicrotasks()
      // Leading edge: no waiting for the first move.
      expect(awarenessFrames(sent)).toBe(before + 1)

      // A drag: twenty moves inside one window.
      for (let move = 2; move <= 21; move += 1) {
        awareness.setLocalStateField('anchorPos', { move })
        await drainMicrotasks()
      }
      expect(awarenessFrames(sent)).toBe(before + 1)

      jest.advanceTimersByTime(LOCAL_AWARENESS_MIN_INTERVAL_MS)
      await drainMicrotasks()
      // One trailing frame, and it carries the NEWEST caret.
      expect(awarenessFrames(sent)).toBe(before + 2)
      const last = sent.filter((frame) => frame.t === 'awareness').at(-1) as { payload: string }
      expect(Buffer.from(last.payload, 'base64').toString('utf8')).toContain('"move":21')

      // Nothing else is pending: no spam after the burst ends.
      jest.advanceTimersByTime(LOCAL_AWARENESS_MIN_INTERVAL_MS * 10)
      await drainMicrotasks()
      expect(awarenessFrames(sent)).toBe(before + 2)
    } finally {
      provider.destroy()
    }
  })

  it('keeps a caret within the window bound: a move just after a send goes out no later than the interval', async () => {
    jest.useFakeTimers()
    const { provider, sent } = joinedProvider('caret-latency-room')
    try {
      provider.connect()
      await drainMicrotasks()
      jest.advanceTimersByTime(LOCAL_AWARENESS_MIN_INTERVAL_MS)
      await drainMicrotasks()
      const awareness = provider.awareness as unknown as LocalAwareness
      awareness.setLocalStateField('anchorPos', { move: 1 })
      await drainMicrotasks()
      const before = awarenessFrames(sent)

      jest.advanceTimersByTime(5)
      awareness.setLocalStateField('anchorPos', { move: 2 })
      await drainMicrotasks()
      expect(awarenessFrames(sent)).toBe(before)
      jest.advanceTimersByTime(LOCAL_AWARENESS_MIN_INTERVAL_MS - 5 - 1)
      await drainMicrotasks()
      expect(awarenessFrames(sent)).toBe(before)
      jest.advanceTimersByTime(1)
      await drainMicrotasks()
      expect(awarenessFrames(sent)).toBe(before + 1)
    } finally {
      provider.destroy()
    }
  })

  it('announces leaving at once even inside the window, and leaves no timer behind on destroy', async () => {
    jest.useFakeTimers()
    const { provider, sent } = joinedProvider('caret-leave-room')
    provider.connect()
    await drainMicrotasks()
    jest.advanceTimersByTime(LOCAL_AWARENESS_MIN_INTERVAL_MS)
    await drainMicrotasks()
    const awareness = provider.awareness as unknown as LocalAwareness
    awareness.setLocalStateField('anchorPos', { move: 1 })
    await drainMicrotasks()
    const before = awarenessFrames(sent)

    awareness.setLocalState(null)
    await drainMicrotasks()
    expect(awarenessFrames(sent)).toBe(before + 1)

    awareness.setLocalState({ name: 'again' })
    await drainMicrotasks()
    provider.destroy()
    expect(jest.getTimerCount()).toBe(0)
  })
})
