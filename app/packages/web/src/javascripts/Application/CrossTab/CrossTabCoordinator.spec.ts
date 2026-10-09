/* eslint-disable @typescript-eslint/no-explicit-any */
import { BroadcastChannelLike, CrossTabCoordinator, CrossTabMessageType } from './CrossTabCoordinator'

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

/**
 * One localStorage per ORIGIN, shared by every tab — the real topology, and the reason the
 * keychain needs cross-tab coordination at all. Tests mutate it the way a peer tab would and
 * then dispatch the 'storage' event that the browser raises in the OTHER tabs.
 */
class SharedOriginStorage {
  public store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

/** Minimal window/localStorage stand-in that lets tests dispatch 'storage' events. */
class MockWindow {
  private listeners: Record<string, Array<(event: any) => void>> = {}

  constructor(public localStorage: SharedOriginStorage = new SharedOriginStorage()) {}

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

/**
 * A representative keychain blob: the per-workspace root key material that
 * WebOrDesktopDevice.setNamespacedKeychainValue persists under the 'keychain' key.
 */
const keychainBlob = (masterKey: string) =>
  JSON.stringify({ 'workspace-a': { version: '004', masterKey, dataAuthenticationKey: 'dak-a' } })

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
      const windowRef = new MockWindow()
      // This tab is signed in: it HOLDS keychain material. A tab that never had any cannot be
      // holding a stale key, so seeding is what makes the scenario reachable at all.
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      expect(coordinator.isLocked()).toBe(false)

      // Another tab removed the 'keychain' key -> storage event fires in THIS tab.
      windowRef.localStorage.removeItem('keychain')
      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('treats a full localStorage.clear() (key === null) that TOOK the keychain as a keychain change', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.localStorage.clear()
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
      const origin = new SharedOriginStorage()
      origin.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator: tabB } = makeCoordinator('keychain', { onKeychainInvalidated }, new MockWindow(origin))
      const { coordinator: tabA } = makeCoordinator('keychain', {}, new MockWindow(origin))

      expect(tabB.isLocked()).toBe(false)

      // Tab A rotates the keychain in the shared origin storage, then broadcasts it.
      origin.setItem('keychain', keychainBlob('mk-2-rotated'))
      tabA.emitKeychainChanged()

      jest.useRealTimers()
      await flushMicrotasks()

