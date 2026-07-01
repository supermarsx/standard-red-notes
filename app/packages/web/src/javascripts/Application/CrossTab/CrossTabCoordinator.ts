/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Standard Red Notes: CROSS-TAB COORDINATION (multi-tab data-loss/corruption fix).
 *
 * Two tabs of the same account share ONE IndexedDB ('items' store, keyed by uuid) and
 * ONE localStorage ('keychain'). Stock Standard Notes has ZERO cross-tab coordination:
 *
 *   - CRITICAL stale-key corruption: the keychain (root key material) is read into
 *     memory once and never re-checked. If Tab A logs out / rotates the password, the
 *     localStorage 'keychain' is cleared/rotated, but Tab B keeps encrypting+saving
 *     under its STALE in-memory key -> ciphertext that can NEVER be decrypted again.
 *
 *   - HIGH lost write: last `put` wins by uuid in the shared IndexedDB, so Tab B can
 *     silently overwrite Tab A's newer on-disk edit with its own stale in-memory copy.
 *
 * This coordinator is the missing layer. It uses BroadcastChannel as the primary
 * transport and degrades gracefully (no-op emit, storage-event-only keychain safety)
 * when BroadcastChannel is unavailable. It is deliberately self-contained and has NO
 * dependency on snjs services so it can be wired from WebDevice/Database directly.
 *
 * Responsibilities:
 *   1) KEYCHAIN SAFETY (the critical one): detect when ANOTHER tab clears/rotates the
 *      keychain and IMMEDIATELY enter an irreversible-until-reload LOCKED state, so this
 *      tab can never save/encrypt under a stale key. Detection is doubly-sourced: a
 *      window 'storage' event on the 'keychain' key (fires in OTHER tabs only) AND a
 *      BroadcastChannel keychain message we emit on local keychain writes/clears.
 *
 *   2) SAVE INVALIDATION: after a local payload save, emit the saved uuids. On receiving
 *      a peer's saved uuids, mark them stale and (debounced/coalesced) invoke a host
 *      reload hook so this tab reloads the peer's newer disk version instead of later
 *      overwriting it with a stale in-memory copy.
 *
 *   3) Ignore our OWN messages via a per-tab id (single-tab operation is unaffected).
 */

const KEYCHAIN_STORAGE_KEY = 'keychain'
const CHANNEL_PREFIX = 'sn-crosstab-'

/** Coalesce/debounce window for incoming foreign-save invalidations (ms). */
const INVALIDATION_DEBOUNCE_MS = 250

export enum CrossTabMessageType {
  /** A peer saved these uuids to the shared IndexedDB. */
  PayloadsSaved = 'payloads-saved',
  /** A peer changed or cleared the keychain (logout / password rotation). */
  KeychainChanged = 'keychain-changed',
}

type CrossTabMessage =
  | { type: CrossTabMessageType.PayloadsSaved; tabId: string; uuids: string[] }
  | { type: CrossTabMessageType.KeychainChanged; tabId: string }

export interface CrossTabCoordinatorCallbacks {
  /**
   * Invoked (debounced/coalesced) with the set of uuids a peer reported saving, so the
   * host can invalidate its in-memory copies and reload them from IndexedDB. May be
   * async; rejections are swallowed (best-effort reload).
   */
  onForeignSave?: (uuids: string[]) => void | Promise<void>

  /**
   * Invoked exactly once, immediately, the first time a foreign keychain change/clear is
   * detected. The host MUST stop writing/encrypting and reload (or show a "session
   * changed in another tab" state). After this fires the coordinator is permanently
   * LOCKED until the page reloads.
   */
  onKeychainInvalidated?: () => void
}

/**
 * Minimal BroadcastChannel surface we depend on. Declared locally so the module type-checks
 * without DOM lib quirks and so tests can inject a mock.
 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike | undefined

/**
 * Default factory: use the platform BroadcastChannel if present, else undefined (degraded
 * mode -> storage-event-only keychain safety, no save broadcast).
 */
