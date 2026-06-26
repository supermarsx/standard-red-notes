import { ConflictParams, ConflictType, HttpRequest } from '@standardnotes/responses'
import { AccountSyncOperation } from '@Lib/Services/Sync/Account/Operation'
import {
  LoggerInterface,
  Uuids,
  extendArray,
  isNotUndefined,
  isNullOrUndefined,
  removeFromIndex,
  sleep,
  subtractFromArray,
} from '@standardnotes/utils'
import { ItemManager } from '@Lib/Services/Items/ItemManager'
import { OfflineSyncOperation } from '@Lib/Services/Sync/Offline/Operation'
import { PayloadManager } from '../Payloads/PayloadManager'
import { LegacyApiService } from '../Api/ApiService'
import { HistoryManager } from '../History/HistoryManager'
import { SNLog } from '@Lib/Log'
import { SessionManager } from '../Session/SessionManager'
import { DiskStorageService } from '../Storage/DiskStorageService'
import { SyncPromise } from './Types'
import { ServerSyncResponse } from '@Lib/Services/Sync/Account/Response'
import { ServerSyncResponseResolver } from '@Lib/Services/Sync/Account/ResponseResolver'
import { SyncSignal, SyncStats } from '@Lib/Services/Sync/Signals'
import { UuidString } from '../../Types/UuidString'
import {
  PayloadSource,
  CreateDecryptedItemFromPayload,
  FilterDisallowedRemotePayloadsAndMap,
  DeltaOutOfSync,
  ImmutablePayloadCollection,
  CreatePayload,
  isEncryptedPayload,
  isDecryptedPayload,
  EncryptedPayloadInterface,
  DecryptedPayloadInterface,
  ItemsKeyContent,
  FullyFormedPayloadInterface,
  DeletedPayloadInterface,
  DecryptedPayload,
  CreateEncryptedServerSyncPushPayload,
  ServerSyncPushContextualPayload,
  isDeletedItem,
  DeletedItemInterface,
  DecryptedItemInterface,
  CreatePayloadSplit,
  CreateDeletedServerSyncPushPayload,
  ItemsKeyInterface,
  CreateNonDecryptedPayloadSplit,
  DeltaOfflineSaved,
  FilteredServerItem,
  PayloadEmitSource,
  getIncrementedDirtyIndex,
  getCurrentDirtyIndex,
  ItemContent,
  KeySystemItemsKeyContent,
  KeySystemItemsKeyInterface,
  FullyFormedTransferPayload,
  ItemMutator,
  isDecryptedOrDeletedItem,
  MutationType,
  assertNoLitePayloads,
  createLitePayloadFromDecrypted,
} from '@standardnotes/models'
import {
  AbstractService,
  SyncEvent,
  SyncSource,
  InternalEventHandlerInterface,
  InternalEventBusInterface,
  StorageKey,
  InternalEventInterface,
  IntegrityEvent,
  IntegrityEventPayload,
  SyncMode,
  SyncOptions,
  SyncQueueStrategy,
  SyncServiceInterface,
  EncryptionService,
  DeviceInterface,
  isFullEntryLoadChunkResponse,
  isChunkFullEntry,
  SyncEventReceivedSharedVaultInvitesData,
  SyncEventReceivedRemoteSharedVaultsData,
  SyncEventReceivedNotificationsData,
  SyncEventReceivedAsymmetricMessagesData,
  SyncOpStatus,
  ApplicationSyncOptions,
  WebSocketsServiceEvent,
  WebSocketsService,
  SyncBackoffServiceInterface,
  SyncItemsPushedData,
} from '@standardnotes/services'
import { OfflineSyncResponse } from './Offline/Response'
import {
  CreateDecryptionSplitWithKeyLookup,
  CreateEncryptionSplitWithKeyLookup,
  KeyedDecryptionSplit,
  SplitPayloadsByEncryptionType,
} from '@standardnotes/encryption'
import { CreatePayloadFromRawServerItem } from './Account/Utilities'
import { DecryptedServerConflictMap, TrustedServerConflictMap } from './Account/ServerConflictMap'
import { ContentType } from '@standardnotes/domain-core'
import { SyncFrequencyGuardInterface } from './SyncFrequencyGuardInterface'

const DEFAULT_MAJOR_CHANGE_THRESHOLD = 15
const INVALID_SESSION_RESPONSE_STATUS = 401
const TOO_MANY_REQUESTS_RESPONSE_STATUS = 429
const DEFAULT_AUTO_SYNC_INTERVAL = 30_000

/**
 * Exponential backoff parameters for auto-retrying after consecutive sync failures.
 * The delay grows as base * (multiplier ^ failures), capped, plus jitter to avoid
 * thundering-herd reconnect storms. This only governs the AUTO-RETRY-AFTER-FAILURE
 * cadence — user-driven and normal syncs are unaffected.
 */
const FAILURE_BACKOFF_BASE_MS = 1_000
const FAILURE_BACKOFF_MULTIPLIER = 2
const FAILURE_BACKOFF_CAP_MS = 5 * 60_000
const FAILURE_BACKOFF_JITTER_RATIO = 0.25

/** Minimum gap between focus/visibility-triggered "sync ASAP" requests, to avoid focus-spam. */
const FOCUS_SYNC_THROTTLE_MS = 5_000

/** Content types appearing first are always mapped first */
const ContentTypeLocalLoadPriorty = [
  ContentType.TYPES.ItemsKey,
  ContentType.TYPES.KeySystemRootKey,
  ContentType.TYPES.KeySystemItemsKey,
  ContentType.TYPES.VaultListing,
  ContentType.TYPES.TrustedContact,
  ContentType.TYPES.UserPrefs,
  ContentType.TYPES.Component,
  ContentType.TYPES.Theme,
]

/**
 * The sync service orchestrates with the model manager, api service, and storage service
 * to ensure consistent state between the three. When a change is made to an item, consumers
 * call the sync service's sync function to first persist pending changes to local storage.
 * Then, the items are uploaded to the server. The sync service handles server responses,
 * including mapping any retrieved items to application state via model manager mapping.
 * After each sync request, any changes made or retrieved are also persisted locally.
 * The sync service largely does not perform any task unless it is called upon.
 */
