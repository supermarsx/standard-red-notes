/* eslint-disable @typescript-eslint/no-explicit-any */
import { KEYCHAIN_CROSSTAB_NAMESPACE, WebDevice } from './WebDevice'
import { BroadcastChannelLike, CrossTabCoordinator } from '../CrossTab/CrossTabCoordinator'

/**
 * Standard Red Notes: THE KEYCHAIN RELOAD STORM.
 *
 * `WebDevice.setKeychainValue` used to call `emitKeychainChanged()` on every keychain write,
 * and a peer that receives a keychain change reloads the page
 * (CrossTabCoordinator -> WebDevice.handleForeignKeychainChange -> performSoftReset). Every
 * caller hands over the WHOLE blob — `setNamespacedKeychainValue` reads the map, replaces one
 * entry and writes the map back, and `RootKeyManager.saveRootKeyToKeychain` re-persists the
 * same root key on routine paths — so a write that changed NOTHING reloaded every other tab
 * of the account and threw away whatever it had not yet saved.
 *
 * REAL CONDITIONS. These tests run two `WebDevice`s over the ONE jsdom `localStorage`, which
 * is the actual shared resource, and write through the production writer
 * (`setNamespacedKeychainValue` / `clearRawKeychainValue`) so the on-disk blob cannot drift
 * from what the app really stores. The only things modelled are the two transports jsdom
 * cannot provide:
 *   - the window 'storage' event, delivered to every tab EXCEPT the writer and ONLY when the
 *     stored string actually changed (both are the browser's own rules: HTML's setItem
 *     returns early when oldValue === value, so a byte-identical re-persist raises nothing),
 *   - BroadcastChannel, via a non-echoing in-memory bus.
 *
 * `window.location.reload` is neither stubbable nor observable under jsdom 29, so the reload
 * is pinned in two halves that meet in the middle, as elsewhere in this package: these tests
 * spy on `performSoftReset`, the inherited one-line routine
 * (`WebOrDesktopDevice.performSoftReset -> window.location.reload()`) that
 * handleForeignKeychainChange now calls.
 */

jest.mock('./KeychainEncryption', () => {
  const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8')
  let ivCounter = 0
  return {
    __esModule: true,
    KEYCHAIN_ENC_VERSION: 1,
    isEnvelope: (parsed: any) => typeof parsed === 'object' && parsed !== null && parsed.__srnKeychainEnc !== undefined,
    isWrappingAvailable: jest.fn(async () => true),
    getOrCreateDeviceKey: jest.fn(async () => ({ type: 'mock-crypto-key' })),
    /**
     * A FRESH iv per call, like real AES-GCM. This is what makes a byte comparison of the
     * stored blob useless for deciding whether a wrapped write changed anything, and why
     * setKeychainValue compares decrypted MATERIAL instead.
     */
    encryptKeychain: jest.fn(async (plaintext: string) => ({
      __srnKeychainEnc: 1,
      alg: 'AES-GCM',
      iv: `mock-iv-${++ivCounter}`,
      ct: encode(plaintext),
    })),
    decryptKeychain: jest.fn(async (envelope: any) => decode(envelope.ct)),
    deleteDeviceKey: jest.fn(async () => undefined),
  }
})

import * as KeychainEncryption from './KeychainEncryption'

const mocked = KeychainEncryption as jest.Mocked<typeof KeychainEncryption>

const KEYCHAIN_STORAGE_KEY = 'keychain'
const originalLockManager = navigator.locks

/** Drives the fresh-per-call iv the re-installed encrypt mock hands back. */
let ivCounter = 0

/** Root key material in the shape `RootKey.getKeychainValue()` produces. */
const rootKeyFor = (masterKey: string) => ({
  version: '004',
  masterKey,
  dataAuthenticationKey: `dak-${masterKey}`,
})

const installImmediateLockManager = () => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> =>
        Promise.resolve(callback({ name, mode: 'exclusive' } as Lock)),
    },
  })
}

