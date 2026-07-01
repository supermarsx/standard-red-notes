/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BroadcastChannelLike,
  CrossTabCoordinator,
  CrossTabMessageType,
} from './CrossTabCoordinator'

/**
 * Standard Red Notes: cross-tab coordination tests.
 *
 * The full multi-tab behavior is browser-only (real BroadcastChannel + window 'storage'
 * events fire only across genuinely separate tabs). Here we MOCK BroadcastChannel and the
 * window/localStorage so we can exercise the coordinator's contract in isolation:
 *   - emits on save and on keychain change
 *   - on a FOREIGN keychain clear it enters the locked state (and fires the lock callback)
 *   - on a FOREIGN save it marks uuids stale and invokes the reload callback (debounced)
 *   - it IGNORES its own messages (single-tab safety)
 */

/**
 * In-memory BroadcastChannel bus shared by all channels of the same name, so two
 * coordinators in the test behave like two tabs. A real BroadcastChannel does NOT echo to
 * the sender, so neither does this mock.
 */
class MockBus {
  private static buses = new Map<string, Set<MockChannel>>()

  static channelFor(name: string): MockChannel {
    let set = this.buses.get(name)
    if (!set) {
      set = new Set()
      this.buses.set(name, set)
    }
    const channel = new MockChannel(name, set)
    set.add(channel)
    return channel
  }

  static reset(): void {
    this.buses.clear()
  }
}

class MockChannel implements BroadcastChannelLike {
  public onmessage: ((event: { data: unknown }) => void) | null = null
  public closed = false

  constructor(
    public name: string,
    private peers: Set<MockChannel>,
  ) {}

  postMessage(message: unknown): void {
    if (this.closed) {
      return
    }
    for (const peer of this.peers) {
      if (peer === this || peer.closed) {
        continue
      }
      // Deliver asynchronously like a real channel.
      Promise.resolve().then(() => peer.onmessage?.({ data: message }))
    }
  }

  close(): void {
    this.closed = true
    this.peers.delete(this)
  }
}