      // Tab B is now locked: a host consulting isLocked() before saving will refuse the write.
      expect(tabB.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('fires the lock callback only once even on repeated foreign changes (irreversible-until-reload)', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.localStorage.setItem('keychain', keychainBlob('mk-2'))
      windowRef.dispatchStorage('keychain')
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-3'))
      windowRef.dispatchStorage('keychain')
      windowRef.localStorage.clear()
      windowRef.dispatchStorage(null)

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * The reason this classification exists: the host's reaction to onKeychainInvalidated is
   * `window.location.reload()` (WebDevice.handleForeignKeychainChange), so every signal we
   * accept on no evidence costs a sibling tab its unsaved edits.
   */
  describe('a signal is not evidence of a rotation', () => {
    it('does NOT lock when a keychain storage event reports material identical to what we hold', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      // A peer re-persisted the SAME material (setNamespacedKeychainValue rewrites the whole
      // blob) and the browser raised the event anyway.
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
    })

    it('does NOT lock when the same material comes back with its JSON keys reordered', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem(
        'keychain',
        JSON.stringify({ 'workspace-a': { masterKey: 'mk-1', version: '004' }, 'workspace-b': { masterKey: 'mk-b' } }),
      )
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      // `{ ...keychain, [identifier]: value }` does not preserve key order across a delete.
      windowRef.localStorage.setItem(
        'keychain',
        JSON.stringify({ 'workspace-b': { masterKey: 'mk-b' }, 'workspace-a': { version: '004', masterKey: 'mk-1' } }),
      )
      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
    })

    it('does NOT lock on a localStorage.clear() that took no keychain material away', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      // A tab with no keychain: signed out, or a never-authed share viewer. ApplicationGroup's
      // last-workspace reset calls removeAllRawStorageValues() -> localStorage.clear(), whose
      // `key === null` event reaches every sibling tab.
      windowRef.localStorage.setItem('some-unrelated-key', 'value')
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.localStorage.clear()
      windowRef.dispatchStorage(null)

      expect(coordinator.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
    })

    it('does NOT lock on a peer broadcast whose write left the material identical', async () => {
      const onKeychainInvalidated = jest.fn()
      const origin = new SharedOriginStorage()
      origin.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator: tabB } = makeCoordinator('keychain', { onKeychainInvalidated }, new MockWindow(origin))
      const { coordinator: tabA } = makeCoordinator('keychain', {}, new MockWindow(origin))

      origin.setItem('keychain', keychainBlob('mk-1'))
      tabA.emitKeychainChanged()

      jest.useRealTimers()
      await flushMicrotasks()

      expect(tabB.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
    })

    it('still locks after this tab wrote the keychain itself and a foreign signal then arrives', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      // THIS tab rotates and notifies peers. No 'storage' event is delivered to the writer, so
      // without the re-snapshot in emitKeychainChanged the stale snapshot would make the next
      // (benign) foreign signal look like a rotation.
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-2'))
      coordinator.emitKeychainChanged()

      windowRef.dispatchStorage('keychain')
      expect(coordinator.isLocked()).toBe(false)

      // A genuine foreign rotation on top of our own write still locks.
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-3'))
      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('locks when storage cannot be consulted at all (fail-safe)', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      // A blocked/private context where the accessor is absent.
      ;(windowRef as any).localStorage = undefined
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('locks when reading storage throws (fail-safe)', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      // A blocked/partitioned storage area: the accessor exists but every read throws.
      windowRef.localStorage.getItem = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('locks when the keychain blob is corrupt and then changes, and not while it is stable', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', 'not-json-at-all')
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.dispatchStorage('keychain')
      expect(coordinator.isLocked()).toBe(false)

      windowRef.localStorage.setItem('keychain', 'different-corruption')
      windowRef.dispatchStorage('keychain')
      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })

    it('treats an absent keychain and an empty {} map as the same material', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      windowRef.localStorage.setItem('keychain', '{}')
      windowRef.dispatchStorage('keychain')

      expect(coordinator.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()
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

    it('rejects a KeychainChanged carrying its OWN tabId even when the material really rotated', async () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)
      const peerChannel = MockBus.channelFor('sn-crosstab-keychain')

      // The material genuinely changed, so ONLY the tabId guard can stop the lock here.
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-2-rotated'))

      peerChannel.postMessage({ type: CrossTabMessageType.KeychainChanged, tabId: coordinator.tabId })
      jest.useRealTimers()
      await flushMicrotasks()

      expect(coordinator.isLocked()).toBe(false)
      expect(onKeychainInvalidated).not.toHaveBeenCalled()

      // The same message from any other tab does lock, proving the message itself was live.
      peerChannel.postMessage({ type: CrossTabMessageType.KeychainChanged, tabId: 'some-other-tab' })
      await flushMicrotasks()

      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })
  })

  describe('lifecycle', () => {
    it('removes the storage listener and stops reacting after deinit', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
      const { coordinator } = makeCoordinator('keychain', { onKeychainInvalidated }, windowRef)

      coordinator.deinit()
      windowRef.localStorage.removeItem('keychain')
      windowRef.dispatchStorage('keychain')

      expect(onKeychainInvalidated).not.toHaveBeenCalled()
      expect(coordinator.isLocked()).toBe(false)
    })
  })

  describe('degraded mode (no BroadcastChannel)', () => {
    it('still installs the keychain storage-event safety net when no channel is available', () => {
      const onKeychainInvalidated = jest.fn()
      const windowRef = new MockWindow()
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-1'))
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
      windowRef.localStorage.setItem('keychain', keychainBlob('mk-2-rotated'))
      windowRef.dispatchStorage('keychain')
      expect(coordinator.isLocked()).toBe(true)
      expect(onKeychainInvalidated).toHaveBeenCalledTimes(1)
    })
  })
})