/** Non-echoing BroadcastChannel bus: a real channel never delivers to its own sender. */
class Bus {
  private channels = new Map<string, Set<BusChannel>>()

  channel(name: string): BusChannel {
    const peers = this.channels.get(name) ?? new Set<BusChannel>()
    this.channels.set(name, peers)
    const channel = new BusChannel(peers)
    peers.add(channel)
    return channel
  }
}

class BusChannel implements BroadcastChannelLike {
  public onmessage: ((event: { data: unknown }) => void) | null = null
  private closed = false

  constructor(private peers: Set<BusChannel>) {}

  postMessage(message: unknown): void {
    if (this.closed) {
      return
    }
    for (const peer of this.peers) {
      if (peer === this || peer.closed) {
        continue
      }
      void Promise.resolve().then(() => peer.onmessage?.({ data: message }))
    }
  }

  close(): void {
    this.closed = true
    this.peers.delete(this)
  }
}

/** One tab's window: its own 'storage' listeners over the one real origin localStorage. */
class TabWindow {
  private listeners: Array<(event: any) => void> = []
  public localStorage = window.localStorage

  addEventListener(type: string, listener: (event: any) => void): void {
    if (type === 'storage') {
      this.listeners.push(listener)
    }
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners = this.listeners.filter((entry) => entry !== listener)
  }

  dispatchStorage(key: string | null): void {
    for (const listener of [...this.listeners]) {
      listener({ key })
    }
  }
}

class TabDevice extends WebDevice {
  constructor(
    private tabWindow: TabWindow,
    private bus: Bus,
    private wrapping: boolean,
  ) {
    super('test-version')
  }

  protected override createCrossTabCoordinator(): CrossTabCoordinator {
    return new CrossTabCoordinator({
      namespace: KEYCHAIN_CROSSTAB_NAMESPACE,
      callbacks: {
        onKeychainInvalidated: () => (this as any).handleForeignKeychainChange(),
      },
      channelFactory: (name) => this.bus.channel(name),
      windowRef: this.tabWindow as any,
    })
  }

  protected override isWrappingEnabled(): boolean {
    return this.wrapping
  }
}

type Tab = { window: TabWindow; device: TabDevice; reloads: jest.SpyInstance }

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

class Origin {
  public readonly tabs: Tab[] = []
  private bus = new Bus()

  constructor(private wrapping = false) {}

  /** Open a tab. Its coordinator snapshots the keychain NOW, as a real tab does on load. */
  open(): Tab {
    const tabWindow = new TabWindow()
    const device = new TabDevice(tabWindow, this.bus, this.wrapping)
    const reloads = jest.spyOn(device, 'performSoftReset').mockResolvedValue(undefined)
    device.getCrossTabCoordinator()
    const tab: Tab = { window: tabWindow, device, reloads }
    this.tabs.push(tab)
    return tab
  }

  /**
   * Run a keychain write in `writer` and then deliver the signals a browser would: the
   * 'storage' event to the OTHER tabs, and only if the stored string really changed.
   */
  async write(writer: Tab, operation: () => Promise<void>): Promise<{ before: string | null; after: string | null }> {
    const before = localStorage.getItem(KEYCHAIN_STORAGE_KEY)
    await operation()
    const after = localStorage.getItem(KEYCHAIN_STORAGE_KEY)

    if (before !== after) {
      for (const tab of this.tabs) {
        if (tab !== writer) {
          tab.window.dispatchStorage(KEYCHAIN_STORAGE_KEY)
        }
      }
    }

    // Let the BroadcastChannel messages land.
    await flushMicrotasks()

    return { before, after }
  }

  /** A full `localStorage.clear()`, which raises a `key === null` event in every other tab. */
  async clearAllStorage(writer: Tab): Promise<void> {
    localStorage.clear()
    for (const tab of this.tabs) {
      if (tab !== writer) {
        tab.window.dispatchStorage(null)
      }
    }
    await flushMicrotasks()
  }