/** Minimal window/localStorage stand-in that lets tests dispatch 'storage' events. */
class MockWindow {
  private listeners: Record<string, Array<(event: any) => void>> = {}
  public localStorage = {
    store: new Map<string, string>(),
    getItem(key: string): string | null {
      return this.store.has(key) ? (this.store.get(key) as string) : null
    },
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener)
  }

  dispatchStorage(key: string | null): void {
    for (const listener of this.listeners['storage'] ?? []) {
      listener({ key })
    }
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const makeCoordinator = (
  namespace: string,
  callbacks: ConstructorParameters<typeof CrossTabCoordinator>[0]['callbacks'],
  windowRef = new MockWindow(),
) => {
  const coordinator = new CrossTabCoordinator({
    namespace,
    callbacks,
    channelFactory: (name) => MockBus.channelFor(name),
    windowRef: windowRef as any,
  })
  return { coordinator, windowRef }
}

describe('CrossTabCoordinator', () => {
  beforeEach(() => {
    MockBus.reset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    // Some tests flip to real timers mid-test for microtask flushing; only drain pending
    // fake timers if they are still active, then restore real timers for the next file.
    try {
      jest.runOnlyPendingTimers()
    } catch {
      // Fake timers were already swapped out for real timers in the test body.
    }
    jest.useRealTimers()
  })

  describe('emits', () => {
    it('emits a PayloadsSaved message to a peer on save', async () => {
      const received: any[] = []
      const { coordinator: a } = makeCoordinator('acct', {})
      const peerChannel = MockBus.channelFor('sn-crosstab-acct')
      peerChannel.onmessage = (event) => received.push(event.data)

      a.emitPayloadsSaved(['uuid-1', 'uuid-2'])

      jest.useRealTimers()
      await flushMicrotasks()

      expect(received).toHaveLength(1)
      expect(received[0].type).toBe(CrossTabMessageType.PayloadsSaved)
      expect(received[0].uuids).toEqual(['uuid-1', 'uuid-2'])
      expect(received[0].tabId).toBe(a.tabId)
    })

    it('emits a KeychainChanged message to a peer on keychain change', async () => {
      const received: any[] = []
      const { coordinator: a } = makeCoordinator('keychain', {})
      const peerChannel = MockBus.channelFor('sn-crosstab-keychain')
      peerChannel.onmessage = (event) => received.push(event.data)

      a.emitKeychainChanged()

      jest.useRealTimers()
      await flushMicrotasks()

      expect(received).toHaveLength(1)
      expect(received[0].type).toBe(CrossTabMessageType.KeychainChanged)
    })

    it('does not emit a PayloadsSaved message when there are no uuids', () => {
      const { coordinator: a } = makeCoordinator('acct', {})
      const peerChannel = MockBus.channelFor('sn-crosstab-acct')
      const spy = jest.fn()
      peerChannel.onmessage = spy

      a.emitPayloadsSaved([])

      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('keychain lock (the critical safety)', () => {
    it('enters the locked state and fires onKeychainInvalidated on a FOREIGN keychain clear via storage event', () => {
      const onKeychainInvalidated = jest.fn()
      const { coordinator, windowRef } = makeCoordinator('keychain', { onKeychainInvalidated })

      expect(coordinator.isLocked()).toBe(false)

      // Another tab removed the 'keychain' key -> storage event fires in THIS tab.
      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('treats a full localStorage.clear() (key === null) as a keychain change', () => {
      const onKeychainInvalidated = jest.fn()
      const { coordinator, windowRef } = makeCoordinator('keychain', { onKeychainInvalidated })

      windowRef.dispatchStorage(null)

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('ignores storage events for unrelated keys', () => {
      const onKeychainInvalidated = jest.fn()
      const { coordinator, windowRef } = makeCoordinator('keychain', { onKeychainInvalidated })

      windowRef.dispatchStorage('some-other-key')

      expect(coordinator.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
    })

    it('locks via a peer BroadcastChannel keychain message and BLOCKS further writes (irreversible)', async () => {
      const onKeychainInvalidated = jest.fn()
      const { coordinator: tabB } = makeCoordinator('keychain', { onKeychainInvalidated })
      const { coordinator: tabA } = makeCoordinator('keychain', {})

      expect(tabB.isLocked()).toBe(false)

      // Tab A rotates/clears the keychain and broadcasts it.
      tabA.emitKeychainChanged()

      jest.useRealTimers()
      await flushMicrotasks()

      // Tab B is now locked: a host consulting isLocked() before saving will refuse the write.
      expect(tabB.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('fires the lock callback only once even on repeated foreign changes (irreversible-until-reload)', () => {
      const onKeychainInvalidated = jest.fn()
      const { coordinator, windowRef } = makeCoordinator('keychain', { onKeychainInvalidated })

      windowRef.dispatchStorage('keychain')
      windowRef.dispatchStorage('keychain')
      windowRef.dispatchStorage(null)

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })
  })

  describe('foreign-save invalidation', () => {
    it('marks foreign-saved uuids stale and reloads them (debounced/coalesced)', async () => {
      const onForeignSave = jest.fn()
      const { coordinator: tabB } = makeCoordinator('acct', { onForeignSave })
      const { coordinator: tabA } = makeCoordinator('acct', {})

      tabA.emitPayloadsSaved(['a', 'b'])
      tabA.emitPayloadsSaved(['b', 'c'])

      // Deliver the channel messages (async), then fire the debounce timer.
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(300)

      expect(onForeignSave).toHaveBeenCalledTimes(1)
      const uuids = (onForeignSave.mock.calls[0][0] as string[]).sort()
      expect(uuids).toEqual(['a', 'b', 'c'])
    })
  })

  describe('ignores its own messages', () => {
    it('does not invalidate or lock from its OWN broadcasts', async () => {
      const onForeignSave = jest.fn()
      const onKeychainInvalidated = jest.fn()
      // Force a transport that echoes back to the sender to prove the tabId guard works.
      const selfEchoChannelFactory = (_name: string): BroadcastChannelLike => {
        const channel: BroadcastChannelLike = {
          onmessage: null,
          postMessage(message: unknown) {
            Promise.resolve().then(() => channel.onmessage?.({ data: message }))
          },
          close() {
            /* no-op */
          },
        }
        return channel
      }

      const coordinator = new CrossTabCoordinator({
        namespace: 'acct',
        callbacks: { onForeignSave, onKeychainInvalidated },
        channelFactory: selfEchoChannelFactory,
        windowRef: new MockWindow() as any,
      })

      coordinator.emitPayloadsSaved(['a'])
      coordinator.emitKeychainChanged()

      jest.useRealTimers()
      await flushMicrotasks()
      jest.useFakeTimers()
      jest.advanceTimersByTime(300)

      expect(onForeignSave).not.toHaveBeenCalled()
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
      expect(coordinator.isLocked()).toBe(false)
    })
  })

  describe('lifecycle', () => {
    it('removes the storage listener and stops reacting after deinit', () => {
      const onKeychainInvalidated = jest.fn()
      const { coordinator, windowRef } = makeCoordinator('keychain', { onKeychainInvalidated })

      coordinator.deinit()
      windowRef.dispatchStorage('keychain')

      expect(onKeychainInvalidated).not.toHaveBeenCalled()
      expect(coordinator.isLocked()).toBe(false)
    })
  })

  describe('degraded mode (no BroadcastChannel)', () => {
    it('still installs the keychain storage-event safety net when no channel is available', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      const coordinator = new CrossTabCoordinator({
        namespace: 'keychain',
        callbacks: { onKeychainInvalidated },
        channelFactory: () => undefined,
        windowRef: windowRef as any,
      })

      // emit is a safe no-op with no channel
      expect(() => coordinator.emitKeychainChanged()).not.toThrow()
      expect(() => coordinator.emitPayloadsSaved(['a'])).not.toThrow()

      // but the storage-event keychain lock still works
      windowRef.dispatchStorage('keychain')
      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })
  })
})
