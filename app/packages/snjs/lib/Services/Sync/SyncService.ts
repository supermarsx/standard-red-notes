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
  isDeletedPayload,
  ItemsKeyInterface,
  CreateNonDecryptedPayloadSplit,
  DeltaOfflineSaved,
  DeltaEmit,
  DeletedPayload,
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
  isLitePayload,
  createLitePayloadFromDecrypted,
  LiteContentMarkerKey,
  LiteStrippedContentFields,
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
 * LIVE-SYNC: when the server pushes an ITEMS_CHANGED_ON_SERVER notification over the
 * websocket (e.g. a collaborator edited a shared vault), we trigger an immediate sync
 * rather than waiting up to 30s for the periodic auto-sync tick. The trigger is debounced
 * so a burst of pushes coalesces into a single sync. The 30s auto-sync remains a backstop.
 */
const LIVE_SYNC_DEBOUNCE_MS = 1_000

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

  /**
   * Owner token for the short critical section that prepares/starts a sync operation.
   * A boolean cannot express ownership: a concurrent LocalOnly call used to invoke the
   * shared release closure and unlock an HTTP sync it never acquired.
   */
  private syncLock: symbol | false = false
  /** Tracks write failures thrown by persistPayloads without changing the original error identity. */
  private readonly localPersistenceFailures = new WeakSet<object>()
  private _simulate_latency?: { latency: number; enabled: boolean }
  private dealloced = false

  public lastSyncInvokationPromise?: Promise<unknown>
  public currentSyncRequestPromise?: Promise<void>

  private autoSyncInterval?: NodeJS.Timeout
  private wasNotifiedOfItemsChangeOnServer = false

  /** Pending debounced live-sync timer, coalescing a burst of server-change notifications. */
  private liveSyncDebounceTimeout?: NodeJS.Timeout

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
      this.syncDetached(
        { source: SyncSource.NetworkReturned, sourceDescription: 'Browser online event' },
        'browser online event',
      )
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
      this.syncDetached(
        { source: SyncSource.NetworkReturned, sourceDescription: 'App focus/visibility' },
        'app focus/visibility',
      )
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
   * Automatic/background callers have no consumer to observe a rejected sync promise.
   * Catch unexpected programming/event errors at the detached boundary; handled sync
   * failures retain sync()'s historical event-driven, non-rejecting contract.
   */
  private syncDetached(options: Partial<SyncOptions>, context: string): void {
    void this.sync(options).catch((error) => {
      this.logger.error(`Detached sync failed (${context})`, error)
    })
  }

  private notifyEventDetached(event: SyncEvent, data: unknown, context: string): void {
    void this.notifyEvent(event, data).catch((error) => {
      this.logger.error(`Detached sync event failed (${context})`, error)
    })
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
      this.syncDetached(
        { source: SyncSource.BackoffRetry, sourceDescription: 'Failure backoff retry' },
        'failure backoff retry',
      )
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
    if (this.liveSyncDebounceTimeout) {
      clearTimeout(this.liveSyncDebounceTimeout)
      this.liveSyncDebounceTimeout = undefined
    }
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

    /**
     * COLD-LOAD COMPLETENESS: the device cheaply reports the entry/key count per chunk
     * (the keys it intends us to load), so we can derive the EXPECTED number of regular
     * entries without any extra device read. We then count how many were ACTUALLY emitted
     * into memory and assert the two match at the end. This complements the per-batch
     * isolation above: that prevents one bad batch from aborting the whole load; this
     * catches the case where a batch was silently skipped, leaving a PARTIAL load (the
     * "70k of 100k" symptom) — which would otherwise look like a successful load.
     */
    const expectedRemainingEntryCount = remainingChunks.reduce(
      (sum, chunk) => sum + (isChunkFullEntry(chunk) ? chunk.entries.length : chunk.keys.length),
      0,
    )

    let chunkIndex = 0
    let successfullyEmittedCount = 0
    const failedChunkKeys: string[] = []
    const ChunkIndexOfContentTypePriorityItems = 0

    /**
     * PIPELINE PREFETCH (perf, ordering-preserving). The drain loop used to run
     * strictly serially per chunk: read the chunk's ciphertext from IndexedDB,
     * THEN decrypt+emit it, THEN sleep. As a result the decryption worker pool sat
     * idle during every IndexedDB read, and the reader/main thread sat idle during
     * every decrypt+emit. We now keep exactly ONE chunk of read-ahead: right before
     * processing chunk i we kick off the IndexedDB read for chunk i+1, so that read
     * overlaps chunk i's decrypt+emit (roughly overlapping the two dominant phases).
     *
     * Invariants preserved (do not regress):
     *  - Ordering: chunks are still PROCESSED strictly in index order — we await
     *    each processPayloadBatch before starting the next — and the itemsKeys /
     *    keySystemRootKeys / keySystemItemsKeys priority sets were already emitted
     *    above, before this loop runs.
     *  - Per-batch failure isolation (the BUG-1 fix — notes silently lost on
     *    cold-load): a single batch must never abort the WHOLE remaining load, so
     *    each batch's decrypt/emit stays wrapped in its own try/catch. A failed
     *    read is likewise isolated: its keys are recorded for the completeness
     *    re-attempt rather than propagating out and killing every later chunk.
     *  - Bounded memory: at most one EXTRA chunk of raw ciphertext is resident (the
     *    prefetched i+1 while i is being processed), never the whole corpus.
     *  - Completeness: successfullyEmittedCount / failedChunkKeys accounting is
     *    unchanged, so verifyColdLoadCompleteness still catches any shortfall.
     */
    const readChunkEntries = (chunk: (typeof remainingChunks)[number]): Promise<FullyFormedTransferPayload[]> => {
      if (isChunkFullEntry(chunk)) {
        return Promise.resolve(chunk.entries)
      }
      return this.device.getDatabaseEntries(this.identifier, chunk.keys)
    }

    let prefetchedEntries: Promise<FullyFormedTransferPayload[]> | undefined =
      remainingChunks.length > 0 ? readChunkEntries(remainingChunks[0]) : undefined

    for (let i = 0; i < remainingChunks.length; i++) {
      const chunk = remainingChunks[i]
      const entriesPromise = prefetchedEntries as Promise<FullyFormedTransferPayload[]>

      // Kick off the NEXT chunk's IndexedDB read now so it overlaps this chunk's decrypt+emit.
      prefetchedEntries = i + 1 < remainingChunks.length ? readChunkEntries(remainingChunks[i + 1]) : undefined

      let dbEntries: FullyFormedTransferPayload[]
      try {
        dbEntries = await entriesPromise
      } catch (e) {
        this.logger.error('loadDatabasePayloads: chunk read failed, continuing with remaining chunks', String(e))
        if (!isChunkFullEntry(chunk)) {
          extendArray(failedChunkKeys, chunk.keys)
        }
        chunkIndex++
        continue
      }

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

      try {
        await this.processPayloadBatch(payloads, totalProcessedCount, payloadCount)
        successfullyEmittedCount += payloads.length
      } catch (e) {
        this.logger.error('loadDatabasePayloads: batch failed, continuing with remaining chunks', String(e))
        if (!isChunkFullEntry(chunk)) {
          extendArray(failedChunkKeys, chunk.keys)
        }
      }

      const shouldSleepOnlyAfterFirstRegularBatch = chunkIndex > ChunkIndexOfContentTypePriorityItems
      if (shouldSleepOnlyAfterFirstRegularBatch) {
        await sleep(this.options.sleepBetweenBatches, false, 'Sleeping to allow interface to update')
      }

      totalProcessedCount += payloads.length
      chunkIndex++
    }

    await this.verifyColdLoadCompleteness(expectedRemainingEntryCount, successfullyEmittedCount, failedChunkKeys)

    this.databaseLoaded = true
    this.opStatus.setDatabaseLoadStatus(0, 0, true)
  }

  /**
   * COLD-LOAD COMPLETENESS check (no silent partial loads). After draining every chunk,
   * the number of entries we actually emitted into memory must equal the number the device
   * told us to load. If it is SHORT, some batch failed or was skipped — a silent partial
   * load (e.g. 70k of 100k notes). We log it clearly, and when the skipped entries came
   * from keyed chunks we re-attempt those exact keys ONCE before giving up. A residual
   * shortfall after the retry is logged as an error (data is on disk and will reconcile on
   * the next sync/reload; we never report a partial load as a clean success silently).
   */
  private async verifyColdLoadCompleteness(
    expectedCount: number,
    emittedCount: number,
    failedChunkKeys: string[],
  ): Promise<void> {
    if (emittedCount >= expectedCount) {
      return
    }

    const shortfall = expectedCount - emittedCount
    this.logger.error(
      `loadDatabasePayloads: PARTIAL load detected — emitted ${emittedCount} of ${expectedCount} expected entries (short by ${shortfall}).`,
    )

    if (failedChunkKeys.length === 0) {
      this.logger.error(
        'loadDatabasePayloads: cannot identify the missing keys to re-attempt (no keyed chunks recorded); will reconcile on next sync/reload.',
      )
      return
    }

    this.logger.debug(`loadDatabasePayloads: re-attempting ${failedChunkKeys.length} missing keys once`)

    try {
      const retryEntries = await this.device.getDatabaseEntries(this.identifier, failedChunkKeys)
      const retryPayloads = retryEntries
        .map((entry) => {
          try {
            return CreatePayload(entry, PayloadSource.LocalDatabaseLoaded)
          } catch (e) {
            console.error('Creating payload failed', e)
            return undefined
          }
        })
        .filter(isNotUndefined)

      await this.processPayloadBatch(retryPayloads)

      const recoveredEmittedCount = emittedCount + retryPayloads.length
      if (recoveredEmittedCount >= expectedCount) {
        this.logger.debug('loadDatabasePayloads: re-attempt recovered the missing entries; load is now complete')
      } else {
        this.logger.error(
          `loadDatabasePayloads: re-attempt still short — emitted ${recoveredEmittedCount} of ${expectedCount}; will reconcile on next sync/reload.`,
        )
      }
    } catch (e) {
      this.logger.error('loadDatabasePayloads: re-attempt of missing keys failed', String(e))
    }
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

      this.syncDetached({ sourceDescription: 'Auto Sync' }, 'automatic sync')

      return
    }

    if (this.wasNotifiedOfItemsChangeOnServer) {
      this.logger.debug('Was notified of items changed on server, doing autosync')

      this.wasNotifiedOfItemsChangeOnServer = false

      this.syncDetached(
        { sourceDescription: 'WebSockets Event - Items Changed On Server' },
        'websocket items-changed notification',
      )
    }
  }

  /**
   * LIVE-SYNC: schedule a DEBOUNCED immediate sync in response to an
   * ITEMS_CHANGED_ON_SERVER websocket notification, so a collaborator's change is pulled
   * within ~1s instead of waiting up to 30s for the periodic auto-sync tick. The debounce
   * coalesces a burst of pushes into a single sync. This only runs when there is a session
   * (online); without one there is nothing to pull from the server. The 30s auto-sync timer
   * remains in place as a backstop, and `wasNotifiedOfItemsChangeOnServer` is still set by
   * the caller so the backstop will also pick up the change if this immediate sync is
   * suppressed (e.g. manual sync mode).
   */
  private scheduleDebouncedLiveSync(): void {
    if (this.dealloced) {
      return
    }

    if (this.manualSyncMode) {
      this.logger.debug('Manual sync mode is on; skipping debounced live sync (backstop will reconcile)')
      return
    }

    if (!this.sessionManager?.online()) {
      this.logger.debug('No session; skipping debounced live sync')
      return
    }

    if (this.liveSyncDebounceTimeout) {
      clearTimeout(this.liveSyncDebounceTimeout)
    }

    this.liveSyncDebounceTimeout = setTimeout(() => {
      this.liveSyncDebounceTimeout = undefined
      if (this.dealloced) {
        return
      }
      this.wasNotifiedOfItemsChangeOnServer = false
      this.logger.debug('Live-sync debounce elapsed; syncing for server-side items change')
      this.syncDetached(
        { source: SyncSource.External, sourceDescription: 'Live Sync - Items Changed On Server' },
        'debounced live sync',
      )
    }, LIVE_SYNC_DEBOUNCE_MS)
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

      /**
       * BUG-1 FIX (notes silently lost on cold-load): stripping must be per-item
       * fault-tolerant. If building the lite projection for ONE note ever throws
       * (e.g. an unexpected content shape), we must NOT let that exception bubble out
       * of `.map()` — doing so would abort the whole batch and (combined with an
       * unguarded load loop) every subsequent batch, leaving a suffix of notes
       * unloaded. Falling back to the FULL payload for that one note keeps it
       * loadable (it just forgoes the heap win) and guarantees ALL notes load.
       */
      try {
        return createLitePayloadFromDecrypted(payload)
      } catch (e) {
        this.logger.error('maybeStripBodiesForLazyDecrypt: failed to strip note, keeping full payload', String(e))
        return payload
      }
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

  private async setLastSyncToken(token: string): Promise<void> {
    const previousToken = this.syncToken
    /**
     * D2 CRITICAL-KEY ROUTING: await the disk flush. This token gates what a future
     * sync re-pulls; a silently-dropped write (old fire-and-forget setValue) could
     * leave disk behind memory, so a restart re-pulls already-applied pages or, worse,
     * pairs a stale token with freshly-persisted items. Awaiting durability keeps the
     * on-disk token consistent with the items persisted just before it (see D4).
     */
    try {
      await this.writeCriticalStorageValue(StorageKey.LastSyncToken, token)
    } catch (error) {
      this.syncToken = previousToken
      await this.restoreCriticalStorageValues([[StorageKey.LastSyncToken, previousToken]])
      this.reportCriticalStorageWriteFailure(error)
    }
    this.syncToken = token
  }

  /**
   * The sync and pagination cursors are one logical checkpoint. DiskStorageService
   * currently exposes only single-key writes, so wait for both attempts to settle and,
   * if either fails, restore BOTH values before surfacing the original failure. Waiting
   * for allSettled is essential: a slower successful write must not re-advance one half
   * of the pair after rollback has begun.
   */
  private async setSyncTokens(syncToken: string, paginationToken?: string): Promise<void> {
    const previousSyncToken = this.syncToken
    const previousPaginationToken = this.cursorToken

    const results = await Promise.allSettled([
      this.writeCriticalStorageValue(StorageKey.LastSyncToken, syncToken),
      this.writeCriticalStorageValue(StorageKey.PaginationToken, paginationToken),
    ])
    const failedWrite = results.find((result) => result.status === 'rejected')

    if (failedWrite?.status === 'rejected') {
      this.syncToken = previousSyncToken
      this.cursorToken = previousPaginationToken
      await this.restoreCriticalStorageValues([
        [StorageKey.LastSyncToken, previousSyncToken],
        [StorageKey.PaginationToken, previousPaginationToken],
      ])
      this.reportCriticalStorageWriteFailure(failedWrite.reason)
    }

    this.syncToken = syncToken
    this.cursorToken = paginationToken
  }

  private async writeCriticalStorageValue(key: StorageKey, value: unknown): Promise<void> {
    if (value == undefined) {
      await this.storageService.removeValue(key)
      return
    }

    await this.storageService.setValueAndAwaitPersist(key, value)
  }

  private async restoreCriticalStorageValues(entries: [StorageKey, unknown][]): Promise<void> {
    const rollbackResults = await Promise.allSettled(
      entries.map(([key, value]) => this.writeCriticalStorageValue(key, value)),
    )

    for (const [index, result] of rollbackResults.entries()) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Failed to durably restore critical storage value ${entries[index][0]} after write failure`,
          result.reason,
        )
      }
    }
  }

  private reportCriticalStorageWriteFailure(error: unknown): never {
    this.notifyEventDetached(SyncEvent.DatabaseWriteError, error, 'critical storage write failure')
    SNLog.error(error instanceof Error ? error : Error(String(error)))
    this.throwLocalPersistenceFailure(error)
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
     * SAFETY (lazy-decrypt): a content-stripped (lite) item must never be dirty/synced. If one ever
     * appears in the dirty set the invariant was broken upstream. Previously this THREW, which hard-
     * halted the ENTIRE sync on a single stray lite item. Instead we EXCLUDE such items from the sync
     * set here (and log), so one stray item cannot stall all syncing. The item's body is preserved
     * intact on disk; prepareForSync separately re-hydrates and persists dirty lite items so their
     * real content still reaches storage and, on the next pass, the server.
     */
    const nonLiteDirtyItems = dirtyItems.filter((item) => {
      if (isLitePayload(item.payload)) {
        this.logger.error(
          'itemsNeedingSync: excluding dirty lite item from sync set to avoid body-stripped push',
          item.uuid,
        )
        return false
      }
      return true
    })

    const itemsWithoutBackoffPenalty = nonLiteDirtyItems.filter(
      (item) => !this.syncBackoffService.isItemInBackoff(item),
    )

    /**
     * NOTE: local-only items are intentionally NOT excluded here. They must remain in the set that
     * prepareForSync persists to the local database (otherwise a dirty local-only item is silently
     * dropped from disk and lost on reload). Local-only exclusion is applied ONLY to the UPLOAD set,
     * at the return of prepareForSync — see SyncService.excludeLocalOnlyItems.
     */
    return itemsWithoutBackoffPenalty
  }

  /**
   * Returns dirty items whose in-memory payload is content-stripped (lite). These are excluded from
   * the normal sync/persist set (a body-less payload must never overwrite the real on-disk
   * ciphertext). prepareForSync re-hydrates each one's full body from disk and persists THAT so the
   * edit is not lost. Empty in normal operation (and always empty with the flag off).
   */
  private dirtyLiteItems(): DecryptedItemInterface[] {
    return this.itemManager.getDirtyItems().filter((item) => isLitePayload(item.payload)) as DecryptedItemInterface[]
  }

  /**
   * Builds the FULL, dirty payload that must be both persisted AND uploaded for a dirty lite item.
   *
   * WHERE THE EDIT LIVES: a dirty lite item arises ONLY from a metadata-only mutation (title, refs,
   * pinned, trashed, …) applied directly to a content-stripped item — a `text` edit goes through the
   * editor-open path which re-hydrates the note to FULL first, so a text edit never leaves an item
   * lite. Therefore the LATEST edit lives in the IN-MEMORY lite payload's metadata; only the bulky
   * body field(s) (note `text`) were stripped and survive (stale-but-correct, since unchanged) ON
   * DISK. We must upload the USER'S EDIT, not the stale on-disk body's metadata — so we MERGE the
   * in-memory lite content (latest edit) with the on-disk stripped field(s) and drop the lite marker.
   *
   * Returns a NON-lite, dirty DecryptedPayload that carries BOTH the latest edit and a real body, or
   * undefined when the on-disk body cannot be re-hydrated (caller then SKIPs to avoid a stripped push).
   */
  private rehydrateDirtyLiteItemForUpload(
    liteItem: DecryptedItemInterface,
    full: DecryptedPayloadInterface,
  ): DecryptedPayloadInterface {
    const liteContent = liteItem.payload.content as unknown as Record<string, unknown>
    const fullContent = full.content as unknown as Record<string, unknown>

    /** Start from the in-memory metadata edit, restore only the stripped body field(s) from disk. */
    const mergedContent: Record<string, unknown> = { ...liteContent }
    for (const field of LiteStrippedContentFields) {
      mergedContent[field] = fullContent[field]
    }
    /** Drop the in-memory-only lite marker so the result is a normal full payload. */
    delete mergedContent[LiteContentMarkerKey]

    return new DecryptedPayload({
      ...liteItem.payload.ejected(),
      content: mergedContent as unknown as ItemContent,
      dirty: true,
      dirtyIndex: liteItem.payload.dirtyIndex ?? getIncrementedDirtyIndex(),
    })
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
    const payloads: DecryptedPayloadInterface[] = []
    for (const item of items) {
      let sourcePayload = item.payload

      /**
       * SAFETY (lazy-decrypt): an in-memory item may be a content-stripped (lite) payload whose
       * body (note `text`) was discarded on cold-load. Marking it dirty and persisting it here
       * would write a body-less payload over the real on-disk ciphertext = irreversible data
       * loss, and would also leave a lite payload dirty (tripping assertNoLitePayloads on sync).
       * Re-hydrate the full on-disk content first. If a full payload cannot be obtained, SKIP the
       * item rather than persist a stripped version — never overwrite full content with nothing.
       */
      if (isLitePayload(sourcePayload)) {
        const full = await this.getFullContentPayload(item.uuid)

        /**
         * DATA-LOSS GUARD (rehydrate-clobber race): the disk read above is async. Re-read the LIVE
         * item afterwards — if it is no longer lite (the user typed, or a sync wrote it) its CURRENT
         * in-memory payload is the freshest full body, so use that instead of the stale on-disk read.
         */
        const live = this.itemManager.findItem(item.uuid)
        if (live && !isLitePayload(live.payload)) {
          sourcePayload = live.payload
        } else if (!full || isLitePayload(full)) {
          this.logger.error(
            'markAllItemsAsNeedingSyncAndPersist: could not re-hydrate full content for lite item, skipping to avoid body-stripped persist',
            item.uuid,
          )
          continue
        } else {
          sourcePayload = full
        }
      }

      payloads.push(
        new DecryptedPayload({
          ...sourcePayload.ejected(),
          dirty: true,
          dirtyIndex: getIncrementedDirtyIndex(),
        }),
      )
    }

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

    /**
     * DATA-LOSS / SYNC-REGRESSION GUARD (lazy-decrypt): any dirty item whose in-memory payload is
     * still lite was excluded from `items` above (itemsNeedingSync), because a body-stripped payload
     * must never overwrite the real on-disk/server ciphertext. But a dirty lite item carries a real
     * USER EDIT (metadata only — a `text` edit re-hydrates the note to full first), so it MUST still
     * reach the server, not merely disk. The earlier fix only PERSISTED the body, which left the edit
     * stuck locally forever (the in-memory item stayed lite+dirty, so every subsequent pass excluded
     * it again — it survived reload but NEVER synced).
     *
     * For each dirty lite item we therefore build a FULL, dirty payload that MERGES the in-memory
     * latest edit with the on-disk body (see rehydrateDirtyLiteItemForUpload), EMIT it into the
     * collection so it REPLACES the lite item in memory (LocalChanged keeps it dirty — not
     * LocalDatabaseLoaded, which is treated as clean), and add the now-full live item to BOTH the
     * persist set AND the upload set (`items`). After a successful upload+save it is marked synced
     * like any other dirty item. If re-hydration is impossible we SKIP+log (never push a stripped
     * payload) rather than stall the whole sync.
     */
    for (const liteItem of this.dirtyLiteItems()) {
      const full = await this.getFullContentPayload(liteItem.uuid)
      if (!full || isLitePayload(full)) {
        this.logger.error(
          'prepareForSync: could not re-hydrate full content for dirty lite item, skipping persist/upload to avoid body-stripped write',
          liteItem.uuid,
        )
        continue
      }

      const rehydrated = this.rehydrateDirtyLiteItemForUpload(liteItem, full)

      /**
       * Replace the lite item in memory with the full, dirty payload (LocalChanged = a local
       * mutation, so it remains dirty and will be marked synced after upload). This clears the
       * lite marker, so the next itemsNeedingSync no longer excludes it.
       */
      await this.payloadManager.emitPayloads([rehydrated], PayloadEmitSource.LocalChanged)

      /** Persist the full body so a pre-upload reload doesn't lose it. */
      decryptedPayloads.push(rehydrated)

      /** Include the now-full live item in the upload set so the edit reaches the SERVER. */
      const live = this.itemManager.findItem(liteItem.uuid)
      if (live && !isLitePayload(live.payload)) {
        items.push(live)
      }
    }

    /**
     * Final defensive filter: never hand a lite payload to persistPayloads (its tripwire would throw
     * and halt all syncing). In normal operation this removes nothing.
     */
    const safeDecryptedPayloads = decryptedPayloads.filter((payload) => {
      if (isLitePayload(payload)) {
        this.logger.error('prepareForSync: filtered stray lite payload from persist set', payload.uuid)
        return false
      }
      return true
    })

    const payloadsNeedingSave = this.popPayloadsNeedingPreSyncSave(safeDecryptedPayloads)

    const hidePersistErrorDueToWaitingOnKeyDownload = options.mode === SyncMode.DownloadFirst
    const didPersistPayloads = await this.persistPayloadsWithResult(payloadsNeedingSave, {
      throwError: !hidePersistErrorDueToWaitingOnKeyDownload,
    })
    /**
     * Advance the pre-sync persistence watermark only AFTER the write commits. Advancing it
     * before awaiting persistence caused the retry to filter out the exact payloads whose
     * first write failed.
     */
    if (didPersistPayloads) {
      this.dirtyIndexAtLastPresyncSave = frozenDirtyIndex
    }

    if (options.onPresyncSave) {
      options.onPresyncSave()
    }

    /**
     * UPLOAD SEAM for local-only exclusion. `items` above (and the `decryptedPayloads` derived from it,
     * already persisted) INCLUDES local-only items so they survive reloads. But local-only items must
     * never leave the device, so filter them out of the set we RETURN — this returned set is consumed
     * solely by the upload path (prepareForSyncExecution → setLastSyncBeganForItems → createSyncOperation).
     * Filtering here (rather than inside itemsNeedingSync or getOnline/OfflineSyncParameters) keeps
     * local-only items out of both the upload and the lastSyncBegan stamping while preserving their
     * local persistence. Deleted items pass through (a local-only deletion still needs to reach the
     * server / complete its local removal) — see excludeLocalOnlyItems.
     */
    const uploadItems = SyncService.excludeLocalOnlyItems(items)

    /**
     * Persisted-but-not-uploaded local-only items. `items` still contains the local-only items
     * (only `uploadItems` is the filtered copy); they were just written to disk via persistPayloads
     * above, so they survive reload. But because they are excluded from the upload set, no server
     * response (DeltaRemoteSaved/DeltaOfflineSaved) will ever clear their dirty flag — leaving them
     * dirty forever, which makes itemsNeedingSync() perpetually non-empty and
     * potentiallySyncAgainAfterSyncCompletion re-spawn sync endlessly (sync() never resolves).
     * Thread them to handleSyncOperationFinish so their dirty state is cleared locally, race-safely.
     */
    const localOnlyPersistedItems = items.filter(
      (item) => !isDeletedItem(item) && (item as DecryptedItemInterface).localOnly === true,
    ) as DecryptedItemInterface[]

    return { items: uploadItems, beginDate, frozenDirtyIndex, neverSyncedDeleted, localOnlyPersistedItems }
  }

  /**
   * Allows us to lock this function from triggering duplicate network requests.
   * There are two types of locking checks:
   * 1. syncLocked(): If a call to sync() call has begun preparing to be sent to the server.
   *                  but not yet completed all the code below before reaching that point.
   *                  (before reaching opStatus.setDidBegin).
   * 2. syncOpInProgress: If a sync() call is in flight to the server.
   */
  private tryAcquireSyncLock(): symbol | undefined {
    if (this.syncLock !== false) {
      return undefined
    }

    const owner = Symbol('sync-lock-owner')
    this.syncLock = owner
    return owner
  }

  private releaseSyncLock(owner: symbol | undefined): void {
    if (owner && this.syncLock === owner) {
      this.syncLock = false
    }
  }

  private isSyncLocked(): boolean {
    return this.syncLock !== false
  }

  private configureSyncLock(options: SyncOptions) {
    const syncInProgress = this.opStatus.syncInProgress
    const databaseLoaded = this.databaseLoaded
    const canExecuteSync = !this.isSyncLocked()
    const syncLimitReached = this.syncFrequencyGuard.isSyncCallsThresholdReachedThisMinute()
    const canAcquire = canExecuteSync && databaseLoaded && !syncInProgress && !syncLimitReached
    const lockOwner = canAcquire ? this.tryAcquireSyncLock() : undefined
    const shouldExecuteSync = lockOwner !== undefined

    if (!shouldExecuteSync) {
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
      this.releaseSyncLock(lockOwner)
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
    online: boolean,
  ) {
    /**
     * BUG FIX ("note shows 'syncing' with NO login"): the server-sync status
     * (opStatus.syncInProgress, which the web SyncStatusController surfaces as
     * "syncing") must only begin for an ONLINE sync. With no session, sync() is a
     * LOCAL-ONLY IndexedDB persist — no server request is made (see createSyncOperation's
     * OfflineSyncOperation branch) — so presenting it as server "syncing" wrongly implies
     * the note is being pushed to a server without an account. We still run the offline
     * save silently below; we just don't enter the server-sync status when offline.
     */
    if (online) {
      this.opStatus.setDidBegin()
    }

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

  private handleThrownSyncFailure(error: unknown, online: boolean): void {
    if (this.opStatus.syncInProgress) {
      this.opStatus.setDidEnd()
    }
    this.opStatus.setError(error as Error)
    this.applyOnlineSyncResult(true, online)
    this.notifyEventDetached(SyncEvent.SyncError, error, 'sync failure')
  }

  /**
   * A failed owner cannot leave callers parked behind a request that no longer
   * exists. Resolve them consistently with sync()'s historical non-throwing error
   * contract; the DatabaseWriteError/SyncError events carry the failure details.
   */
  private settlePendingSyncRequestsAfterFailure(inTimeResolveQueue: SyncPromise[]): void {
    const pending = new Set<SyncPromise>([...inTimeResolveQueue, ...this.resolveQueue, ...this.spawnQueue])
    this.resolveQueue.length = 0
    this.spawnQueue.length = 0

    for (const request of pending) {
      request.resolve()
    }
  }

  /**
   * A standalone LocalOnly request performs no operation-finish phase, so explicitly
   * hand off any requests that queued while its pre-sync save held the owner lock.
   */
  private async drainQueuedSyncRequests(options: SyncOptions): Promise<void> {
    const spawnedRequest = this.popSpawnQueue()
    if (spawnedRequest) {
      if (options.awaitAll) {
        await spawnedRequest
      }
      return
    }

    if (this.resolveQueue.length > 0) {
      await this.syncAgainByHandlingRequestsWaitingInResolveQueue(options)
    }
  }

  private async performSync(options: SyncOptions): Promise<unknown> {
    const { shouldExecuteSync, releaseLock } = this.configureSyncLock(options)

    if (!shouldExecuteSync) {
      return this.deferSyncRequest(options)
    }

    let inTimeResolveQueue: SyncPromise[] = []
    let online: boolean | undefined
    let presyncSaveCompleted = false

    try {
      if (this.dealloced) {
        return
      }

      /**
       * Preparing includes the durability-critical pre-sync save. It must be inside
       * this owner's finally block so an encryption/IndexedDB failure cannot wedge the
       * service's lock for the remainder of the session.
       */
      const { items, beginDate, frozenDirtyIndex, neverSyncedDeleted, localOnlyPersistedItems } =
        await this.prepareForSync(options)
      presyncSaveCompleted = true
      const isReadOnlySession = this.sessionManager.isCurrentSessionReadOnly() === true

      if (options.mode === SyncMode.LocalOnly) {
        this.logger.debug('Syncing local only, skipping remote sync request')
        releaseLock()
        await this.drainQueuedSyncRequests(options)
        return
      }

      inTimeResolveQueue = this.getPendingRequestsMadeInTimeToPiggyBackOnCurrentRequest()

      if (this.dealloced) {
        return
      }

      /**
       * Determine online (has-session) BEFORE we begin so the server-sync status is only
       * entered for an actual online sync. Without a session this is a local-only persist
       * and must not surface as server "syncing".
       */
      online = this.sessionManager.online()

      const latestItems = await this.prepareForSyncExecution(
        isReadOnlySession ? [] : items,
        inTimeResolveQueue,
        beginDate,
        frozenDirtyIndex,
        online,
      )

      if (isReadOnlySession && items.length > 0) {
        this.logger.debug('Read-only session detected, retaining dirty items locally and skipping their upload.')
      }

      const { operation, mode: syncMode } = await this.createSyncOperation(
        latestItems.map((i) => i.payloadRepresentation()),
        online,
        options,
      )

      const operationPromise = operation.run()

      /** awaitCurrentSyncs must preserve sync()'s historical non-rejecting background contract. */
      this.currentSyncRequestPromise = operationPromise.catch(() => undefined)

      /**
       * RELIABILITY (silent-drop fix, paired with AccountSyncOperation.run): the
       * paginated operation now PROPAGATES a receiver error (e.g. a transient
       * IndexedDB persist or decrypt failure while applying a retrieved page)
       * instead of swallowing it and paginating on. Catch it here and treat it as a
       * normal failed online sync. Status/backoff bookkeeping and error events expose
       * the failure while sync() preserves its background-safe resolution contract.
       */
      try {
        await operationPromise
      } catch (error) {
        if (!this.dealloced) {
          this.logger.error(
            `Sync operation threw while applying server response: ${(error as Error)?.message ?? error}`,
          )
          releaseLock()
          this.handleThrownSyncFailure(error, online)
          this.settlePendingSyncRequestsAfterFailure(inTimeResolveQueue)
        }
        return
      }

      if (this.dealloced) {
        return
      }

      /**
       * From here on opStatus owns serialization. Release this short preparation
       * lock before any follow-up sync is spawned; finally remains as an idempotent
       * safety net for every earlier return/throw.
       */
      releaseLock()

      const { hasError } = await this.handleSyncOperationFinish(
        operation,
        options,
        neverSyncedDeleted,
        syncMode,
        localOnlyPersistedItems,
        frozenDirtyIndex,
        isReadOnlySession,
      )

      this.applyOnlineSyncResult(hasError, online)

      if (hasError) {
        this.settlePendingSyncRequestsAfterFailure(inTimeResolveQueue)
        return
      }

      const didSyncAgain = await this.potentiallySyncAgainAfterSyncCompletion(
        syncMode,
        options,
        inTimeResolveQueue,
        online,
        isReadOnlySession,
      )
      if (didSyncAgain) {
        return
      }

      if (options.checkIntegrity && online) {
        await this.notifyEventSync(SyncEvent.SyncRequestsIntegrityCheck, {
          source: options.source as SyncSource,
        })
      }

      const hasUnuploadableReadOnlyDirtyItems =
        isReadOnlySession && (this.itemsNeedingSync().length > 0 || this.dirtyLiteItems().length > 0)
      if (!hasUnuploadableReadOnlyDirtyItems) {
        await this.notifyEventSync(SyncEvent.SyncCompletedWithAllItemsUploadedAndDownloaded, {
          source: options.source,
          options,
        })
      }

      this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)

      return undefined
    } catch (error) {
      if (!this.dealloced) {
        this.logger.error(`Sync failed before completion: ${(error as Error)?.message ?? error}`)
        if (this.isLocalPersistenceFailure(error)) {
          this.handleThrownSyncFailure(error, online ?? false)
        } else if (this.opStatus.syncInProgress) {
          this.opStatus.setDidEnd()
        }
        this.settlePendingSyncRequestsAfterFailure(inTimeResolveQueue)
      }

      /**
       * Local durability failures are already surfaced via DatabaseWriteError and
       * SyncError. By default preserve sync()'s historical background-safe contract
       * so existing fire-and-forget callers do not gain unhandled rejections. Direct
       * persistPayloads callers, and the explicit pre-sync acknowledgement case below,
       * still receive the original rejection.
       */
      if (this.isLocalPersistenceFailure(error)) {
        /**
         * onPresyncSave is an explicit acknowledgement contract used by components:
         * its sole caller reports save failure from sync().catch(). If preparation
         * failed before that acknowledgement, preserve the rejection for that caller.
         * Later sync failures remain event-driven so an already-sent success reply is
         * not followed by a contradictory error reply.
         */
        if (!presyncSaveCompleted && options.onPresyncSave) {
          throw error
        }
        return
      }

      throw error
    } finally {
      releaseLock()
    }
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

    await this.emitDeltasAndPersist([emit])

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

    /**
     * D4: a genuine write failure here MUST abort before the token advance below.
     * emitDeltasAndPersist restores any dirty payloads it tentatively finalized, while
     * preserving a newer edit that lands during the write.
     */
    await this.emitDeltasAndPersist(emits)

    if (!operation.options.sharedVaultUuids) {
      await this.setSyncTokens(response.lastSyncToken as string, response.paginationToken as string | undefined)
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
          DecryptedPayloadInterface<ItemsKeyContent | KeySystemItemsKeyContent> | undefined =
          map[encrypted.items_key_id as string]

        const itemsKey = previouslyProcessedItemsKey
          ? (CreateDecryptedItemFromPayload(previouslyProcessedItemsKey) as
              ItemsKeyInterface | KeySystemItemsKeyInterface)
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
    localOnlyPersistedItems: DecryptedItemInterface[] = [],
    frozenDirtyIndex = getCurrentDirtyIndex(),
    isReadOnlySession = false,
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

    await this.clearDirtyStateForPersistedLocalOnlyItems(localOnlyPersistedItems, frozenDirtyIndex)

    if (syncMode !== SyncMode.DownloadFirst && !isReadOnlySession) {
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
    isReadOnlySession = false,
  ) {
    if (syncMode === SyncMode.DownloadFirst) {
      if (isReadOnlySession) {
        if (online) {
          this.completedOnlineDownloadFirstSync = true
        }
        await this.notifyEvent(SyncEvent.DownloadFirstSyncCompleted)
      } else {
        await this.handleDownloadFirstCompletionAndSyncAgain(online, options)
        this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)
        return true
      }
    }

    const spawnedRequest = this.popSpawnQueue()
    if (spawnedRequest) {
      if (options.awaitAll) {
        await spawnedRequest
      }
      this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)
      return true
    }

    const resolveQueueHasRequestsThatDidntMakeItInTime = this.resolveQueue.length > 0
    if (resolveQueueHasRequestsThatDidntMakeItInTime) {
      await this.syncAgainByHandlingRequestsWaitingInResolveQueue(options)
      this.resolvePendingSyncRequestsThatMadeItInTimeOfCurrentRequest(inTimeResolveQueue)
      return true
    }

    const newItemsNeedingSync = this.itemsNeedingSync()
    if (newItemsNeedingSync.length > 0) {
      if (isReadOnlySession) {
        this.logger.debug('Read-only session still has local dirty items; not spawning an unbounded empty sync.')
        return false
      }

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

    await this.emitDeltasAndPersist([
      {
        emits: payloads,
        source: PayloadEmitSource.LocalChanged,
      },
    ])
  }

  /**
   * A dirty local-only item is PERSISTED locally (prepareForSync writes it to disk so it survives
   * reload) but is deliberately excluded from the upload set, so no server response
   * (DeltaRemoteSaved/DeltaOfflineSaved) will ever clear its dirty flag. Left dirty, it makes
   * itemsNeedingSync() perpetually non-empty and potentiallySyncAgainAfterSyncCompletion re-spawn
   * sync forever (sync() never resolves — the infinite-loop regression from 55785604).
   *
   * Clear it locally here, at sync-finish, mirroring handleNeverSyncedDeleted (persist/handle →
   * clear dirty locally). Race-safe: mirror payloadByFinalizingSyncState — keep it dirty only if a
   * newer edit advanced its dirtyIndex PAST the sync-begin snapshot (frozenDirtyIndex, the exact
   * comparison the server/offline finalize path uses), so a concurrent edit is never clobbered (it
   * re-persists + re-attempts next cycle). Its CONTENT and localOnly flag are unchanged; only dirty
   * is cleared. Runs BEFORE potentiallySyncAgainAfterSyncCompletion, so the now-clean item is no
   * longer returned by itemsNeedingSync() and the re-sync loop terminates. Success-path only
   * (handleSyncOperationFinish early-returns on error before reaching here).
   */
  private async clearDirtyStateForPersistedLocalOnlyItems(
    items: DecryptedItemInterface[],
    frozenDirtyIndex: number,
  ): Promise<void> {
    if (items.length === 0) {
      return
    }

    const payloads: DecryptedPayloadInterface[] = []
    for (const item of items) {
      const live = this.itemManager.findItem(item.uuid)
      if (!live || isLitePayload(live.payload)) {
        /** Gone or body-stripped since sync began — skip (never persist a lite/absent payload). */
        continue
      }

      const dirtyIndex = live.payload.dirtyIndex
      if (dirtyIndex != null && dirtyIndex > frozenDirtyIndex) {
        /** Re-dirtied by a concurrent edit after sync began — leave dirty so the edit is preserved. */
        continue
      }

      payloads.push(
        new DecryptedPayload({
          ...live.payload.ejected(),
          dirty: false,
          dirtyIndex: undefined,
        }),
      )
    }

    if (payloads.length === 0) {
      return
    }

    await this.emitDeltasAndPersist([
      {
        emits: payloads,
        source: PayloadEmitSource.LocalChanged,
      },
    ])
  }

  /**
   * Apply resolved payloads through the authoritative mapping queue, then make the
   * exact applied set durable. If persistence fails, restore the pre-emit payloads
   * only when the failed emission is still current. A user edit that lands while
   * the disk write is pending replaces the emitted object, so the identity check
   * deliberately leaves that newer dirty revision untouched.
   */
  private async emitDeltasAndPersist(emits: DeltaEmit[]): Promise<FullyFormedPayloadInterface[]> {
    const originals = new Map<string, FullyFormedPayloadInterface | undefined>()
    const baseCollection = this.payloadManager.getMasterCollection()

    for (const emit of emits) {
      for (const payload of emit.emits) {
        if (!originals.has(payload.uuid)) {
          originals.set(payload.uuid, baseCollection.find(payload.uuid))
        }
      }
    }

    const appliedPayloads: FullyFormedPayloadInterface[] = []

    try {
      for (const emit of emits) {
        appliedPayloads.push(...(await this.payloadManager.emitDeltaEmit(emit)))
      }

      await this.persistPayloads(appliedPayloads)
      return appliedPayloads
    } catch (error) {
      await this.restorePayloadsAfterFailedPersistence(originals, appliedPayloads)
      throw error
    }
  }

  private async restorePayloadsAfterFailedPersistence(
    originals: Map<string, FullyFormedPayloadInterface | undefined>,
    appliedPayloads: FullyFormedPayloadInterface[],
  ): Promise<void> {
    const lastAppliedByUuid = new Map<string, FullyFormedPayloadInterface>()
    for (const payload of appliedPayloads) {
      lastAppliedByUuid.set(payload.uuid, payload)
    }

    const currentCollection = this.payloadManager.getMasterCollection()
    const rollbackPayloads: FullyFormedPayloadInterface[] = []

    for (const [uuid, applied] of lastAppliedByUuid) {
      const current = currentCollection.find(uuid)
      const appliedDeletionIsStillCurrent = isDeletedPayload(applied) && applied.discardable && current == undefined
      if (current !== applied && !appliedDeletionIsStillCurrent) {
        continue
      }

      const original = originals.get(uuid)
      if (original) {
        rollbackPayloads.push(original)
      } else if (current === applied) {
        rollbackPayloads.push(
          new DeletedPayload({
            ...applied.ejected(),
            content: undefined,
            deleted: true,
            dirty: false,
            dirtyIndex: undefined,
          }),
        )
      }
    }

    if (rollbackPayloads.length === 0) {
      return
    }

    try {
      await this.payloadManager.emitPayloads(rollbackPayloads, PayloadEmitSource.LocalChanged)
    } catch (rollbackError) {
      this.logger.error('Failed to restore in-memory payloads after local persistence failure', rollbackError)
    }
  }

  public async persistPayloads(
    payloads: FullyFormedPayloadInterface[],
    options: { throwError: boolean; rethrowGenuineWriteFailure?: boolean } = { throwError: true },
  ): Promise<void> {
    await this.persistPayloadsWithResult(payloads, options)
  }

  private async persistPayloadsWithResult(
    payloads: FullyFormedPayloadInterface[],
    options: { throwError: boolean; rethrowGenuineWriteFailure?: boolean } = { throwError: true },
  ): Promise<boolean> {
    if (payloads.length === 0 || this.dealloced) {
      return payloads.length === 0
    }

    /**
     * SAFETY TRIPWIRE: a content-stripped (lite) payload must never be written to disk. Persisting
     * one would overwrite the real on-disk ciphertext with a body-less payload = irreversible data
     * loss. Every upstream path is expected to re-hydrate full content before persisting; this
     * unconditional guard ensures any future path that fails to do so aborts loudly instead of
     * silently losing data. (In normal operation no lite payload reaches here, so it never throws.)
     */
    assertNoLitePayloads(payloads, 'SyncService.persistPayloads')

    return this.storageService
      .savePayloads(payloads)
      .then(() => true)
      .catch((error) => {
        /**
         * DATA-LOSS GUARD: `throwError:false` is used to suppress the EXPECTED, transient
         * key-not-found error when signing into an 003/non-latest account (the temporary items key
         * doesn't yet match the account version; it self-heals after download-first sync). It must NOT
         * also swallow a genuine WRITE failure — e.g. a QuotaExceededError during a full-vault
         * re-persist — which would silently leave dirtied-in-memory items unwritten to disk. Surface
         * any non-key (write/quota/IO) failure even when throwError is false, so the UI can react and
         * the user isn't left with unsaved data they believe is saved.
         */
        const isSuppressibleKeyError = SyncService.isSuppressibleKeyLookupError(error)
        if (options.throwError || !isSuppressibleKeyError) {
          this.notifyEventDetached(SyncEvent.DatabaseWriteError, error, 'payload persistence failure')
          SNLog.error(error)
        }
        /**
         * Genuine local write failures reject by default on every sync persistence path.
         * This prevents callers from reporting a successful pre-sync/offline/websocket
         * save, clearing dirty state, or advancing a token past data that never committed.
         * The expected legacy key-lookup failure remains suppressible for download-first
         * self-healing; an explicit rethrowGenuineWriteFailure:false is the only opt-out.
         */
        if (options.rethrowGenuineWriteFailure !== false && !isSuppressibleKeyError) {
          this.throwLocalPersistenceFailure(error)
        }

        return false
      })
  }

  private throwLocalPersistenceFailure(error: unknown): never {
    const persistenceFailure =
      typeof error === 'object' && error !== null ? error : Error(`Local persistence failed: ${String(error)}`)
    this.localPersistenceFailures.add(persistenceFailure)
    throw persistenceFailure
  }

  private isLocalPersistenceFailure(error: unknown): boolean {
    return typeof error === 'object' && error !== null && this.localPersistenceFailures.has(error)
  }

  /**
   * Classifies a persist error as the EXPECTED, transient "key not found" case (signing into an
   * 003/non-latest account before the correct items key is downloaded) — the only case the
   * `throwError:false` callers intend to suppress. Everything else (write/quota/IO failures) is a
   * genuine persistence failure that must be surfaced. Pure + static for unit-testing.
   */
  static isSuppressibleKeyLookupError(error: unknown): boolean {
    if (!error) {
      return false
    }

    /** QuotaExceeded (and any DOMException) is a real write failure — never suppress it. */
    const name = (error as { name?: string }).name
    if (name === 'QuotaExceededError') {
      return false
    }

    const message = typeof error === 'string' ? error : (error as { message?: string }).message
    if (typeof message !== 'string') {
      return false
    }

    const normalized = message.toLowerCase()
    const isKeyLookupFailure =
      (normalized.includes('key') &&
        (normalized.includes('cannot find') ||
          normalized.includes('find') ||
          normalized.includes('no root key') ||
          normalized.includes('not found'))) ||
      normalized.includes('no root key')

    return isKeyLookupFailure
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
        this.scheduleDebouncedLiveSync()
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
    this.syncDetached(
      { source: SyncSource.External, sourceDescription: 'WebSocket reconnect backfill' },
      'websocket reconnect backfill',
    )
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
   * The pushed payloads are run through the SAME decryption + conflict resolver as
   * HTTP-retrieved items. The resolved batch is emitted, durably persisted, and only
   * then is the sync token advanced. A failed write conditionally restores the prior
   * in-memory payloads without overwriting a newer edit, then falls back to HTTP.
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
      this.syncDetached(
        { source: SyncSource.External, sourceDescription: `WebSocket push fallback: ${reason}` },
        `websocket push fallback: ${reason}`,
      )
    }

    if (!this.databaseLoaded || this.opStatus.syncInProgress || this.isSyncLocked()) {
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
    const lockOwner = this.tryAcquireSyncLock()
    if (!lockOwner) {
      triggerReconcilingHttpSync('sync busy or database not loaded')
      return
    }

    let applyFailed = false
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

      await this.emitDeltasAndPersist(emits)

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
      this.logger.error('Failed to apply websocket sync push; falling back to HTTP sync', error)
      applyFailed = true
    } finally {
      this.releaseSyncLock(lockOwner)
    }

    if (applyFailed) {
      /**
       * Start fallback only after releasing our owner token; otherwise the fallback
       * observes the websocket lock and queues behind a request that has already ended.
       * Websocket delivery is an automatic/background path, so the database error event
       * and HTTP fallback surface/retry the failure without creating an unhandled
       * rejection contract for the event bus.
       */
      triggerReconcilingHttpSync('apply error')
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

    await this.emitDeltasAndPersist([emit])
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

  ut_setDatabaseLoaded(loaded: boolean): void {
    this.databaseLoaded = loaded
  }

  /** @e2e_testing */

  ut_clearLastSyncDate(): void {
    this.lastSyncDate = undefined
  }

  /** @e2e_testing */

  ut_beginLatencySimulator(latency: number): void {
    this._simulate_latency = {
      latency: latency || 1000,
      enabled: true,
    }
  }

  /** @e2e_testing */

  ut_endLatencySimulator(): void {
    this._simulate_latency = undefined
  }
}