  deinit(): void {
    for (const tab of this.tabs) {
      tab.device.deinit()
    }
  }
}

describe('keychain writes must not reload sibling tabs unless the keychain really rotated', () => {
  let errorSpy: jest.SpyInstance
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    installImmediateLockManager()
    ;(mocked.isWrappingAvailable as jest.Mock).mockImplementation(async () => true)
    ;(mocked.getOrCreateDeviceKey as jest.Mock).mockImplementation(async () => ({ type: 'mock-crypto-key' }))
    ;(mocked.encryptKeychain as jest.Mock).mockImplementation(async (plaintext: string) => ({
      __srnKeychainEnc: 1,
      alg: 'AES-GCM',
      // A FRESH iv per call, like real AES-GCM.
      iv: `mock-iv-${++ivCounter}`,
      ct: Buffer.from(plaintext, 'utf8').toString('base64'),
    }))
    ;(mocked.decryptKeychain as jest.Mock).mockImplementation(async (envelope: any) =>
      Buffer.from(envelope.ct, 'base64').toString('utf8'),
    )
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLockManager })
  })

  describe('plaintext keychain (the SHIPPED configuration — wrapping flag OFF)', () => {
    it('does NOT reload a sibling tab when a peer re-persists the SAME root key', async () => {
      // Both tabs are signed in to workspace-a, which is the operator's situation.
      const origin = new Origin()
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      const tabA = origin.open()
      const tabB = origin.open()
      tabA.reloads.mockClear()
      tabB.reloads.mockClear()

      // The production writer, re-persisting exactly the material already on disk: this is
      // what RootKeyManager.saveRootKeyToKeychain does on routine paths.
      const { before, after } = await origin.write(tabA, () =>
        tabA.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      expect(after).toBe(before)
      expect(tabB.reloads).not.toHaveBeenCalled()
      expect(tabB.device.isKeychainLocked()).toBe(false)
      expect(tabA.reloads).not.toHaveBeenCalled()
      // The material is still intact and readable in the sibling tab.
      expect(await tabB.device.getNamespacedKeychainValue('workspace-a' as any)).toEqual(rootKeyFor('mk-1'))

      origin.deinit()
    })

    it('DOES reload a sibling tab when a peer rotates the root key', async () => {
      const origin = new Origin()
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      const tabA = origin.open()
      const tabB = origin.open()
      tabA.reloads.mockClear()
      tabB.reloads.mockClear()

      await origin.write(tabA, () =>
        tabA.device.setNamespacedKeychainValue(rootKeyFor('mk-2-rotated') as any, 'workspace-a' as any),
      )

      expect(tabB.reloads).toHaveBeenCalledTimes(1)
      expect(tabB.device.isKeychainLocked()).toBe(true)
      // And the sibling now refuses to persist anything under its stale in-memory key.
      await expect(
        tabB.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      ).rejects.toThrow(/another tab/)
      expect(tabA.reloads).not.toHaveBeenCalled()

      origin.deinit()
    })

    it('does NOT reload a sibling tab when the same material arrives with its JSON keys in another order', async () => {
      // A blob written by an older build (or any other code path) orders the entry's fields
      // differently from what RootKey.getKeychainValue() emits today.
      const reordered = JSON.stringify({
        'workspace-a': { dataAuthenticationKey: 'dak-mk-1', masterKey: 'mk-1', version: '004' },
      })
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, reordered)

      const origin = new Origin()
      const tabA = origin.open()
      const tabB = origin.open()

      const { after } = await origin.write(tabA, () =>
        tabA.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      // Byte-different, materially identical: no write, no signal, no reload.
      expect(after).toBe(reordered)
      expect(tabB.reloads).not.toHaveBeenCalled()
      expect(tabB.device.isKeychainLocked()).toBe(false)

      origin.deinit()
    })

    it('does NOT reload a sibling tab that holds no keychain when a peer wipes all of localStorage', async () => {
      // The ApplicationGroup amplifier: a last-workspace sign-out runs clearAllDataFromDevice,
      // whose removeAllRawStorageValues() -> localStorage.clear() raises `key === null` in
      // every sibling tab. A tab with no keychain material (signed out, or a never-authed
      // share viewer) has no stale key and must not be reloaded.
      localStorage.setItem('some-unrelated-app-key', 'value')

      const origin = new Origin()
      const tabA = origin.open()
      const tabB = origin.open()

      await origin.write(tabA, () => tabA.device.clearRawKeychainValue())
      await origin.clearAllStorage(tabA)

      expect(tabB.reloads).not.toHaveBeenCalled()
      expect(tabB.device.isKeychainLocked()).toBe(false)

      origin.deinit()
    })

    it('DOES reload a sibling tab when a peer signs out and the keychain really goes away', async () => {
      const origin = new Origin()
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      const tabA = origin.open()
      const tabB = origin.open()
      tabB.reloads.mockClear()

      await origin.write(tabA, () => tabA.device.clearRawKeychainValue())

      expect(tabB.reloads).toHaveBeenCalledTimes(1)
      expect(tabB.device.isKeychainLocked()).toBe(true)

      origin.deinit()
    })

    it('DOES reload a sibling tab when a peer removes another workspace it was also holding', async () => {
      const origin = new Origin()
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-a') as any, 'workspace-a' as any),
      )
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-b') as any, 'workspace-b' as any),
      )

      const tabA = origin.open()
      const tabB = origin.open()
      tabB.reloads.mockClear()

      await origin.write(tabA, () => tabA.device.clearNamespacedKeychainValue('workspace-b' as any))

      // Conservative by design: the keychain coordinator is per-ORIGIN and does not know which
      // workspace each tab is using, so losing ANY entry still locks. The comparison only ever
      // suppresses the reload on proof that nothing moved.
      expect(tabB.reloads).toHaveBeenCalledTimes(1)

      origin.deinit()
    })
  })

  describe('wrapped-at-rest keychain (staged-rollout flag ON)', () => {
    it('does NOT reload a sibling tab on a re-persist, even though re-encryption would change every byte', async () => {
      const origin = new Origin(true)
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )
      const envelope = localStorage.getItem(KEYCHAIN_STORAGE_KEY)
      expect(JSON.parse(envelope as string).__srnKeychainEnc).toBe(1)

      const tabA = origin.open()
      const tabB = origin.open()
      tabB.reloads.mockClear()

      const encryptCallsBefore = (mocked.encryptKeychain as jest.Mock).mock.calls.length
      const { after } = await origin.write(tabA, () =>
        tabA.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      // Not re-encrypted at all, so the ciphertext (and therefore every peer's view of the
      // blob) is unchanged.
      expect((mocked.encryptKeychain as jest.Mock).mock.calls.length).toBe(encryptCallsBefore)
      expect(after).toBe(envelope)
      expect(tabB.reloads).not.toHaveBeenCalled()

      origin.deinit()
    })

    it('DOES write and signal when the stored envelope cannot be decrypted', async () => {
      const origin = new Origin(true)
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )
      const envelope = localStorage.getItem(KEYCHAIN_STORAGE_KEY)

      const tabA = origin.open()
      const tabB = origin.open()
      tabB.reloads.mockClear()

      // The device key is gone (IndexedDB cleared): the stored material is unknowable, so it
      // can never be "identical" and the repair write must go through.
      ;(mocked.getOrCreateDeviceKey as jest.Mock).mockRejectedValue(new Error('key gone'))

      await origin.write(tabA, () => tabA.device.setRawKeychainValue({ 'workspace-a': rootKeyFor('mk-1') } as any))

      expect(localStorage.getItem(KEYCHAIN_STORAGE_KEY)).not.toBe(envelope)
      expect(tabB.reloads).toHaveBeenCalledTimes(1)

      origin.deinit()
    })

    it('still clears an undecryptable envelope down to an empty map', async () => {
      const origin = new Origin(true)
      const seed = origin.open()
      await origin.write(seed, () =>
        seed.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )
      const envelope = localStorage.getItem(KEYCHAIN_STORAGE_KEY)

      const tabA = origin.open()

      // Sign-out over a keychain we cannot read: `{}` must still be written, or key material
      // nobody can decrypt is left behind forever.
      ;(mocked.decryptKeychain as jest.Mock).mockRejectedValue(new Error('GCM auth failed'))
      await origin.write(tabA, () => tabA.device.setRawKeychainValue({} as any))

      const stored = localStorage.getItem(KEYCHAIN_STORAGE_KEY)
      expect(stored).not.toBe(envelope)
      ;(mocked.decryptKeychain as jest.Mock).mockImplementation(async (wrapped: any) =>
        Buffer.from(wrapped.ct, 'base64').toString('utf8'),
      )
      expect(await tabA.device.getKeychainValue()).toEqual({})

      origin.deinit()
    })
  })

  describe('corrupt storage', () => {
    it('still writes over a non-JSON keychain blob rather than mistaking it for identical material', async () => {
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, '{not-valid-json')

      const origin = new Origin()
      const tabA = origin.open()
      const tabB = origin.open()

      await origin.write(tabA, () =>
        tabA.device.setNamespacedKeychainValue(rootKeyFor('mk-1') as any, 'workspace-a' as any),
      )

      expect(JSON.parse(localStorage.getItem(KEYCHAIN_STORAGE_KEY) as string)).toEqual({
        'workspace-a': rootKeyFor('mk-1'),
      })
      expect(tabB.reloads).toHaveBeenCalledTimes(1)

      origin.deinit()
    })

    it('still clears a non-JSON keychain blob down to an empty map', async () => {
      localStorage.setItem(KEYCHAIN_STORAGE_KEY, '{not-valid-json')

      const origin = new Origin()
      const tabA = origin.open()

      await origin.write(tabA, () => tabA.device.setRawKeychainValue({} as any))

      expect(localStorage.getItem(KEYCHAIN_STORAGE_KEY)).toBe('{}')

      origin.deinit()
    })
  })

  describe('a write that genuinely changes nothing is not even attempted', () => {
    it('leaves an absent keychain absent when an empty map is persisted over it', async () => {
      const origin = new Origin()
      const tabA = origin.open()
      const tabB = origin.open()

      await origin.write(tabA, () => tabA.device.setRawKeychainValue({} as any))

      // An absent key and `{}` are the same thing to every reader (getKeychainValue returns
      // `{}` for both), so there is nothing here for a peer to react to.
      expect(localStorage.getItem(KEYCHAIN_STORAGE_KEY)).toBeNull()
      expect(tabB.reloads).not.toHaveBeenCalled()

      origin.deinit()
    })

    it('never passes a value it cannot canonicalize off as unchanged', async () => {
      // A value JSON cannot represent (here a BigInt) canonicalizes to nothing. It must not
      // land in the "nothing changed, skip the write" branch alongside an absent keychain —
      // that is the `undefined === undefined` shape that makes a comparison look like it is
      // working. The write is attempted and fails loudly on the same JSON.stringify it always
      // did, rather than being silently dropped.
      const origin = new Origin()
      const tabA = origin.open()

      await expect(tabA.device.setRawKeychainValue({ 'workspace-a': { masterKey: BigInt(1) } } as any)).rejects.toThrow(
        /BigInt/,
      )
      expect(localStorage.getItem(KEYCHAIN_STORAGE_KEY)).toBeNull()

      origin.deinit()
    })
  })
})