export class SyncService
  extends AbstractService<SyncEvent>
  implements SyncServiceInterface, InternalEventHandlerInterface
{
  private dirtyIndexAtLastPresyncSave?: number
  private lastSyncDate?: Date
  private outOfSync = false
  private opStatus: SyncOpStatus

  private resolveQueue: SyncPromise[] = []
  private spawnQueue: SyncPromise[] = []

  /* A DownloadFirst sync must always be the first sync completed */
  public completedOnlineDownloadFirstSync = false

  private majorChangeThreshold = DEFAULT_MAJOR_CHANGE_THRESHOLD
  private clientLocked = false
  private databaseLoaded = false

  private syncToken?: string
  private cursorToken?: string

  private syncLock = false
  private _simulate_latency?: { latency: number; enabled: boolean }
  private dealloced = false

  public lastSyncInvokationPromise?: Promise<unknown>
  public currentSyncRequestPromise?: Promise<void>

  private autoSyncInterval?: NodeJS.Timeout
  private wasNotifiedOfItemsChangeOnServer = false

  /**
   * Manual Sync mode. When true, AUTOMATIC syncs are suppressed and only an explicit
   * user-initiated sync runs. Defaults to false (normal automatic syncing). Local
   * persistence/offline behavior is unaffected by this flag — only the automatic
   * NETWORK sync is gated. Set via setManualSyncMode() by the web app when the pref changes.
   */
  private manualSyncMode = false

  /** Number of consecutive failed sync attempts. Reset on any successful sync or network return. */
  private consecutiveFailureCount = 0
  /** Pending exponential-backoff auto-retry timer (only set while in a failure-retry loop). */
  private failureBackoffTimeout?: NodeJS.Timeout
  /** Timestamp of the last focus/visibility-triggered sync, for throttling. */
  private lastFocusSyncAt = 0
  /** Bound window listeners, retained so they can be removed on deinit. */
  private removeWindowListeners?: () => void

  constructor(
    private itemManager: ItemManager,
    private sessionManager: SessionManager,
    private encryptionService: EncryptionService,
    private storageService: DiskStorageService,
    private payloadManager: PayloadManager,
    private apiService: LegacyApiService,
    private historyService: HistoryManager,
    private device: DeviceInterface,
    private identifier: string,
    private readonly options: ApplicationSyncOptions,
    private logger: LoggerInterface,
    private sockets: WebSocketsService,
    private syncFrequencyGuard: SyncFrequencyGuardInterface,
    private syncBackoffService: SyncBackoffServiceInterface,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
    this.opStatus = this.initializeStatus()
    this.registerNetworkAvailabilityListeners()
  }

  /**
   * Sync ASAP when the environment becomes available again: when the browser comes back
   * online, and when the tab regains focus/visibility (pull latest after the user returns).
   * Guarded for headless (node/mcp) environments where `window` is undefined.
   */
  private registerNetworkAvailabilityListeners(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return
    }

    const onOnline = () => {
      this.logger.debug('Network came back online, syncing ASAP and resetting backoff')
      this.cancelFailureBackoff()
      this.consecutiveFailureCount = 0
      void this.sync({ source: SyncSource.NetworkReturned, sourceDescription: 'Browser online event' })
    }

    const onFocusOrVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }

      const now = Date.now()
      if (now - this.lastFocusSyncAt < FOCUS_SYNC_THROTTLE_MS) {
        return
      }
      this.lastFocusSyncAt = now

      this.logger.debug('App regained focus/visibility, syncing to pull latest')
      this.cancelFailureBackoff()
      void this.sync({ source: SyncSource.NetworkReturned, sourceDescription: 'App focus/visibility' })
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onFocusOrVisible)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onFocusOrVisible)
    }

    this.removeWindowListeners = () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onFocusOrVisible)
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onFocusOrVisible)
      }
    }
  }

  /** Cancel any pending failure-backoff auto-retry so it doesn't delay a fresher sync. */
  private cancelFailureBackoff(): void {
    if (this.failureBackoffTimeout) {
      clearTimeout(this.failureBackoffTimeout)
      this.failureBackoffTimeout = undefined
    }
  }

  /**
   * Schedule the next auto-retry after a failed sync using exponential backoff with jitter,
   * capped. Only one retry may be pending at a time; a successful/user-driven sync clears it.
   */
  private scheduleFailureBackoffRetry(): void {
    this.cancelFailureBackoff()

    if (this.dealloced) {
      return
    }

    const exponent = Math.max(0, this.consecutiveFailureCount - 1)
    const rawDelay = FAILURE_BACKOFF_BASE_MS * Math.pow(FAILURE_BACKOFF_MULTIPLIER, exponent)
    const cappedDelay = Math.min(rawDelay, FAILURE_BACKOFF_CAP_MS)
    const jitter = cappedDelay * FAILURE_BACKOFF_JITTER_RATIO * Math.random()
    const delay = Math.round(cappedDelay + jitter)

    this.logger.debug(`Scheduling sync backoff retry #${this.consecutiveFailureCount} in ${delay}ms`)

    this.failureBackoffTimeout = setTimeout(() => {
      this.failureBackoffTimeout = undefined
      if (this.dealloced) {
        return
      }
      void this.sync({ source: SyncSource.BackoffRetry, sourceDescription: 'Failure backoff retry' })
    }, delay)
  }

  /**
   * A network sync attempt failed. Increment the consecutive-failure counter and schedule a
   * single exponential-backoff auto-retry. This deliberately does NOT immediately re-fire a
   * sync, avoiding a tight failure loop.
   */
  private handleOnlineSyncFailure(): void {
    this.consecutiveFailureCount += 1
    this.logger.debug(`Online sync failed (consecutive failures: ${this.consecutiveFailureCount})`)
    this.scheduleFailureBackoffRetry()
  }

  /** A network sync succeeded. Reset the failure counter and cancel any pending backoff retry. */
  private handleOnlineSyncSuccess(): void {
    if (this.consecutiveFailureCount > 0) {
      this.logger.debug('Sync recovered, resetting failure backoff')
    }
    this.consecutiveFailureCount = 0
    this.cancelFailureBackoff()
  }

  /**
   * Single decision seam for what to do once an online sync attempt finishes. Kept pure and
   * dependency-free (beyond the failure/success handlers) so it can be unit-tested in isolation.
   *
   * - A failed ONLINE attempt increments the consecutive-failure counter and schedules a
   *   backoff retry.
   * - A successful ONLINE attempt resets the counter and cancels any pending retry.
   * - Offline (no-server) attempts are intentionally ignored: a benign offline save must not
   *   trip the online backoff loop.
   *
   * Returns whether a backoff retry was scheduled, primarily for testability.
   */
  applyOnlineSyncResult(hasError: boolean, online: boolean): boolean {
    if (!online) {
      return false
    }

    if (hasError) {
      this.handleOnlineSyncFailure()
      return true
    }

    this.handleOnlineSyncSuccess()
    return false
  }

  /**
   * If the database has been newly created (because its new or was previously destroyed)
   * we want to reset any sync tokens we have.
   */
  public async onNewDatabaseCreated(): Promise<void> {
    if (await this.getLastSyncToken()) {
      await this.clearSyncPositionTokens()
    }
  }

  private get launchPriorityUuids() {
    return this.storageService.getValue<string[]>(StorageKey.LaunchPriorityUuids) ?? []
  }

  public setLaunchPriorityUuids(launchPriorityUuids: string[]) {
    this.storageService.setValue(StorageKey.LaunchPriorityUuids, launchPriorityUuids)
  }

  public override deinit(): void {
    this.dealloced = true
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval)
    }
    this.cancelFailureBackoff()
    if (this.removeWindowListeners) {
      this.removeWindowListeners()
      this.removeWindowListeners = undefined
    }
    ;(this.autoSyncInterval as unknown) = undefined
    ;(this.sessionManager as unknown) = undefined
    ;(this.itemManager as unknown) = undefined
    ;(this.encryptionService as unknown) = undefined
    ;(this.payloadManager as unknown) = undefined
    ;(this.storageService as unknown) = undefined
    ;(this.apiService as unknown) = undefined
    this.opStatus.reset()
    ;(this.opStatus as unknown) = undefined
    this.resolveQueue.length = 0
    this.spawnQueue.length = 0
    super.deinit()
  }

  private initializeStatus() {
    return new SyncOpStatus(setInterval, (event) => {
      void this.notifyEvent(event)
    })
  }

  public lockSyncing(): void {
    this.clientLocked = true
  }

  public unlockSyncing(): void {
    this.clientLocked = false
  }

  public isOutOfSync(): boolean {
    return this.outOfSync
  }

  public getLastSyncDate(): Date | undefined {
    return this.lastSyncDate
  }

  public getSyncStatus(): SyncOpStatus {
    return this.opStatus
  }

  /**
   * Enable/disable Manual Sync mode. When enabled, automatic syncs are suppressed; the
   * user must explicitly trigger a sync (sync({ isUserInitiated: true })). This only gates
   * the automatic NETWORK sync — items are still persisted locally and offline behavior is
   * unchanged. Toggling the mode off does not itself sync; callers that want to flush
   * pending changes should request a user-initiated sync afterward.
   */
  public setManualSyncMode(enabled: boolean): void {
    this.logger.debug(`Setting manual sync mode to ${enabled}`)
    this.manualSyncMode = enabled
  }

  public isManualSyncModeEnabled(): boolean {
    return this.manualSyncMode
  }

  /**
   * The set of automatic sync sources that Manual Sync mode suppresses. These are the
   * triggers that fire WITHOUT direct user action:
   *  - External: item-change-triggered syncs (and other ambient callers) — but note that a
   *    user-initiated sync also uses External, so it is distinguished by `isUserInitiated`.
   *  - NetworkReturned: online/focus/visibility "sync ASAP".
   *  - BackoffRetry: the post-failure auto-retry loop.
   *
   * Continuation sources of an already-permitted sync (ResolveQueue, SpawnQueue,
   * MoreDirtyItems, AfterDownloadFirst, DownloadFirst, IntegrityCheck, ResolveOutOfSync)
   * are intentionally NOT in this set: once a user-initiated sync is underway it must be
   * allowed to run to completion and reconcile correctly.
   */
  private static AutomaticSyncSources: ReadonlySet<SyncSource> = new Set([
    SyncSource.External,
    SyncSource.NetworkReturned,
    SyncSource.BackoffRetry,
  ])

  /**
   * Decide whether a sync request should be suppressed because Manual Sync mode is on.
   * A request is suppressed only when ALL of the following hold:
   *  - manual mode is enabled,
   *  - it is not explicitly user-initiated,
   *  - and its source is one of the ambient/automatic sources above.
   *
   * Kept dependency-free so it can be unit-tested in isolation.
   */
  shouldSuppressAutomaticSync(options: SyncOptions): boolean {
    if (!this.manualSyncMode) {
      return false
    }

    if (options.isUserInitiated) {
      return false
    }

    return SyncService.AutomaticSyncSources.has(options.source)
  }

  /**
   * Called by application when sign in or registration occurs.
   */
  public resetSyncState(): void {
    this.dirtyIndexAtLastPresyncSave = undefined
    this.lastSyncDate = undefined
    this.outOfSync = false
  }

  public isDatabaseLoaded(): boolean {
    return this.databaseLoaded
  }

  private async processPriorityItemsForDatabaseLoad(items: FullyFormedPayloadInterface[]): Promise<void> {
    if (items.length === 0) {
      return
    }

    const encryptedPayloads = items.filter(isEncryptedPayload)
    const alreadyDecryptedPayloads = items.filter(isDecryptedPayload) as DecryptedPayloadInterface<ItemsKeyContent>[]

    const encryptionSplit = SplitPayloadsByEncryptionType(encryptedPayloads)
    const decryptionSplit = CreateDecryptionSplitWithKeyLookup(encryptionSplit)

    const newlyDecryptedPayloads = await this.encryptionService.decryptSplit(decryptionSplit)

    await this.payloadManager.emitPayloads(
      [...alreadyDecryptedPayloads, ...newlyDecryptedPayloads],
      PayloadEmitSource.LocalDatabaseLoaded,
    )
  }

  public async loadDatabasePayloads(): Promise<void> {
    this.logger.debug('Loading database payloads')

    if (this.databaseLoaded) {
      throw 'Attempting to initialize already initialized local database.'
    }

    const chunks = await this.device.getDatabaseLoadChunks(
      {
        batchSize: this.options.loadBatchSize,
        contentTypePriority: ContentTypeLocalLoadPriorty,
        uuidPriority: this.launchPriorityUuids,
      },
      this.identifier,
    )

    const itemsKeyEntries = isFullEntryLoadChunkResponse(chunks)
      ? chunks.fullEntries.itemsKeys.entries
      : await this.device.getDatabaseEntries(this.identifier, chunks.keys.itemsKeys.keys)

    const keySystemRootKeyEntries = isFullEntryLoadChunkResponse(chunks)
      ? chunks.fullEntries.keySystemRootKeys.entries
      : await this.device.getDatabaseEntries(this.identifier, chunks.keys.keySystemRootKeys.keys)

    const keySystemItemsKeyEntries = isFullEntryLoadChunkResponse(chunks)
      ? chunks.fullEntries.keySystemItemsKeys.entries
      : await this.device.getDatabaseEntries(this.identifier, chunks.keys.keySystemItemsKeys.keys)

    const createPayloadFromEntry = (entry: FullyFormedTransferPayload) => {
      try {
        return CreatePayload(entry, PayloadSource.LocalDatabaseLoaded)
      } catch (e) {
        console.error('Creating payload failed', e)
        return undefined
      }
    }

    await this.processPriorityItemsForDatabaseLoad(itemsKeyEntries.map(createPayloadFromEntry).filter(isNotUndefined))
    await this.processPriorityItemsForDatabaseLoad(
      keySystemRootKeyEntries.map(createPayloadFromEntry).filter(isNotUndefined),
    )
    await this.processPriorityItemsForDatabaseLoad(
      keySystemItemsKeyEntries.map(createPayloadFromEntry).filter(isNotUndefined),
    )

    /**
     * Map in batches to give interface a chance to update. Note that total decryption
     * time is constant regardless of batch size. Decrypting 3000 items all at once or in
     * batches will result in the same time spent. It's the emitting/painting/rendering
     * that requires batch size optimization.
     */
    const payloadCount = chunks.remainingChunksItemCount
    let totalProcessedCount = 0

    const remainingChunks = isFullEntryLoadChunkResponse(chunks)
      ? chunks.fullEntries.remainingChunks
      : chunks.keys.remainingChunks

    let chunkIndex = 0
    const ChunkIndexOfContentTypePriorityItems = 0

    for (const chunk of remainingChunks) {
      const dbEntries = isChunkFullEntry(chunk)
        ? chunk.entries
        : await this.device.getDatabaseEntries(this.identifier, chunk.keys)
      const payloads = dbEntries
        .map((entry) => {
          try {
            return CreatePayload(entry, PayloadSource.LocalDatabaseLoaded)
          } catch (e) {
            console.error('Creating payload failed', e)
            return undefined
          }
        })
        .filter(isNotUndefined)

      await this.processPayloadBatch(payloads, totalProcessedCount, payloadCount)

      const shouldSleepOnlyAfterFirstRegularBatch = chunkIndex > ChunkIndexOfContentTypePriorityItems
      if (shouldSleepOnlyAfterFirstRegularBatch) {
        await sleep(this.options.sleepBetweenBatches, false, 'Sleeping to allow interface to update')
      }

      totalProcessedCount += payloads.length
      chunkIndex++
    }

    this.databaseLoaded = true
    this.opStatus.setDatabaseLoadStatus(0, 0, true)
  }

  beginAutoSyncTimer(): void {
    this.autoSyncInterval = setInterval(this.autoSync.bind(this), DEFAULT_AUTO_SYNC_INTERVAL)
  }

  private autoSync(): void {
    if (this.manualSyncMode) {
      this.logger.debug('Manual sync mode is on; skipping periodic auto sync')
      return
    }

    if (!this.sockets.isWebSocketConnectionOpen()) {
      this.logger.debug('WebSocket connection is closed, doing autosync')

      void this.sync({ sourceDescription: 'Auto Sync' })

      return
    }

    if (this.wasNotifiedOfItemsChangeOnServer) {
      this.logger.debug('Was notified of items changed on server, doing autosync')

      this.wasNotifiedOfItemsChangeOnServer = false

      void this.sync({ sourceDescription: 'WebSockets Event - Items Changed On Server' })
    }
  }

  private async processPayloadBatch(
    batch: FullyFormedPayloadInterface<ItemContent>[],
    currentPosition?: number,
    payloadCount?: number,
  ) {
    this.logger.debug('Processing batch at index', currentPosition, 'length', batch.length)
    const encrypted: EncryptedPayloadInterface[] = []
    const nonencrypted: (DecryptedPayloadInterface | DeletedPayloadInterface)[] = []

    for (const payload of batch) {
      if (isEncryptedPayload(payload)) {
        encrypted.push(payload)
      } else {
        nonencrypted.push(payload)
      }
    }

    const encryptionSplit = SplitPayloadsByEncryptionType(encrypted)
    const decryptionSplit = CreateDecryptionSplitWithKeyLookup(encryptionSplit)

    const results = await this.encryptionService.decryptSplit(decryptionSplit)

    /**
     * LAZY-DECRYPT (flag-gated): on the cold-load path, extract metadata then DISCARD bulky
     * bodies (note `text`) so resident heap tracks the working set, not the whole corpus. The
     * resulting "lite" payloads are NEVER dirty and are refused by every mutation/sync seam;
     * full content is re-hydrated on demand via getFullContent(uuid). With the flag off this is
     * a pure pass-through (byte-identical behavior).
     */
    const emittable = this.maybeStripBodiesForLazyDecrypt(results)

    await this.payloadManager.emitPayloads([...nonencrypted, ...emittable], PayloadEmitSource.LocalDatabaseLoaded)

    void this.notifyEvent(SyncEvent.LocalDataIncrementalLoad)

    if (currentPosition != undefined && payloadCount != undefined) {
      this.opStatus.setDatabaseLoadStatus(currentPosition, payloadCount, false)
    }
  }

  /**
   * Flag-gated lazy-decrypt strip. For each freshly decrypted payload on the cold-load path,
   * if it is a note (the only content type carrying a bulky body), replace it with a
   * content-stripped ("lite") payload that retains the metadata projection but discards `text`.
   * Non-note payloads and already-non-decrypted payloads pass through untouched.
   *
   * SAFETY: lite payloads are produced ONLY here, ONLY when the flag is on, and are never
   * dirty. They are never persisted/ejected/synced; full content is re-hydrated on demand.
   *
   * @returns the (possibly stripped) payloads to emit into in-memory state.
   */
  private maybeStripBodiesForLazyDecrypt(
    payloads: (DecryptedPayloadInterface | DeletedPayloadInterface | EncryptedPayloadInterface)[],
  ): (DecryptedPayloadInterface | DeletedPayloadInterface | EncryptedPayloadInterface)[] {
    if (!this.options.lazyDecryptEnabled) {
      return payloads
    }

    return payloads.map((payload) => {
      if (!isDecryptedPayload(payload)) {
        return payload
      }

      if (payload.content_type !== ContentType.TYPES.Note) {
        return payload
      }

      return createLitePayloadFromDecrypted(payload)
    })
  }

  /**
   * RE-HYDRATION ENTRY POINT for lazy-decrypt. Reads the raw encrypted payload for `uuid` from
   * the local database (IndexedDB via the device interface), decrypts it, and returns the
   * FULL decrypted payload with its body intact. Used by the consumer points (editor open,
   * markdown export, search-index build, revisions/links) to obtain `text` on demand.
   *
   * Returns undefined if the item is not found on disk or cannot be decrypted (e.g. waiting on
   * key). Callers should fall back to the in-memory (possibly lite) payload in that case.
   *
   * SAFETY: the returned payload is NOT dirty and is intended for read-only consumption. To
   * mutate, callers must emit it back into state first (so the collection holds full content)
   * and then mutate, OR mutate via the application's standard change path after re-hydration.
   */
  public async getFullContentPayload(uuid: string): Promise<DecryptedPayloadInterface | undefined> {
    const entries = await this.device.getDatabaseEntries(this.identifier, [uuid])
    if (!entries || entries.length === 0) {
      return undefined
    }

    const rawPayload = (() => {
      try {
        return CreatePayload(entries[0], PayloadSource.LocalDatabaseLoaded)
      } catch (e) {
        this.logger.error('getFullContentPayload: failed to create payload', String(e))
        return undefined
      }
    })()

    if (!rawPayload) {
      return undefined
    }

    if (isDecryptedPayload(rawPayload)) {
      return rawPayload
    }

    if (!isEncryptedPayload(rawPayload)) {
      return undefined
    }

    const encryptionSplit = SplitPayloadsByEncryptionType([rawPayload])
    const decryptionSplit = CreateDecryptionSplitWithKeyLookup(encryptionSplit)
    const results = await this.encryptionService.decryptSplit(decryptionSplit)

    const decrypted = results[0]
    if (decrypted && isDecryptedPayload(decrypted)) {
      return decrypted
    }

    return undefined
  }

  private setLastSyncToken(token: string) {
    this.syncToken = token
    return this.storageService.setValue(StorageKey.LastSyncToken, token)
  }

  private async setPaginationToken(token: string) {
    this.cursorToken = token
    if (token) {
      return this.storageService.setValue(StorageKey.PaginationToken, token)
    } else {
      return this.storageService.removeValue(StorageKey.PaginationToken)
    }
  }

  private async getLastSyncToken(): Promise<string> {
    if (!this.syncToken) {
      this.syncToken = (await this.storageService.getValue(StorageKey.LastSyncToken)) as string
    }
    return this.syncToken
  }

  private async getPaginationToken(): Promise<string> {
    if (!this.cursorToken) {
      this.cursorToken = (await this.storageService.getValue(StorageKey.PaginationToken)) as string
    }
    return this.cursorToken
  }

  private async clearSyncPositionTokens() {
    this.syncToken = undefined
    this.cursorToken = undefined
    await this.storageService.removeValue(StorageKey.LastSyncToken)
    await this.storageService.removeValue(StorageKey.PaginationToken)
  }

  private itemsNeedingSync() {
    const dirtyItems = this.itemManager.getDirtyItems()

    /**
     * SAFETY TRIPWIRE: a content-stripped (lite) item must never be dirty. If one ever appears
     * in the dirty set it indicates the invariant was broken upstream; refuse rather than risk
     * syncing a body-less payload. (In normal operation a lite payload is never dirty, so this
     * never throws.)
     */
    assertNoLitePayloads(
      dirtyItems.map((item) => item.payload),
      'SyncService.itemsNeedingSync',
    )

    const itemsWithoutBackoffPenalty = dirtyItems.filter((item) => !this.syncBackoffService.isItemInBackoff(item))

    return SyncService.excludeLocalOnlyItems(itemsWithoutBackoffPenalty)
  }

  /**
   * Removes "local only" items from a set of dirty items so they are never included in the
   * sync upload set (and thus never leave the device). This is the single, safe seam where
   * local-only exclusion is enforced.
   *
   * Pure and static so it can be unit-tested in isolation.
   *
   * IMPORTANT SAFETY NOTES:
   * - Excluded items are still persisted to the local database by the normal pre-sync save
   *   path (they remain dirty until persisted), so they survive reloads.
   * - Only DECRYPTED items can carry the `localOnly` flag (it lives in decrypted appData).
   *   Deleted items are intentionally NOT filtered: a local-only item that is deleted still
   *   needs its local removal to proceed, and a deleted item that was previously synced must
   *   still be able to push its deletion to the server.
   */
  static excludeLocalOnlyItems(
    items: (DecryptedItemInterface | DeletedItemInterface)[],
  ): (DecryptedItemInterface | DeletedItemInterface)[] {
    return items.filter((item) => {
      if (isDeletedItem(item)) {
        return true
      }
      return item.localOnly !== true
    })
  }

  public async markAllItemsAsNeedingSyncAndPersist(): Promise<void> {
    this.logger.debug('Marking all items as needing sync')

    const items = this.itemManager.items
    const payloads = items.map((item) => {
      return new DecryptedPayload({
        ...item.payload.ejected(),
        dirty: true,
        dirtyIndex: getIncrementedDirtyIndex(),
      })
    })

    await this.payloadManager.emitPayloads(payloads, PayloadEmitSource.LocalChanged)

    /**
     * When signing into an 003 account (or an account that is not the latest), the temporary items key will be 004
     * and will not match user account version, triggering a key not found exception. This error resolves once the
     * download first sync completes and the correct key is downloaded. We suppress any persistence
     * exceptions here to avoid showing an error to the user.
     */
    const hidePersistErrorDueToWaitingOnKeyDownload = true
    await this.persistPayloads(payloads, { throwError: !hidePersistErrorDueToWaitingOnKeyDownload })
  }

  /**
   * Return the payloads that need local persistence, before beginning a sync.
   * This way, if the application is closed before a sync request completes,
   * pending data will be saved to disk, and synced the next time the app opens.
   */
  private popPayloadsNeedingPreSyncSave(from: (DecryptedPayloadInterface | DeletedPayloadInterface)[]) {
    const lastPreSyncSave = this.dirtyIndexAtLastPresyncSave
    if (lastPreSyncSave == undefined) {
      return from
    }

    const payloads = from.filter((candidate) => {
      return !candidate.dirtyIndex || candidate.dirtyIndex > lastPreSyncSave
    })

    this.dirtyIndexAtLastPresyncSave = getCurrentDirtyIndex()

    return payloads
  }

  private queueStrategyResolveOnNext(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.resolveQueue.push({ resolve, reject })
    })
  }

  private queueStrategyForceSpawnNew(options: SyncOptions) {
    return new Promise((resolve, reject) => {
      this.spawnQueue.push({ resolve, reject, options })
    })
  }

  /**
   * For timing strategy SyncQueueStrategy.ForceSpawnNew, we will execute a whole sync request
   * and pop it from the queue.
   */
  private popSpawnQueue() {
    if (this.spawnQueue.length === 0) {
      return null
    }

    const promise = this.spawnQueue[0]
    removeFromIndex(this.spawnQueue, 0)
    this.logger.debug('Syncing again from spawn queue')

    return this.sync({
      queueStrategy: SyncQueueStrategy.ForceSpawnNew,
      source: SyncSource.SpawnQueue,
      ...promise.options,
    })
      .then(() => {
        promise.resolve()
      })
      .catch(() => {
        promise.reject()
      })
  }

  private async payloadsByPreparingForServer(
    payloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[],
  ): Promise<ServerSyncPushContextualPayload[]> {
    /**
     * FINAL SAFETY SEAM before encryption + server push. A content-stripped (lite) payload must
     * NEVER reach here: encrypting and uploading a body-less payload would irreversibly
     * overwrite the real ciphertext on the server. This throws to abort the entire sync rather
     * than risk data loss. This is intentionally unconditional (independent of the feature
     * flag) so the invariant holds even if a lite payload is produced unexpectedly.
     */
    assertNoLitePayloads(payloads, 'SyncService.payloadsByPreparingForServer')

    const payloadSplit = CreatePayloadSplit(payloads)

    const encryptionSplit = SplitPayloadsByEncryptionType(payloadSplit.decrypted)

    const keyLookupSplit = CreateEncryptionSplitWithKeyLookup(encryptionSplit)

    const encryptedResults = await this.encryptionService.encryptSplit(keyLookupSplit)

    const contextPayloads = [
      ...encryptedResults.map(CreateEncryptedServerSyncPushPayload),
      ...payloadSplit.deleted.map(CreateDeletedServerSyncPushPayload),
    ]

    return contextPayloads
  }

  public async downloadFirstSync(waitTimeOnFailureMs: number, otherSyncOptions?: Partial<SyncOptions>): Promise<void> {
    const maxTries = 5

    for (let i = 0; i < maxTries; i++) {
      await this.sync({
        mode: SyncMode.DownloadFirst,
        queueStrategy: SyncQueueStrategy.ForceSpawnNew,
        source: SyncSource.External,
        ...otherSyncOptions,
      }).catch(console.error)

      if (this.completedOnlineDownloadFirstSync) {
        return
      } else {
        await sleep(waitTimeOnFailureMs)
      }
    }

    console.error(`Failed downloadFirstSync after ${maxTries} tries`)
  }

  public async awaitCurrentSyncs(): Promise<void> {
    await this.lastSyncInvokationPromise
    await this.currentSyncRequestPromise
  }

  public async sync(options: Partial<SyncOptions> = {}): Promise<unknown> {
    if (this.clientLocked) {
      this.logger.debug('Sync locked by client')
      return
    }

    const fullyResolvedOptions: SyncOptions = {
      source: SyncSource.External,
      ...options,
    }

    /**
     * Manual Sync mode: suppress AUTOMATIC syncs. Pending changes have already been (or will
     * be) persisted locally through the normal item/persist path, so nothing is lost — the
     * change simply doesn't go to the server until the user explicitly syncs. A
     * user-initiated sync (isUserInitiated) and all continuation sources bypass this gate.
     */
    if (this.shouldSuppressAutomaticSync(fullyResolvedOptions)) {
      this.logger.debug(
        'Manual sync mode is on; suppressing automatic sync',
        SyncSource[fullyResolvedOptions.source],
        fullyResolvedOptions.sourceDescription,
      )
      return
    }

    /**
     * Any fresh sync request other than the backoff retry itself should bypass/cancel a
     * pending backoff timer, so a real (e.g. user-driven) sync isn't delayed by it. The
     * retry's own scheduled invocation keeps its timer logic intact.
     */
    if (fullyResolvedOptions.source !== SyncSource.BackoffRetry) {
      this.cancelFailureBackoff()
    }

    this.lastSyncInvokationPromise = this.performSync(fullyResolvedOptions)
    return this.lastSyncInvokationPromise
  }

  private async prepareForSync(options: SyncOptions) {
    const items = this.itemsNeedingSync()

    /**
     * Freeze the begin date immediately after getting items needing sync. This way an
     * item dirtied at any point after this date is marked as needing another sync
     */
    const beginDate = new Date()
    const frozenDirtyIndex = getCurrentDirtyIndex()

    /**
     * Items that have never been synced and marked as deleted should not be
     * uploaded to server, and instead deleted directly after sync completion.
     */
    const neverSyncedDeleted: DeletedItemInterface[] = items.filter((item) => {
      return item.neverSynced && isDeletedItem(item)
    }) as DeletedItemInterface[]

    subtractFromArray(items, neverSyncedDeleted)

    const decryptedPayloads = items.map((item) => {
      return item.payloadRepresentation()
    })

    const payloadsNeedingSave = this.popPayloadsNeedingPreSyncSave(decryptedPayloads)

    const hidePersistErrorDueToWaitingOnKeyDownload = options.mode === SyncMode.DownloadFirst
    await this.persistPayloads(payloadsNeedingSave, { throwError: !hidePersistErrorDueToWaitingOnKeyDownload })

    if (options.onPresyncSave) {
      options.onPresyncSave()
    }

    return { items, beginDate, frozenDirtyIndex, neverSyncedDeleted }
  }

  /**
   * Allows us to lock this function from triggering duplicate network requests.
   * There are two types of locking checks:
   * 1. syncLocked(): If a call to sync() call has begun preparing to be sent to the server.
   *                  but not yet completed all the code below before reaching that point.
   *                  (before reaching opStatus.setDidBegin).
   * 2. syncOpInProgress: If a sync() call is in flight to the server.
   */
  private configureSyncLock(options: SyncOptions) {
    const syncInProgress = this.opStatus.syncInProgress
    const databaseLoaded = this.databaseLoaded
    const canExecuteSync = !this.syncLock
    const syncLimitReached = this.syncFrequencyGuard.isSyncCallsThresholdReachedThisMinute()
    const shouldExecuteSync = canExecuteSync && databaseLoaded && !syncInProgress && !syncLimitReached

    if (shouldExecuteSync) {
      this.syncLock = true
    } else {
      this.logger.debug(
        !canExecuteSync
          ? 'Another function call has begun preparing for sync.'
          : syncInProgress
            ? 'Attempting to sync while existing sync in progress.'
            : 'Attempting to sync before local database has loaded.',
        options,
      )
    }

    const releaseLock = () => {
      this.syncLock = false
    }

    return { shouldExecuteSync, releaseLock }
  }

  private deferSyncRequest(options: SyncOptions) {
    const useStrategy = !isNullOrUndefined(options.queueStrategy)
      ? options.queueStrategy
      : SyncQueueStrategy.ResolveOnNext

    if (useStrategy === SyncQueueStrategy.ResolveOnNext) {
      return this.queueStrategyResolveOnNext()
    } else if (useStrategy === SyncQueueStrategy.ForceSpawnNew) {
      return this.queueStrategyForceSpawnNew(options)
    } else {
      throw Error('Unhandled timing strategy')
    }
  }

  private async prepareForSyncExecution(
    items: (DecryptedItemInterface | DeletedItemInterface)[],
    inTimeResolveQueue: SyncPromise[],
    beginDate: Date,
    frozenDirtyIndex: number,
  ) {
    this.opStatus.setDidBegin()

    await this.notifyEvent(SyncEvent.SyncDidBeginProcessing)

    /**
     * Subtract from array as soon as we're sure they'll be called.
     * resolves are triggered at the end of this function call
     */
    subtractFromArray(this.resolveQueue, inTimeResolveQueue)

    /**
     * lastSyncBegan must be set *after* any point we may have returned above.
     * Setting this value means the item was 100% sent to the server.
     */
    if (items.length > 0) {
      return this.setLastSyncBeganForItems(items, beginDate, frozenDirtyIndex)
    } else {
      return items
    }
  }

  private async setLastSyncBeganForItems(
    itemsToLookupUuidsFor: (DecryptedItemInterface | DeletedItemInterface)[],
    date: Date,
    globalDirtyIndex: number,
  ): Promise<(DecryptedItemInterface | DeletedItemInterface)[]> {
    const uuids = Uuids(itemsToLookupUuidsFor)

    const items = this.itemManager.getCollection().findAll(uuids).filter(isDecryptedOrDeletedItem)

    const payloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[] = []

    for (const item of items) {
      const mutator = new ItemMutator<DecryptedPayloadInterface | DeletedPayloadInterface>(
        item,
        MutationType.NonDirtying,
      )

      mutator.setBeginSync(date, globalDirtyIndex)

      const payload = mutator.getResult()

      payloads.push(payload)
    }

    await this.payloadManager.emitPayloads(payloads, PayloadEmitSource.PreSyncSave)

    return this.itemManager.findAnyItems(uuids) as (DecryptedItemInterface | DeletedItemInterface)[]
  }

  /**
   * The InTime resolve queue refers to any sync requests that were made while we still
   * have not sent out the current request. So, anything in the InTime resolve queue
   * will have made it "in time" to piggyback on the current request. Anything that comes
   * after InTime will schedule a new sync request.
   */
  private getPendingRequestsMadeInTimeToPiggyBackOnCurrentRequest() {
    return this.resolveQueue.slice()
  }

  private getOfflineSyncParameters(
    payloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[],
    mode: SyncMode = SyncMode.Default,
  ): {
    uploadPayloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[]
  } {
    const uploadPayloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[] =
      mode === SyncMode.Default ? payloads : []

    return { uploadPayloads }
  }

  private createOfflineSyncOperation(
    payloads: (DeletedPayloadInterface | DecryptedPayloadInterface)[],
    options: SyncOptions,
  ) {
    this.logger.debug(
      'Syncing offline user',
      'source:',
      SyncSource[options.source],
      'sourceDesc',
      options.sourceDescription,
      'mode:',
      options.mode && SyncMode[options.mode],
      'payloads:',
      payloads,
    )

    const operation = new OfflineSyncOperation(payloads, async (type, response) => {
      if (this.dealloced) {
        return
      }
      if (type === SyncSignal.Response && response) {
        await this.handleOfflineResponse(response)
      }
    })

    return operation
  }

  private async getOnlineSyncParameters(
    payloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[],
    mode: SyncMode = SyncMode.Default,
  ): Promise<{
    uploadPayloads: ServerSyncPushContextualPayload[]
    syncMode: SyncMode
  }> {
    const useMode = !this.completedOnlineDownloadFirstSync ? SyncMode.DownloadFirst : mode

    if (useMode === SyncMode.Default && !this.completedOnlineDownloadFirstSync) {
      throw Error('Attempting to default mode sync without having completed initial.')
    }

    const isReadOnlySession = this.sessionManager.isCurrentSessionReadOnly()
    if (isReadOnlySession) {
      this.logger.debug('Skipping upload payloads because session is read-only.')
      return { uploadPayloads: [], syncMode: useMode }
    }

    const uploadPayloads: ServerSyncPushContextualPayload[] =
      useMode === SyncMode.Default ? await this.payloadsByPreparingForServer(payloads) : []

    return { uploadPayloads, syncMode: useMode }
  }

  private async createServerSyncOperation(
    payloads: ServerSyncPushContextualPayload[],
    options: SyncOptions,
    mode: SyncMode = SyncMode.Default,
  ) {
    const syncToken =
      options.sharedVaultUuids && options.sharedVaultUuids.length > 0 && options.syncSharedVaultsFromScratch
        ? undefined
        : await this.getLastSyncToken()
    const paginationToken =
      options.sharedVaultUuids && options.syncSharedVaultsFromScratch ? undefined : await this.getPaginationToken()

    const operation = new AccountSyncOperation(
      payloads,
      async (type: SyncSignal, response?: ServerSyncResponse, stats?: SyncStats) => {
        switch (type) {
          case SyncSignal.Response:
            if (this.dealloced) {
              return
            }
            if (response?.hasError) {
              this.handleErrorServerResponse(response)
            } else if (response) {
              await this.handleSuccessServerResponse(operation, response)
            }
            break
          case SyncSignal.StatusChanged:
            if (stats) {
              this.opStatus.setUploadStatus(stats.completedUploadCount, stats.totalUploadCount)
            }
            break
        }
      },
      this.apiService,
      {
        syncToken,
        paginationToken,
        sharedVaultUuids: options.sharedVaultUuids,
      },
    )

    this.logger.debug(
      'Syncing online user',
      'source',
      SyncSource[options.source],
      'operation id',
      operation.id,
      'integrity check',
      options.checkIntegrity,
      'mode',
      SyncMode[mode],
      'syncToken',
      syncToken,
      'cursorToken',
      paginationToken,
      'payloads',
      payloads,
    )

    return operation
  }

  private async createSyncOperation(
    payloads: (DecryptedPayloadInterface | DeletedPayloadInterface)[],
    online: boolean,
    options: SyncOptions,
  ): Promise<{ operation: AccountSyncOperation | OfflineSyncOperation; mode: SyncMode }> {
    if (online) {
      const { uploadPayloads, syncMode } = await this.getOnlineSyncParameters(payloads, options.mode)

      return {
        operation: await this.createServerSyncOperation(uploadPayloads, options, syncMode),
        mode: syncMode,
      }
    } else {
      const { uploadPayloads } = this.getOfflineSyncParameters(payloads, options.mode)

      return {
        operation: this.createOfflineSyncOperation(uploadPayloads, options),
        mode: options.mode || SyncMode.Default,
      }
    }
  }

  private async performSync(options: SyncOptions): Promise<unknown> {
    const { shouldExecuteSync, releaseLock } = this.configureSyncLock(options)

    const { items, beginDate, frozenDirtyIndex, neverSyncedDeleted } = await this.prepareForSync(options)
    const shouldSkipUploadsForReadOnlySession = this.sessionManager.isCurrentSessionReadOnly() === true

    if (options.mode === SyncMode.LocalOnly) {
      this.logger.debug('Syncing local only, skipping remote sync request')
      releaseLock()
      return
    }

    const inTimeResolveQueue = this.getPendingRequestsMadeInTimeToPiggyBackOnCurrentRequest()

    if (!shouldExecuteSync) {
      return this.deferSyncRequest(options)
    }

    if (this.dealloced) {
      return
    }

    const latestItems = await this.prepareForSyncExecution(
      shouldSkipUploadsForReadOnlySession ? [] : items,
      inTimeResolveQueue,
      beginDate,
      frozenDirtyIndex,
    )

    if (shouldSkipUploadsForReadOnlySession && items.length > 0) {
      this.logger.debug('Read-only session detected, skipping upload of dirty items.')
    }

    const online = this.sessionManager.online()

    const { operation, mode: syncMode } = await this.createSyncOperation(
      latestItems.map((i) => i.payloadRepresentation()),
      online,
      options,
    )

    const operationPromise = operation.run()

    this.currentSyncRequestPromise = operationPromise

    await operationPromise

    if (this.dealloced) {
      return
    }

    releaseLock()

    const { hasError } = await this.handleSyncOperationFinish(operation, options, neverSyncedDeleted, syncMode)

    this.applyOnlineSyncResult(hasError, online)

    if (hasError) {
      return
    }

    const didSyncAgain = await this.potentiallySyncAgainAfterSyncCompletion(
      syncMode,
      options,
      inTimeResolveQueue,
      online,
    )
    if (didSyncAgain) {
      return
    }

    if (options.checkIntegrity && online) {
      await this.notifyEventSync(SyncEvent.SyncRequestsIntegrityCheck, {
        source: options.source as SyncSource,
      })
    }

    await this.notifyEventSync(SyncEvent.SyncCompletedWithAllItemsUploadedAndDownloaded, {
      source: options.source,
      options,
    })

    this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)

    return undefined
  }

  async getRawSyncRequestForExternalUse(
    items: (DecryptedItemInterface | DeletedItemInterface)[],
  ): Promise<HttpRequest | undefined> {
    if (this.dealloced) {
      return
    }

    const online = this.sessionManager.online()

    if (!online) {
      return
    }

    const payloads = await this.payloadsByPreparingForServer(items.map((i) => i.payloadRepresentation()))
    const syncToken = await this.getLastSyncToken()
    const paginationToken = await this.getPaginationToken()

    return this.apiService.getSyncHttpRequest(payloads, syncToken, paginationToken, 150)
  }

  private async handleOfflineResponse(response: OfflineSyncResponse) {
    this.logger.debug('Offline Sync Response', response)

    const masterCollection = this.payloadManager.getMasterCollection()

    const delta = new DeltaOfflineSaved(masterCollection, response.savedPayloads)

    const emit = delta.result()

    const payloadsToPersist = await this.payloadManager.emitDeltaEmit(emit)

    await this.persistPayloads(payloadsToPersist)

    this.opStatus.clearError()

    await this.notifyEvent(SyncEvent.PaginatedSyncRequestCompleted, response)
  }

  private handleErrorServerResponse(response: ServerSyncResponse) {
    this.logger.debug('Sync Error', response)

    if (response.status === INVALID_SESSION_RESPONSE_STATUS) {
      void this.notifyEvent(SyncEvent.InvalidSession)
    }

    if (response.status === TOO_MANY_REQUESTS_RESPONSE_STATUS) {
      void this.notifyEvent(SyncEvent.TooManyRequests)
    }

    this.opStatus?.setError(response.error)

    void this.notifyEvent(SyncEvent.SyncError, response)
  }

  private async handleSuccessServerResponse(operation: AccountSyncOperation, response: ServerSyncResponse) {
    if (this._simulate_latency) {
      await sleep(this._simulate_latency.latency)
    }

    this.opStatus.clearError()

    this.opStatus.setDownloadStatus(response.retrievedPayloads.length)

    const masterCollection = this.payloadManager.getMasterCollection()

    const historyMap = this.historyService.getHistoryMapCopy()

    if (response.userEvents && response.userEvents.length > 0) {
      await this.notifyEventSync(
        SyncEvent.ReceivedNotifications,
        response.userEvents as SyncEventReceivedNotificationsData,
      )
    }

    if (response.asymmetricMessages && response.asymmetricMessages.length > 0) {
      await this.notifyEventSync(
        SyncEvent.ReceivedAsymmetricMessages,
        response.asymmetricMessages as SyncEventReceivedAsymmetricMessagesData,
      )
    }

    if (response.vaults && response.vaults.length > 0) {
      await this.notifyEventSync(
        SyncEvent.ReceivedRemoteSharedVaults,
        response.vaults as SyncEventReceivedRemoteSharedVaultsData,
      )
    }

    if (response.vaultInvites && response.vaultInvites.length > 0) {
      await this.notifyEventSync(
        SyncEvent.ReceivedSharedVaultInvites,
        response.vaultInvites as SyncEventReceivedSharedVaultInvitesData,
      )
    }

    const resolver = new ServerSyncResponseResolver(
      {
        retrievedPayloads: await this.processServerPayloads(response.retrievedPayloads, PayloadSource.RemoteRetrieved),
        savedPayloads: response.savedPayloads,
        conflicts: await this.decryptServerConflicts(response.conflicts),
      },
      masterCollection,
      operation.payloadsSavedOrSaving,
      historyMap,
    )

    this.logger.debug(
      'Online Sync Response',
      'Operator ID',
      operation.id,
      response.rawResponse.data,
      'Decrypted payloads',
      resolver['payloadSet'],
    )

    const emits = resolver.result()

    for (const emit of emits) {
      const payloadsToPersist = await this.payloadManager.emitDeltaEmit(emit)

      await this.persistPayloads(payloadsToPersist)
    }

    if (!operation.options.sharedVaultUuids) {
      await Promise.all([
        this.setLastSyncToken(response.lastSyncToken as string),
        this.setPaginationToken(response.paginationToken as string),
      ])
    }

    await this.notifyEvent(SyncEvent.PaginatedSyncRequestCompleted, {
      ...response,
      uploadedPayloads: operation.payloads,
      options: operation.options,
    })
  }

  private async decryptServerConflicts(conflictMap: TrustedServerConflictMap): Promise<DecryptedServerConflictMap> {
    const decrypted: DecryptedServerConflictMap = {}

    for (const conflictType of Object.keys(conflictMap)) {
      const conflictsForType = conflictMap[conflictType as ConflictType]
      if (!conflictsForType) {
        continue
      }

      if (!decrypted[conflictType as ConflictType]) {
        decrypted[conflictType as ConflictType] = []
      }

      const decryptedConflictsForType = decrypted[conflictType as ConflictType]
      if (!decryptedConflictsForType) {
        throw Error('Decrypted conflicts for type should exist')
      }

      for (const conflict of conflictsForType) {
        const decryptedUnsavedItem = conflict.unsaved_item
          ? await this.processServerPayload(conflict.unsaved_item, PayloadSource.RemoteRetrieved)
          : undefined

        const decryptedServerItem = conflict.server_item
          ? await this.processServerPayload(conflict.server_item, PayloadSource.RemoteRetrieved)
          : undefined

        const decryptedEntry: ConflictParams<FullyFormedPayloadInterface> = <
          ConflictParams<FullyFormedPayloadInterface>
        >{
          type: conflict.type,
          unsaved_item: decryptedUnsavedItem,
          server_item: decryptedServerItem,
        }

        decryptedConflictsForType.push(decryptedEntry)
      }
    }

    return decrypted
  }

  private async processServerPayload(
    item: FilteredServerItem,
    source: PayloadSource,
  ): Promise<FullyFormedPayloadInterface> {
    const result = await this.processServerPayloads([item], source)

    return result[0]
  }

  private async processServerPayloads(
    items: FilteredServerItem[],
    source: PayloadSource,
  ): Promise<FullyFormedPayloadInterface[]> {
    const payloads = items
      .map((i) => {
        const result = CreatePayloadFromRawServerItem(i, source)
        return result.isFailed() ? undefined : result.getValue()
      })
      .filter(isNotUndefined)

    const { encrypted, deleted } = CreateNonDecryptedPayloadSplit(payloads)

    const results: FullyFormedPayloadInterface[] = [...deleted]

    const { rootKeyEncryption, itemsKeyEncryption, keySystemRootKeyEncryption } =
      SplitPayloadsByEncryptionType(encrypted)

    const { results: rootKeyDecryptionResults, map: processedItemsKeys } = await this.decryptServerItemsKeys(
      rootKeyEncryption || [],
    )

    extendArray(results, rootKeyDecryptionResults)

    const { results: keySystemRootKeyDecryptionResults, map: processedKeySystemItemsKeys } =
      await this.decryptServerKeySystemItemsKeys(keySystemRootKeyEncryption || [])

    extendArray(results, keySystemRootKeyDecryptionResults)

    if (itemsKeyEncryption) {
      const decryptionResults = await this.decryptProcessedServerPayloads(itemsKeyEncryption, {
        ...processedItemsKeys,
        ...processedKeySystemItemsKeys,
      })
      extendArray(results, decryptionResults)
    }

    return results
  }

  private async decryptServerItemsKeys(payloads: EncryptedPayloadInterface[]) {
    const map: Record<UuidString, DecryptedPayloadInterface<ItemsKeyContent>> = {}

    if (payloads.length === 0) {
      return {
        results: [],
        map,
      }
    }

    const rootKeySplit: KeyedDecryptionSplit = {
      usesRootKeyWithKeyLookup: {
        items: payloads,
      },
    }

    const results = await this.encryptionService.decryptSplit<ItemsKeyContent>(rootKeySplit)

    results.forEach((result) => {
      if (isDecryptedPayload<ItemsKeyContent>(result) && result.content_type === ContentType.TYPES.ItemsKey) {
        map[result.uuid] = result
      }
    })

    return {
      results,
      map,
    }
  }

  private async decryptServerKeySystemItemsKeys(payloads: EncryptedPayloadInterface[]) {
    const map: Record<UuidString, DecryptedPayloadInterface<KeySystemItemsKeyContent>> = {}

    if (payloads.length === 0) {
      return {
        results: [],
        map,
      }
    }

    const keySystemRootKeySplit: KeyedDecryptionSplit = {
      usesKeySystemRootKeyWithKeyLookup: {
        items: payloads,
      },
    }

    const results = await this.encryptionService.decryptSplit<KeySystemItemsKeyContent>(keySystemRootKeySplit)

    results.forEach((result) => {
      if (
        isDecryptedPayload<KeySystemItemsKeyContent>(result) &&
        result.content_type === ContentType.TYPES.KeySystemItemsKey
      ) {
        map[result.uuid] = result
      }
    })

    return {
      results,
      map,
    }
  }

  private async decryptProcessedServerPayloads(
    payloads: EncryptedPayloadInterface[],
    map: Record<UuidString, DecryptedPayloadInterface<ItemsKeyContent | KeySystemItemsKeyContent>>,
  ): Promise<(EncryptedPayloadInterface | DecryptedPayloadInterface)[]> {
    return Promise.all(
      payloads.map(async (encrypted) => {
        const previouslyProcessedItemsKey:
          | DecryptedPayloadInterface<ItemsKeyContent | KeySystemItemsKeyContent>
          | undefined = map[encrypted.items_key_id as string]

        const itemsKey = previouslyProcessedItemsKey
          ? (CreateDecryptedItemFromPayload(previouslyProcessedItemsKey) as
              | ItemsKeyInterface
              | KeySystemItemsKeyInterface)
          : undefined

        const keyedSplit: KeyedDecryptionSplit = {}
        if (itemsKey) {
          keyedSplit.usesItemsKey = {
            items: [encrypted],
            key: itemsKey,
          }
        } else {
          keyedSplit.usesItemsKeyWithKeyLookup = {
            items: [encrypted],
          }
        }

        return this.encryptionService.decryptSplitSingle(keyedSplit)
      }),
    )
  }

  private async handleSyncOperationFinish(
    operation: AccountSyncOperation | OfflineSyncOperation,
    options: SyncOptions,
    neverSyncedDeleted: DeletedItemInterface[],
    syncMode: SyncMode,
  ) {
    this.opStatus.setDidEnd()

    if (this.opStatus.hasError()) {
      return { hasError: true }
    }

    this.opStatus.reset()

    this.lastSyncDate = new Date()

    this.syncFrequencyGuard.incrementCallsPerMinute()

    if (operation instanceof AccountSyncOperation && operation.numberOfItemsInvolved >= this.majorChangeThreshold) {
      void this.notifyEvent(SyncEvent.MajorDataChange)
    }

    if (neverSyncedDeleted.length > 0) {
      await this.handleNeverSyncedDeleted(neverSyncedDeleted)
    }

    if (syncMode !== SyncMode.DownloadFirst) {
      await this.notifyEvent(SyncEvent.SyncCompletedWithAllItemsUploaded, {
        source: options.source,
      })
    }

    return { hasError: false }
  }

  private async handleDownloadFirstCompletionAndSyncAgain(online: boolean, options: SyncOptions) {
    if (online) {
      this.completedOnlineDownloadFirstSync = true
    }
    await this.notifyEvent(SyncEvent.DownloadFirstSyncCompleted)
    await this.sync({
      source: SyncSource.AfterDownloadFirst,
      checkIntegrity: true,
      awaitAll: options.awaitAll,
    })
  }

  private async syncAgainByHandlingRequestsWaitingInResolveQueue(options: SyncOptions) {
    this.logger.debug('Syncing again from resolve queue')
    const promise = this.sync({
      source: SyncSource.ResolveQueue,
      checkIntegrity: options.checkIntegrity,
    })
    if (options.awaitAll) {
      await promise
    }
  }

  /**
   * As part of the just concluded sync operation, more items may have
   * been dirtied (like conflicts), and the caller may want to await the
   * full resolution of these items.
   */
  private async syncAgainByHandlingNewDirtyItems(options: SyncOptions) {
    await this.sync({
      source: SyncSource.MoreDirtyItems,
      checkIntegrity: options.checkIntegrity,
      awaitAll: options.awaitAll,
    })
  }

  /**
   * For timing strategy SyncQueueStrategy.ResolveOnNext.
   * Execute any callbacks pulled before this sync request began.
   * Calling resolve on the callbacks should be the last thing we do in this function,
   * to simulate calling .sync as if it went through straight to the end without having
   * to be queued.
   */
  private resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue: SyncPromise[]) {
    for (const callback of inTimeResolveQueue) {
      callback.resolve()
    }
  }

  private async potentiallySyncAgainAfterSyncCompletion(
    syncMode: SyncMode,
    options: SyncOptions,
    inTimeResolveQueue: SyncPromise[],
    online: boolean,
  ) {
    if (syncMode === SyncMode.DownloadFirst) {
      await this.handleDownloadFirstCompletionAndSyncAgain(online, options)
      this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)
      return true
    }

    const didSpawnNewRequest = this.popSpawnQueue()
    const resolveQueueHasRequestsThatDidntMakeItInTime = this.resolveQueue.length > 0
    if (!didSpawnNewRequest && resolveQueueHasRequestsThatDidntMakeItInTime) {
      await this.syncAgainByHandlingRequestsWaitingInResolveQueue(options)
      this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)
      return true
    }

    const newItemsNeedingSync = this.itemsNeedingSync()
    if (newItemsNeedingSync.length > 0) {
      await this.syncAgainByHandlingNewDirtyItems(options)
      this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)
      return true
    }

    return false
  }

  /**
   * Items that have never been synced and marked as deleted should be cleared
   * as dirty, mapped, then removed from storage.
   */
  private async handleNeverSyncedDeleted(items: DeletedItemInterface[]) {
    const payloads = items.map((item) => {
      return item.payloadRepresentation({
        dirty: false,
      })
    })

    await this.payloadManager.emitPayloads(payloads, PayloadEmitSource.LocalChanged)
    await this.persistPayloads(payloads)
  }

  public async persistPayloads(
    payloads: FullyFormedPayloadInterface[],
    options: { throwError: boolean } = { throwError: true },
  ) {
    if (payloads.length === 0 || this.dealloced) {
      return
    }

    return this.storageService.savePayloads(payloads).catch((error) => {
      if (options.throwError) {
        void this.notifyEvent(SyncEvent.DatabaseWriteError, error)
        SNLog.error(error)
      }
    })
  }

  setInSync(isInSync: boolean): void {
    if (isInSync === !this.outOfSync) {
      return
    }

    if (isInSync) {
      this.outOfSync = false
      void this.notifyEvent(SyncEvent.ExitOutOfSync)
    } else {
      this.outOfSync = true
      void this.notifyEvent(SyncEvent.EnterOutOfSync)
    }
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case IntegrityEvent.IntegrityCheckCompleted:
        await this.handleIntegrityCheckEventResponse(event.payload as IntegrityEventPayload)
        break
      case WebSocketsServiceEvent.ItemsChangedOnServer:
        this.wasNotifiedOfItemsChangeOnServer = true
        break
      case WebSocketsServiceEvent.SyncItemsPushed:
        await this.handleItemsPushedOverWebSocket(event.payload as SyncItemsPushedData)
        break
      case WebSocketsServiceEvent.WebSocketDidOpen:
        await this.handleWebSocketReconnect()
        break
      default:
        break
    }
  }

  /**
   * Standard Red Notes (Phase 1A): on a websocket (re)connect, ALWAYS run a full
   * HTTP sync to backfill anything missed while the socket was down. HTTP sync is
   * the source of truth; the realtime push is only an optimization on top of it.
   */
  private async handleWebSocketReconnect(): Promise<void> {
    this.logger.debug('WebSocket (re)connected; performing full HTTP sync to backfill')
    void this.sync({ source: SyncSource.External, sourceDescription: 'WebSocket reconnect backfill' })
  }

  /**
   * Standard Red Notes (Phase 1A): apply encrypted item payloads pushed over the
   * websocket WITHOUT an HTTP pull, but only when it is provably safe.
   *
   * SAFETY RULES (HTTP sync is always the reliable backstop):
   * 1. Token continuity: we only fast-apply when our current sync token EXACTLY
   *    equals the push's `baseSyncToken` (the server's state immediately before
   *    the change). Any mismatch/gap means we may be missing intermediate
   *    changes, so we DISCARD the push and trigger a normal HTTP sync.
   * 2. Never while a sync is in progress / before the DB is loaded: defer to HTTP.
   * 3. Any failure during decrypt/apply/persist falls back to a full HTTP sync.
   *
   * The pushed payloads are run through the SAME decryption + conflict pipeline
   * (`processServerPayloads` -> `ServerSyncResponseResolver` -> `emitDeltaEmit`)
   * as HTTP-retrieved items, then persisted, and only then is the sync token
   * advanced — mirroring `handleSuccessServerResponse`. So data can never be
   * dropped or corrupted: a discarded/failed push simply results in an HTTP pull.
   */
  private async handleItemsPushedOverWebSocket(data: SyncItemsPushedData): Promise<void> {
    if (this.dealloced) {
      return
    }

    /**
     * Manual Sync mode: do NOT auto-pull/apply server-pushed items. Just remember that the
     * server has changes so the UI can reflect it; the next user-initiated sync will reconcile
     * normally (the token is left untouched, so that sync pulls everything we skipped).
     */
    if (this.manualSyncMode) {
      this.logger.debug('Manual sync mode is on; ignoring websocket items-pushed (will reconcile on next manual sync)')
      this.wasNotifiedOfItemsChangeOnServer = true
      return
    }

    const triggerReconcilingHttpSync = (reason: string) => {
      this.logger.debug(`Discarding websocket sync push (${reason}); falling back to HTTP sync`)
      this.wasNotifiedOfItemsChangeOnServer = true
      void this.sync({ source: SyncSource.External, sourceDescription: `WebSocket push fallback: ${reason}` })
    }

    if (!this.databaseLoaded || this.opStatus.syncInProgress || this.syncLock) {
      triggerReconcilingHttpSync('sync busy or database not loaded')
      return
    }

    const currentToken = await this.getLastSyncToken()

    // Token-continuity gate: only apply if we are exactly caught up to the
    // server state the push is based on. Otherwise we might miss intermediate
    // changes — reconcile via HTTP (the source of truth).
    if (!currentToken || currentToken !== data.baseSyncToken) {
      triggerReconcilingHttpSync('sync token mismatch/gap')
      return
    }

    // Hold the sync lock for the duration of the apply so a concurrent HTTP sync
    // cannot interleave and double-advance the token. A normal sync that arrives
    // while we hold it simply defers (its own lock check), and our token advance
    // makes it a no-op pull anyway. If acquisition races, defer to HTTP.
    if (this.syncLock) {
      triggerReconcilingHttpSync('sync busy or database not loaded')
      return
    }
    this.syncLock = true

    try {
      const decryptedPayloads = await this.processServerPayloads(
        data.items as FilteredServerItem[],
        PayloadSource.RemoteRetrieved,
      )

      const masterCollection = this.payloadManager.getMasterCollection()
      const historyMap = this.historyService.getHistoryMapCopy()

      const resolver = new ServerSyncResponseResolver(
        {
          retrievedPayloads: decryptedPayloads,
          savedPayloads: [],
          conflicts: {},
        },
        masterCollection,
        [],
        historyMap,
      )

      const emits = resolver.result()
      for (const emit of emits) {
        const payloadsToPersist = await this.payloadManager.emitDeltaEmit(emit)
        await this.persistPayloads(payloadsToPersist)
      }

      // Advance the sync token EXACTLY as an HTTP pull would, so the next HTTP
      // sync starts from the new server position and we don't re-pull the change.
      await this.setLastSyncToken(data.syncToken)

      this.lastSyncDate = new Date()

      await this.notifyEvent(SyncEvent.PaginatedSyncRequestCompleted, {
        retrievedPayloads: data.items,
        source: SyncSource.External,
      })

      this.logger.debug(`Applied ${decryptedPayloads.length} item(s) from websocket push without HTTP pull`)
    } catch (error) {
      // Never drop or corrupt data: on ANY failure, fall back to a full HTTP sync.
      this.logger.error('Failed to apply websocket sync push; falling back to HTTP sync', error)
      triggerReconcilingHttpSync('apply error')
    } finally {
      this.syncLock = false
    }
  }

  private async handleIntegrityCheckEventResponse(eventPayload: IntegrityEventPayload) {
    const rawPayloads = eventPayload.rawPayloads

    if (rawPayloads.length === 0) {
      this.setInSync(true)
      return
    }

    const rawPayloadsFilteringResult = FilterDisallowedRemotePayloadsAndMap(rawPayloads)
    const receivedPayloads = rawPayloadsFilteringResult.filtered
      .map((rawPayload) => {
        const result = CreatePayloadFromRawServerItem(rawPayload, PayloadSource.RemoteRetrieved)
        if (result.isFailed()) {
          return undefined
        }
        return result.getValue()
      })
      .filter(isNotUndefined)

    const payloadSplit = CreateNonDecryptedPayloadSplit(receivedPayloads)

    const encryptionSplit = SplitPayloadsByEncryptionType(payloadSplit.encrypted)

    const keyedSplit = CreateDecryptionSplitWithKeyLookup(encryptionSplit)

    const decryptionResults = await this.encryptionService.decryptSplit(keyedSplit)

    this.setInSync(false)

    await this.emitOutOfSyncRemotePayloads([...decryptionResults, ...payloadSplit.deleted])

    const shouldCheckIntegrityAgainAfterSync = eventPayload.source !== SyncSource.ResolveOutOfSync

    await this.sync({
      checkIntegrity: shouldCheckIntegrityAgainAfterSync,
      source: SyncSource.ResolveOutOfSync,
    })
  }

  private async emitOutOfSyncRemotePayloads(payloads: FullyFormedPayloadInterface[]) {
    const delta = new DeltaOutOfSync(
      this.payloadManager.getMasterCollection(),
      ImmutablePayloadCollection.WithPayloads(payloads),
      this.historyService.getHistoryMapCopy(),
    )

    const emit = delta.result()

    await this.payloadManager.emitDeltaEmit(emit)

    await this.persistPayloads(emit.emits)
  }

  async syncSharedVaultsFromScratch(sharedVaultUuids: string[]): Promise<void> {
    await this.sync({
      sharedVaultUuids: sharedVaultUuids,
      syncSharedVaultsFromScratch: true,
      queueStrategy: SyncQueueStrategy.ForceSpawnNew,
      awaitAll: true,
    })
  }

  /** @e2e_testing */
  // eslint-disable-next-line camelcase
  ut_setDatabaseLoaded(loaded: boolean): void {
    this.databaseLoaded = loaded
  }

  /** @e2e_testing */
  // eslint-disable-next-line camelcase
  ut_clearLastSyncDate(): void {
    this.lastSyncDate = undefined
  }

  /** @e2e_testing */
  // eslint-disable-next-line camelcase
  ut_beginLatencySimulator(latency: number): void {
    this._simulate_latency = {
      latency: latency || 1000,
      enabled: true,
    }
  }

  /** @e2e_testing */
  // eslint-disable-next-line camelcase
  ut_endLatencySimulator(): void {
    this._simulate_latency = undefined
  }
}