const defaultChannelFactory: BroadcastChannelFactory = (name) => {
  if (typeof BroadcastChannel === 'undefined') {
    return undefined
  }
  try {
    return new BroadcastChannel(name) as unknown as BroadcastChannelLike
  } catch {
    return undefined
  }
}

export interface CrossTabCoordinatorOptions {
  /** Per-workspace namespace (the application identifier) so each account gets its own channel. */
  namespace: string
  callbacks?: CrossTabCoordinatorCallbacks
  /** Injectable for tests; defaults to the platform BroadcastChannel. */
  channelFactory?: BroadcastChannelFactory
  /** Injectable for tests; defaults to window. */
  windowRef?: {
    addEventListener: (type: string, listener: (event: any) => void) => void
    removeEventListener: (type: string, listener: (event: any) => void) => void
    localStorage?: { getItem(key: string): string | null }
  }
}

export class CrossTabCoordinator {
  /** Unique per-tab id used to ignore our own broadcasts. */
  public readonly tabId: string = generateTabId()

  private channel?: BroadcastChannelLike
  private callbacks: CrossTabCoordinatorCallbacks
  private readonly windowRef: NonNullable<CrossTabCoordinatorOptions['windowRef']>

  /**
   * IRREVERSIBLE-UNTIL-RELOAD lock. Set the instant a foreign keychain change is detected.
   * While true, the host must perform NO saves/encryption (see WebDevice.setKeychainValue
   * and Database.savePayloads which both consult isLocked()).
   */
  private keychainLocked = false

  /** Coalesced set of foreign-saved uuids awaiting a debounced reload. */
  private pendingForeignUuids = new Set<string>()
  private invalidationTimer: ReturnType<typeof setTimeout> | undefined

  private storageListener?: (event: any) => void
  private deinited = false

  constructor(options: CrossTabCoordinatorOptions) {
    this.callbacks = options.callbacks ?? {}
    this.windowRef =
      options.windowRef ??
      (typeof window !== 'undefined'
        ? (window as unknown as NonNullable<CrossTabCoordinatorOptions['windowRef']>)
        : noopWindow())

    const factory = options.channelFactory ?? defaultChannelFactory
    this.channel = factory(CHANNEL_PREFIX + options.namespace)
    if (this.channel) {
      this.channel.onmessage = (event) => this.handleMessage(event.data)
    }

    this.installStorageListener()
  }

  public setCallbacks(callbacks: CrossTabCoordinatorCallbacks): void {
    this.callbacks = callbacks
  }

  /**
   * True once a foreign keychain change/clear has been observed. Callers MUST check this
   * before encrypting/saving so they never write under a stale key. Stays true until reload.
   */
  public isLocked(): boolean {
    return this.keychainLocked
  }

  /**
   * Emit that this tab just saved these uuids to the shared IndexedDB. Peers will
   * invalidate+reload them. Safe no-op in degraded mode or when locked.
   */
  public emitPayloadsSaved(uuids: string[]): void {
    if (this.deinited || uuids.length === 0) {
      return
    }
    this.post({ type: CrossTabMessageType.PayloadsSaved, tabId: this.tabId, uuids: [...uuids] })
  }

  /**
   * Emit that this tab changed or cleared the keychain (logout / password rotation). Peers
   * will lock themselves. Safe no-op in degraded mode.
   */
  public emitKeychainChanged(): void {
    if (this.deinited) {
      return
    }
    this.post({ type: CrossTabMessageType.KeychainChanged, tabId: this.tabId })
  }

  public deinit(): void {
    this.deinited = true
    if (this.invalidationTimer) {
      clearTimeout(this.invalidationTimer)
      this.invalidationTimer = undefined
    }
    if (this.storageListener) {
      this.windowRef.removeEventListener('storage', this.storageListener)
      this.storageListener = undefined
    }
    if (this.channel) {
      this.channel.onmessage = null
      try {
        this.channel.close()
      } catch {
        /* already closed */
      }
      this.channel = undefined
    }
    this.pendingForeignUuids.clear()
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private post(message: CrossTabMessage): void {
    if (!this.channel) {
      return
    }
    try {
      this.channel.postMessage(message)
    } catch {
      /* channel may be closing; emit is best-effort */
    }
  }

  private handleMessage(data: unknown): void {
    if (this.deinited || !isCrossTabMessage(data)) {
      return
    }
    // Ignore our OWN broadcasts (BroadcastChannel does not echo to the sender, but a
    // shared-worker/polyfill transport might, and this keeps single-tab operation safe).
    if (data.tabId === this.tabId) {
      return
    }

    if (data.type === CrossTabMessageType.KeychainChanged) {
      this.enterKeychainLock()
      return
    }

    if (data.type === CrossTabMessageType.PayloadsSaved) {
      for (const uuid of data.uuids) {
        this.pendingForeignUuids.add(uuid)
      }
      this.scheduleInvalidationFlush()
    }
  }

  private installStorageListener(): void {
    // The 'storage' event fires ONLY in OTHER tabs/windows of the same origin when
    // localStorage is mutated, which is exactly the foreign keychain-change signal we need.
    // This is the load-bearing safety net even in degraded (no-BroadcastChannel) mode.
    this.storageListener = (event: any) => {
      if (this.deinited) {
        return
      }
      const key = event?.key
      // key === null means localStorage.clear() (e.g. full reset / remove-all-data) which
      // wipes the keychain too, so treat it as a keychain change.
      if (key === KEYCHAIN_STORAGE_KEY || key === null) {
        this.enterKeychainLock()
      }
    }
    this.windowRef.addEventListener('storage', this.storageListener)
  }

  /**
   * Enter the irreversible-until-reload locked state. Fires onKeychainInvalidated exactly
   * once. Called from BOTH the storage event and the BroadcastChannel keychain message, so
   * it must be idempotent.
   */
  private enterKeychainLock(): void {
    if (this.keychainLocked) {
      return
    }
    this.keychainLocked = true
    try {
      this.callbacks.onKeychainInvalidated?.()
    } catch (error) {
      // The host's lock/reload handler must never throw back into the event source.
      console.error('[CrossTabCoordinator] onKeychainInvalidated handler threw', error)
    }
  }

  private scheduleInvalidationFlush(): void {
    if (this.invalidationTimer) {
      return
    }
    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = undefined
      this.flushInvalidations()
    }, INVALIDATION_DEBOUNCE_MS)
  }

  private flushInvalidations(): void {
    if (this.deinited || this.pendingForeignUuids.size === 0) {
      return
    }
    const uuids = [...this.pendingForeignUuids]
    this.pendingForeignUuids.clear()
    try {
      const result = this.callbacks.onForeignSave?.(uuids)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch((error) => {
          console.error('[CrossTabCoordinator] onForeignSave handler rejected', error)
        })
      }
    } catch (error) {
      console.error('[CrossTabCoordinator] onForeignSave handler threw', error)
    }
  }
}

function isCrossTabMessage(data: unknown): data is CrossTabMessage {
  if (!data || typeof data !== 'object') {
    return false
  }
  const candidate = data as Partial<CrossTabMessage>
  if (typeof candidate.tabId !== 'string') {
    return false
  }
  if (candidate.type === CrossTabMessageType.KeychainChanged) {
    return true
  }
  if (candidate.type === CrossTabMessageType.PayloadsSaved) {
    return Array.isArray((candidate as { uuids?: unknown }).uuids)
  }
  return false
}

function generateTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fall through */
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function noopWindow(): NonNullable<CrossTabCoordinatorOptions['windowRef']> {
  return {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}
