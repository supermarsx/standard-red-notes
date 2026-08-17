import { Copy, extendArray, UuidGenerator, Uuids } from '@standardnotes/utils'
import { SNLog } from '../../Log'
import {
  KeyedDecryptionSplit,
  KeyedEncryptionSplit,
  SplitPayloadsByEncryptionType,
  CreateEncryptionSplitWithKeyLookup,
  isErrorDecryptingParameters,
  SNRootKey,
} from '@standardnotes/encryption'
import {
  AbstractService,
  StorageServiceInterface,
  InternalEventHandlerInterface,
  StoragePersistencePolicies,
  StorageValuesObject,
  DeviceInterface,
  InternalEventBusInterface,
  InternalEventInterface,
  ApplicationEvent,
  ApplicationStageChangedEventPayload,
  ApplicationStage,
  ValueModesKeys,
  StorageValueModes,
  namespacedKey,
  RawStorageKey,
  WrappedStorageValue,
  ValuesObjectRecord,
  EncryptionProviderInterface,
} from '@standardnotes/services'
import {
  CreateDecryptedLocalStorageContextPayload,
  CreateDeletedLocalStorageContextPayload,
  CreateEncryptedLocalStorageContextPayload,
  CreatePayloadSplitWithDiscardables,
  DecryptedPayload,
  EncryptedPayload,
  FullyFormedPayloadInterface,
  isEncryptedLocalStoragePayload,
  ItemContent,
  DecryptedPayloadInterface,
  DeletedPayloadInterface,
  PayloadTimestampDefaults,
  LocalStorageEncryptedContextualPayload,
  FullyFormedTransferPayload,
} from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'

const STORAGE_OBJECT_GENERATION_KEY = 'storage_object_generation' as const
const STORAGE_OBJECT_GENERATION_RAW_KEY = 'storage_object_generation'
const STALE_STORAGE_CONTEXT_ERROR =
  'Storage context was cleared by another application instance; reload before writing.'

type StorageValuesObjectWithMetadata = StorageValuesObject & {
  [STORAGE_OBJECT_GENERATION_KEY]?: number
}

type PendingKeyValueMutation = {
  key: string
  mode: StorageValueModes
  value: unknown
  deleted: boolean
  version: number
  observedGeneration: number
  clearVersion?: number
}

type PendingKeyValueMutationSnapshot = {
  clearVersion?: number
  mutations: PendingKeyValueMutation[]
}

type FreshStorageValues = {
  values: StorageValuesObject
  generationMarkerPersisted: boolean
}

const STORAGE_OBJECT_MUTATION_LOCK_PREFIX = 'standard-red-notes-storage-object-mutation:'
const STORAGE_OBJECT_PROCESS_QUEUE_KEY = Symbol.for('standard-red-notes.storage-object-mutation-queues')
const processGlobal = globalThis as unknown as Record<symbol, unknown>
const storageObjectMutationQueues =
  (processGlobal[STORAGE_OBJECT_PROCESS_QUEUE_KEY] as Map<string, Promise<void>> | undefined) ??
  new Map<string, Promise<void>>()
processGlobal[STORAGE_OBJECT_PROCESS_QUEUE_KEY] = storageObjectMutationQueues

/**
 * Web Locks coordinate separate same-origin browsing contexts. The process
 * queue coordinates service instances sharing one loaded JavaScript
 * module/realm and is the process-local fallback for non-browser runtimes
 * without Web Locks. A lease-based localStorage fallback is intentionally
 * avoided because a suspended context can outlive its lease and permit
 * overlapping writes.
 */
function enqueueProcessStorageObjectMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = storageObjectMutationQueues.get(key) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )

  storageObjectMutationQueues.set(key, tail)
  void tail.then(() => {
    if (storageObjectMutationQueues.get(key) === tail) {
      storageObjectMutationQueues.delete(key)
    }
  })

  return run
}

/**
 * The storage service is responsible for persistence of both simple key-values, and payload
 * storage. It does so by relying on deviceInterface to save and retrieve raw values and payloads.
 * For simple key/values, items are grouped together in an in-memory hash, and persisted to disk
 * as a single object (encrypted, when possible). It handles persisting payloads in the local
 * database by encrypting the payloads when possible.
 * The storage service also exposes methods that allow the application to initially
 * decrypt the persisted key/values, and also a method to determine whether a particular
 * key can decrypt wrapped storage.
 */
export class DiskStorageService
  extends AbstractService
  implements StorageServiceInterface, InternalEventHandlerInterface
{
  private encryptionProvider!: EncryptionProviderInterface
  private storagePersistable = false
  private persistencePolicy!: StoragePersistencePolicies
  private needsPersist = false
  private currentPersistPromise?: Promise<unknown>
  private keyValueWriteQueue: Promise<unknown> = Promise.resolve()
  private keyValueMutationVersions = new Map<string, number>()
  private pendingKeyValueMutations = new Map<string, PendingKeyValueMutation>()
  private pendingClearVersion?: number
  private keyValueMutationSequence = 0
  private observedStorageObjectGeneration = 0

  private values!: StorageValuesObject

  /**
   * Serializes on-disk payload WRITES (savePayloads / deletePayloadsWithUuids /
   * deletePayloadWithUuid / clearAllPayloads / clearAllData) so that they never
   * interleave. Without this, a delete could race a save re-adding the same uuid,
   * or clearAllData could race a save leaving resurrected entries, producing a
   * nondeterministic / half-written on-disk state. Reads are intentionally NOT
   * routed through this queue because IDB isolates reads.
   */
  private storageWriteQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private device: DeviceInterface,
    private identifier: string,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
    void this.setPersistencePolicy(StoragePersistencePolicies.Default)
  }

  public provideEncryptionProvider(provider: EncryptionProviderInterface): void {
    this.encryptionProvider = provider
  }

  public override deinit() {
    ;(this.device as unknown) = undefined
    ;(this.encryptionProvider as unknown) = undefined
    this.storagePersistable = false
    super.deinit()
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type === ApplicationEvent.ApplicationStageChanged) {
      const stage = (event.payload as ApplicationStageChangedEventPayload).stage
      if (stage === ApplicationStage.Launched_10) {
        this.storagePersistable = true
        if (this.needsPersist) {
          void this.persistValuesToDisk()
        }
      }
    }
  }

  public async setPersistencePolicy(persistencePolicy: StoragePersistencePolicies) {
    this.persistencePolicy = persistencePolicy

    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      await this.withStorageObjectMutationLock(async () => {
        const generation = this.nextClearingStorageObjectGeneration(await this.readDurableStorageObjectGeneration())
        await this.persistStorageGenerationTombstone(generation)
        try {
          await this.device.clearNamespacedKeychainValue(this.identifier)
          await this.device.removeAllDatabaseEntries(this.identifier)
          await this.device.removeRawStorageValuesForIdentifier(this.identifier)
          await this.persistStorageGenerationTombstone(generation)
          await this.persistStorageGenerationTombstone(this.nextStableStorageObjectGeneration(generation), false)
        } catch (error) {
          await this.persistStorageGenerationTombstone(generation)
          throw error
        }
      })
    }
  }

  public isEphemeralSession(): boolean {
    return this.persistencePolicy === StoragePersistencePolicies.Ephemeral
  }

  public async initializeFromDisk(): Promise<void> {
    const [value, rawGeneration] = await Promise.all([
      this.device.getRawStorageValue(this.getPersistenceKey()),
      this.device.getRawStorageValue(this.getGenerationPersistenceKey()),
    ])
    const values = value ? (JSON.parse(value as string) as StorageValuesObjectWithMetadata) : undefined
    const authoritativeGeneration = this.authoritativeStorageObjectGeneration(rawGeneration, values)
    const valuesAreCurrent =
      this.isStableStorageObjectGeneration(authoritativeGeneration) &&
      (rawGeneration === undefined || this.storageObjectGeneration(values) === authoritativeGeneration)
    const initialValues = valuesAreCurrent ? (values ?? this.defaultValuesObject()) : this.defaultValuesObject()
    this.setStorageObjectGeneration(initialValues, authoritativeGeneration)

    this.pendingKeyValueMutations.clear()
    this.pendingClearVersion = undefined
    this.observedStorageObjectGeneration = valuesAreCurrent ? authoritativeGeneration : -1
    await this.setInitialValues(initialValues)
  }

  public async isStorageContextCurrent(): Promise<boolean> {
    const observedGeneration = this.observedStorageObjectGeneration
    if (!this.values || observedGeneration < 0 || !this.isStableStorageObjectGeneration(observedGeneration)) {
      return false
    }

    try {
      return await this.withStorageObjectMutationLock(async () => {
        const durableState = await this.readDurableStorageObjectState()
        return (
          durableState.objectMatchesGeneration &&
          durableState.generation === observedGeneration &&
          this.isStableStorageObjectGeneration(durableState.generation)
        )
      })
    } catch {
      return false
    }
  }

  private async setInitialValues(values?: StorageValuesObject) {
    const sureValues = values || this.defaultValuesObject()

    if (!sureValues[ValueModesKeys.Unwrapped]) {
      sureValues[ValueModesKeys.Unwrapped] = {}
    }

    this.values = sureValues

    if (!this.isStorageWrapped()) {
      this.values[ValueModesKeys.Unwrapped] = {
        ...(this.values[ValueModesKeys.Wrapped].content as object),
        ...this.values[ValueModesKeys.Unwrapped],
      }
    }
  }

  public isStorageWrapped(): boolean {
    const wrappedValue = this.values[ValueModesKeys.Wrapped]

    return wrappedValue != undefined && isEncryptedLocalStoragePayload(wrappedValue)
  }

  public async canDecryptWithKey(key: SNRootKey): Promise<boolean> {
    const wrappedValue = this.values[ValueModesKeys.Wrapped]

    if (!isEncryptedLocalStoragePayload(wrappedValue)) {
      throw Error('Attempting to decrypt non decrypted storage value')
    }

    const decryptedPayload = await this.decryptWrappedValue(wrappedValue, key)
    return !isErrorDecryptingParameters(decryptedPayload)
  }

  private async decryptWrappedValue(wrappedValue: LocalStorageEncryptedContextualPayload, key?: SNRootKey) {
    /**
     * The read content type doesn't matter, so long as we know it responds
     * to content type. This allows a more seamless transition when both web
     * and mobile used different content types for encrypted storage.
     */
    if (!wrappedValue?.content_type) {
      throw Error('Attempting to decrypt nonexistent wrapped value')
    }

    const payload = new EncryptedPayload({
      ...wrappedValue,
      ...PayloadTimestampDefaults(),
      content_type: ContentType.TYPES.EncryptedStorage,
    })

    const split: KeyedDecryptionSplit = key
      ? {
          usesRootKey: {
            items: [payload],
            key: key,
          },
        }
      : {
          usesRootKeyWithKeyLookup: {
            items: [payload],
          },
        }

    const decryptedPayload = await this.encryptionProvider.decryptSplitSingle(split)

    return decryptedPayload
  }

  public async decryptStorage(): Promise<void> {
    const wrappedValue = this.values[ValueModesKeys.Wrapped]

    if (!isEncryptedLocalStoragePayload(wrappedValue)) {
      throw Error('Attempting to decrypt already decrypted storage')
    }

    const decryptedPayload = await this.decryptWrappedValue(wrappedValue)

    if (isErrorDecryptingParameters(decryptedPayload)) {
      throw SNLog.error(Error('Unable to decrypt storage.'))
    }

    this.values[ValueModesKeys.Unwrapped] = Copy(decryptedPayload.content)
  }

  /** @todo This function should be debounced. */
  private persistValuesToDisk(): Promise<void> {
    return this.enqueueKeyValueWrite(() => this.persistCurrentValuesToDisk())
  }

  /**
   * Persists the current cache from inside the key-value write queue. Keeping the
   * snapshot generation and raw replacement in the queue prevents an older,
   * slower encryption/write from landing after a newer checkpoint.
   */
  private async persistCurrentValuesToDisk(): Promise<void> {
    if (!this.storagePersistable) {
      this.needsPersist = true
      return
    }

    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      return
    }

    this.needsPersist = false

    await this.executeCriticalFunction(() =>
      this.withStorageObjectMutationLock(async () => {
        const fresh = await this.readFreshValuesFromDisk()
        if (!this.isStableStorageObjectGeneration(this.storageObjectGeneration(fresh.values))) {
          throw Error(STALE_STORAGE_CONTEXT_ERROR)
        }
        const snapshot = this.snapshotPendingKeyValueMutations()
        if (!this.snapshotHasApplicableMutations(fresh.values, snapshot)) {
          this.finishPersistingKeyValueMutations(snapshot, fresh.values, fresh.values)
          if (snapshot.mutations.length > 0) {
            throw Error(STALE_STORAGE_CONTEXT_ERROR)
          }
          return
        }
        const mergedValues = this.applyPendingKeyValueMutations(fresh.values, snapshot)
        const generatedValues = await this.generatePersistableValues(mergedValues)

        const persistencePolicySuddenlyChanged = this.persistencePolicy === StoragePersistencePolicies.Ephemeral
        if (persistencePolicySuddenlyChanged) {
          return
        }

        const generatedGeneration = this.storageObjectGeneration(generatedValues)
        if (snapshot.clearVersion !== undefined || (generatedGeneration > 0 && !fresh.generationMarkerPersisted)) {
          await this.device.setRawStorageValue(this.getGenerationPersistenceKey(), String(generatedGeneration))
        }
        await this.device.setRawStorageValue(this.getPersistenceKey(), JSON.stringify(generatedValues))
        this.finishPersistingKeyValueMutations(snapshot, mergedValues, generatedValues)
      }),
    )
  }

  private withStorageObjectMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const persistenceKey = this.getPersistenceKey()

    return enqueueProcessStorageObjectMutation(persistenceKey, async () => {
      const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined
      if (lockManager && typeof lockManager.request === 'function') {
        return lockManager.request(
          `${STORAGE_OBJECT_MUTATION_LOCK_PREFIX}${persistenceKey}`,
          { mode: 'exclusive' },
          operation,
        )
      }

      return operation()
    })
  }

  /**
   * Reads and decrypts the latest physical storage object while the shared
   * mutation lock is held. Never use this instance's cache as the merge base:
   * another tab may have committed a newer object since initialization.
   */
  private async readFreshValuesFromDisk(): Promise<FreshStorageValues> {
    const [rawValue, rawGeneration] = await Promise.all([
      this.device.getRawStorageValue(this.getPersistenceKey()),
      this.device.getRawStorageValue(this.getGenerationPersistenceKey()),
    ])
    const parsedValues = rawValue ? (JSON.parse(rawValue) as Partial<StorageValuesObjectWithMetadata>) : undefined
    const authoritativeGeneration = this.authoritativeStorageObjectGeneration(rawGeneration, parsedValues)
    const valuesAreCurrent =
      this.isStableStorageObjectGeneration(authoritativeGeneration) &&
      (rawGeneration === undefined || this.storageObjectGeneration(parsedValues) === authoritativeGeneration)
    const persistedValues = valuesAreCurrent ? parsedValues : undefined
    const wrappedValue = persistedValues?.[ValueModesKeys.Wrapped]
    let wrappedContent: ValuesObjectRecord = {}

    if (wrappedValue && isEncryptedLocalStoragePayload(wrappedValue)) {
      const decryptedPayload = await this.decryptWrappedValue(wrappedValue)
      if (isErrorDecryptingParameters(decryptedPayload)) {
        throw SNLog.error(Error('Unable to decrypt the latest storage object before persisting.'))
      }
      wrappedContent = Copy(decryptedPayload.content) as ValuesObjectRecord
    } else if (wrappedValue?.content) {
      wrappedContent = Copy(wrappedValue.content) as ValuesObjectRecord
    }

    const values = this.defaultValuesObject(
      wrappedValue,
      {
        ...wrappedContent,
        ...(Copy(persistedValues?.[ValueModesKeys.Unwrapped] ?? {}) as ValuesObjectRecord),
      },
      Copy(persistedValues?.[ValueModesKeys.Nonwrapped] ?? {}),
    )
    this.setStorageObjectGeneration(values, authoritativeGeneration)
    return { values, generationMarkerPersisted: rawGeneration !== undefined }
  }

  private authoritativeStorageObjectGeneration(
    rawGeneration: string | undefined,
    values?: Partial<StorageValuesObjectWithMetadata>,
  ): number {
    if (rawGeneration === undefined) {
      return this.storageObjectGeneration(values)
    }

    const generation = Number(rawGeneration)
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw Error('Invalid durable storage object generation; refusing to load or overwrite local storage.')
    }

    return generation
  }

  private storageObjectGeneration(values?: Partial<StorageValuesObjectWithMetadata>): number {
    const generation = values?.[STORAGE_OBJECT_GENERATION_KEY]
    return Number.isSafeInteger(generation) && (generation as number) >= 0 ? (generation as number) : 0
  }

  private setStorageObjectGeneration(values: StorageValuesObject, generation: number): void {
    ;(values as StorageValuesObjectWithMetadata)[STORAGE_OBJECT_GENERATION_KEY] = generation
  }

  private nextStorageObjectGeneration(currentGeneration: number): number {
    if (currentGeneration >= Number.MAX_SAFE_INTEGER) {
      throw Error('Storage object clear generation is exhausted; refusing to clear without a durable epoch advance.')
    }

    return currentGeneration + 1
  }

  private isStableStorageObjectGeneration(generation: number): boolean {
    return generation % 2 === 0
  }

  private nextClearingStorageObjectGeneration(currentGeneration: number): number {
    const stableGeneration = this.isStableStorageObjectGeneration(currentGeneration)
      ? currentGeneration
      : this.nextStorageObjectGeneration(currentGeneration)
    return this.nextStorageObjectGeneration(stableGeneration)
  }

  private nextStableStorageObjectGeneration(currentGeneration: number): number {
    const clearingGeneration = this.isStableStorageObjectGeneration(currentGeneration)
      ? this.nextStorageObjectGeneration(currentGeneration)
      : currentGeneration
    return this.nextStorageObjectGeneration(clearingGeneration)
  }

  private async readDurableStorageObjectState(): Promise<{
    generation: number
    objectMatchesGeneration: boolean
  }> {
    const [rawGeneration, rawValue] = await Promise.all([
      this.device.getRawStorageValue(this.getGenerationPersistenceKey()),
      this.device.getRawStorageValue(this.getPersistenceKey()),
    ])
    const values = rawValue ? (JSON.parse(rawValue) as Partial<StorageValuesObjectWithMetadata>) : undefined
    const generation = this.authoritativeStorageObjectGeneration(rawGeneration, values)

    return {
      generation,
      objectMatchesGeneration: rawGeneration === undefined || this.storageObjectGeneration(values) === generation,
    }
  }

  private async readDurableStorageObjectGeneration(): Promise<number> {
    return (await this.readDurableStorageObjectState()).generation
  }

  private async runPayloadMutationForGeneration<T>(
    observedGeneration: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withStorageObjectMutationLock(async () => {
      await this.assertCurrentStableStorageGeneration(observedGeneration)

      return operation()
    })
  }

  private async runPayloadReadForGeneration<T>(observedGeneration: number, operation: () => Promise<T>): Promise<T> {
    return this.withStorageObjectMutationLock(async () => {
      await this.assertCurrentStableStorageGeneration(observedGeneration)
      const result = await operation()
      await this.assertCurrentStableStorageGeneration(observedGeneration)
      return result
    })
  }

  private async assertCurrentStableStorageGeneration(observedGeneration: number): Promise<void> {
    const durableState = await this.readDurableStorageObjectState()
    if (
      !durableState.objectMatchesGeneration ||
      durableState.generation !== observedGeneration ||
      !this.isStableStorageObjectGeneration(durableState.generation)
    ) {
      throw Error(STALE_STORAGE_CONTEXT_ERROR)
    }
  }

  private storageGenerationTombstone(generation: number): StorageValuesObject {
    const tombstone = this.defaultValuesObject()
    this.setStorageObjectGeneration(tombstone, generation)
    return tombstone
  }

  private async persistStorageGenerationTombstone(generation: number, markerFirst = true): Promise<void> {
    const tombstone = this.storageGenerationTombstone(generation)
    const persistMarker = () => this.device.setRawStorageValue(this.getGenerationPersistenceKey(), String(generation))
    const persistTombstone = () => this.device.setRawStorageValue(this.getPersistenceKey(), JSON.stringify(tombstone))
    if (markerFirst) {
      await persistMarker()
      await persistTombstone()
    } else {
      await persistTombstone()
      await persistMarker()
    }
    this.pendingKeyValueMutations.clear()
    this.pendingClearVersion = undefined
    this.observedStorageObjectGeneration = generation
    this.values = tombstone
    this.needsPersist = false
  }

  private snapshotPendingKeyValueMutations(): PendingKeyValueMutationSnapshot {
    return {
      clearVersion: this.pendingClearVersion,
      mutations: [...this.pendingKeyValueMutations.values()].map((mutation) => ({
        ...mutation,
        value: mutation.deleted ? undefined : Copy(mutation.value),
      })),
    }
  }

  private applyPendingKeyValueMutations(
    freshValues: StorageValuesObject,
    snapshot: PendingKeyValueMutationSnapshot,
  ): StorageValuesObject {
    const freshGeneration = this.storageObjectGeneration(freshValues)
    const isClear = snapshot.clearVersion !== undefined
    const mergedValues = isClear
      ? this.defaultValuesObject()
      : this.defaultValuesObject(
          freshValues[ValueModesKeys.Wrapped],
          Copy(freshValues[ValueModesKeys.Unwrapped]),
          Copy(freshValues[ValueModesKeys.Nonwrapped]),
        )
    const mergedGeneration = isClear ? this.nextStableStorageObjectGeneration(freshGeneration) : freshGeneration
    this.setStorageObjectGeneration(mergedValues, mergedGeneration)

    for (const mutation of snapshot.mutations) {
      if (!this.mutationAppliesToGeneration(mutation, freshGeneration, snapshot.clearVersion)) {
        continue
      }

      const domain = mergedValues[this.domainKeyForMode(mutation.mode)]
      if (mutation.deleted) {
        delete domain[mutation.key]
      } else {
        domain[mutation.key] = Copy(mutation.value)
      }
    }

    return mergedValues
  }

  private mutationAppliesToGeneration(
    mutation: PendingKeyValueMutation,
    freshGeneration: number,
    clearVersion?: number,
  ): boolean {
    return clearVersion !== undefined
      ? mutation.clearVersion === clearVersion
      : mutation.observedGeneration === freshGeneration
  }

  private snapshotHasApplicableMutations(
    freshValues: StorageValuesObject,
    snapshot: PendingKeyValueMutationSnapshot,
  ): boolean {
    if (snapshot.clearVersion !== undefined) {
      return true
    }

    const freshGeneration = this.storageObjectGeneration(freshValues)
    return snapshot.mutations.some((mutation) =>
      this.mutationAppliesToGeneration(mutation, freshGeneration, snapshot.clearVersion),
    )
  }

  /**
   * A setValue call can arrive while encryption or the device write is in
   * flight. Clear only mutations whose exact versions were committed, then
   * rebuild the cache from the committed object plus any newer pending edits.
   */
  private finishPersistingKeyValueMutations(
    snapshot: PendingKeyValueMutationSnapshot,
    mergedValues: StorageValuesObject,
    generatedValues: StorageValuesObject,
  ): void {
    const committedGeneration = this.storageObjectGeneration(mergedValues)

    if (snapshot.clearVersion !== undefined && this.pendingClearVersion === snapshot.clearVersion) {
      for (const mutation of this.pendingKeyValueMutations.values()) {
        if (mutation.clearVersion === snapshot.clearVersion) {
          mutation.observedGeneration = committedGeneration
          mutation.clearVersion = undefined
        }
      }
      this.pendingClearVersion = undefined
    }

    for (const mutation of snapshot.mutations) {
      const currentMutation = this.pendingKeyValueMutations.get(
        this.keyValueMutationVersionKey(mutation.key, mutation.mode),
      )
      if (currentMutation?.version === mutation.version) {
        this.pendingKeyValueMutations.delete(this.keyValueMutationVersionKey(mutation.key, mutation.mode))
      }
    }

    const committedValues = this.defaultValuesObject(
      generatedValues[ValueModesKeys.Wrapped],
      Copy(mergedValues[ValueModesKeys.Unwrapped]),
      Copy(mergedValues[ValueModesKeys.Nonwrapped]),
    )
    this.setStorageObjectGeneration(committedValues, committedGeneration)
    this.observedStorageObjectGeneration = committedGeneration
    const pendingSnapshot = this.snapshotPendingKeyValueMutations()
    this.values = this.applyPendingKeyValueMutations(committedValues, pendingSnapshot)
    this.values[ValueModesKeys.Wrapped] = generatedValues[ValueModesKeys.Wrapped]
    this.needsPersist = pendingSnapshot.clearVersion !== undefined || pendingSnapshot.mutations.length > 0
  }

  public async awaitPersist(): Promise<void> {
    await this.currentPersistPromise
  }

  /**
   * Serializes every simple key/value raw-storage replacement. The returned
   * promise retains this operation's rejection, while the queue tail is always
   * released so one device failure cannot poison later writes.
   */
  private enqueueKeyValueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.keyValueWriteQueue.then(operation, operation)

    this.keyValueWriteQueue = run.then(
      () => undefined,
      () => undefined,
    )
    this.currentPersistPromise = run

    return run
  }

  /**
   * Generates a payload that can be persisted to disk,
   * either as a plain object, or an encrypted item.
   */
  private async generatePersistableValues(values = this.values) {
    const rawContent = <Partial<StorageValuesObject>>Copy(values)

    const valuesToWrap = rawContent[ValueModesKeys.Unwrapped]
    rawContent[ValueModesKeys.Unwrapped] = undefined

    const payload = new DecryptedPayload({
      uuid: UuidGenerator.GenerateUuid(),
      content: valuesToWrap as unknown as ItemContent,
      content_type: ContentType.TYPES.EncryptedStorage,
      ...PayloadTimestampDefaults(),
    })

    if (this.encryptionProvider.hasRootKeyEncryptionSource()) {
      const split: KeyedEncryptionSplit = {
        usesRootKeyWithKeyLookup: {
          items: [payload],
        },
      }

      const encryptedPayload = await this.encryptionProvider.encryptSplitSingle(split)

      rawContent[ValueModesKeys.Wrapped] = CreateEncryptedLocalStorageContextPayload(encryptedPayload)
    } else {
      rawContent[ValueModesKeys.Wrapped] = CreateDecryptedLocalStorageContextPayload(payload)
    }

    return rawContent as StorageValuesObject
  }

  public setValue<T>(key: string, value: T, mode = StorageValueModes.Default): void {
    this.setValueWithNoPersist(key, value, mode)

    /**
     * D2 SWALLOW FIX: the in-memory value is already updated; the disk write is async.
     * Previously `void`-ing this dropped any rejection on the floor, so a failed write
     * left disk silently stale with no retry. Instead, flag `needsPersist` so the next
     * persist (or the Launched_10 stage handler) re-attempts the write, and log the
     * failure. Callers needing a guaranteed durable write use setValueAndAwaitPersist.
     */
    this.persistValuesToDisk().catch((error) => {
      this.needsPersist = !(error instanceof Error && error.message === STALE_STORAGE_CONTEXT_ERROR)
      SNLog.error(error as Error)
    })
  }

  public async setValueAndAwaitPersist<T>(key: string, value: T, mode = StorageValueModes.Default): Promise<void> {
    await this.setValuesAtomicallyAndAwaitPersist({ [key]: value }, mode)
  }

  public async setValuesAtomicallyAndAwaitPersist(
    values: Readonly<Record<string, unknown>>,
    mode = StorageValueModes.Default,
  ): Promise<void> {
    const observedGenerationAtInvocation = this.observedStorageObjectGeneration
    const clearVersionAtInvocation = this.pendingClearVersion
    await this.enqueueKeyValueWrite(async () => {
      if (!this.values) {
        throw Error('Attempting to atomically set storage values before loading local storage.')
      }

      const domainKey = this.domainKeyForMode(mode)
      const domain = this.values[domainKey]
      const previousNeedsPersist = this.needsPersist
      const mutationObservedGeneration =
        clearVersionAtInvocation !== undefined ? this.observedStorageObjectGeneration : observedGenerationAtInvocation
      const mutationClearVersion =
        clearVersionAtInvocation !== undefined && this.pendingClearVersion === clearVersionAtInvocation
          ? clearVersionAtInvocation
          : undefined
      const previousValues = new Map<
        string,
        {
          existed: boolean
          value: unknown
          appliedMutationVersion: number
          previousPendingMutation?: PendingKeyValueMutation
        }
      >()

      for (const [key, value] of Object.entries(values)) {
        const existed = Object.prototype.hasOwnProperty.call(domain, key)
        const previousValue = domain[key]
        const mutationKey = this.keyValueMutationVersionKey(key, mode)
        const previousPendingMutation = this.pendingKeyValueMutations.get(mutationKey)

        if (value === undefined) {
          delete domain[key]
        } else {
          domain[key] = value
        }

        previousValues.set(key, {
          existed,
          value: previousValue,
          appliedMutationVersion: this.recordKeyValueMutation(
            key,
            value,
            mode,
            mutationObservedGeneration,
            mutationClearVersion,
          ),
          previousPendingMutation,
        })
      }

      try {
        await this.persistCurrentValuesToDisk()
        if (mutationClearVersion === undefined && mutationObservedGeneration !== this.observedStorageObjectGeneration) {
          throw Error(STALE_STORAGE_CONTEXT_ERROR)
        }
      } catch (error) {
        for (const [key, previous] of previousValues) {
          if (this.getKeyValueMutationVersion(key, mode) !== previous.appliedMutationVersion) {
            continue
          }

          if (previous.existed) {
            domain[key] = previous.value
          } else {
            delete domain[key]
          }

          const mutationKey = this.keyValueMutationVersionKey(key, mode)
          if (previous.previousPendingMutation) {
            this.pendingKeyValueMutations.set(mutationKey, previous.previousPendingMutation)
            this.keyValueMutationVersions.set(mutationKey, previous.previousPendingMutation.version)
          } else {
            this.pendingKeyValueMutations.delete(mutationKey)
            this.keyValueMutationVersions.delete(mutationKey)
          }
        }
        this.needsPersist = previousNeedsPersist
        throw error
      }
    })
  }

  private setValueWithNoPersist(key: string, value: unknown, mode = StorageValueModes.Default): void {
    if (!this.values) {
      throw Error(`Attempting to set storage key ${key} before loading local storage.`)
    }

    const domainKey = this.domainKeyForMode(mode)
    const domainStorage = this.values[domainKey]
    if (value === undefined) {
      delete domainStorage[key]
    } else {
      domainStorage[key] = value
    }
    this.recordKeyValueMutation(key, value, mode)
  }

  private keyValueMutationVersionKey(key: string, mode: StorageValueModes): string {
    return `${mode}:${key}`
  }

  private getKeyValueMutationVersion(key: string, mode: StorageValueModes): number {
    return this.keyValueMutationVersions.get(this.keyValueMutationVersionKey(key, mode)) ?? 0
  }

  private recordKeyValueMutation(
    key: string,
    value: unknown,
    mode: StorageValueModes,
    observedGeneration = this.observedStorageObjectGeneration,
    clearVersion = this.pendingClearVersion,
  ): number {
    const mutationKey = this.keyValueMutationVersionKey(key, mode)
    const version = ++this.keyValueMutationSequence
    this.keyValueMutationVersions.set(mutationKey, version)
    this.pendingKeyValueMutations.set(mutationKey, {
      key,
      mode,
      value,
      deleted: value === undefined,
      version,
      observedGeneration,
      clearVersion,
    })
    return version
  }

  public getValue<T>(key: string, mode = StorageValueModes.Default, defaultValue?: T): T {
    if (!this.values) {
      throw Error(`Attempting to get storage key ${key} before loading local storage.`)
    }

    if (!this.values[this.domainKeyForMode(mode)]) {
      throw Error(`Storage domain mode not available ${mode} for key ${key}`)
    }

    const value = this.values[this.domainKeyForMode(mode)][key]

    return value != undefined ? (value as T) : (defaultValue as T)
  }

  public getAllKeys(mode = StorageValueModes.Default): string[] {
    if (!this.values) {
      throw Error('Attempting to get all keys before loading local storage.')
    }

    return Object.keys(this.values[this.domainKeyForMode(mode)])
  }

  public async removeValue(key: string, mode = StorageValueModes.Default): Promise<void> {
    if (!this.values) {
      throw Error(`Attempting to remove storage key ${key} before loading local storage.`)
    }

    await this.setValuesAtomicallyAndAwaitPersist({ [key]: undefined }, mode)
  }

  /**
   * Default persistence key. Platforms can override as needed.
   */
  private getPersistenceKey() {
    return namespacedKey(this.identifier, RawStorageKey.StorageObject)
  }

  private getGenerationPersistenceKey() {
    return namespacedKey(this.identifier, STORAGE_OBJECT_GENERATION_RAW_KEY)
  }

  private defaultValuesObject(
    wrapped?: WrappedStorageValue,
    unwrapped?: ValuesObjectRecord,
    nonwrapped?: ValuesObjectRecord,
  ) {
    return DiskStorageService.DefaultValuesObject(wrapped, unwrapped, nonwrapped)
  }

  public static DefaultValuesObject(
    wrapped: WrappedStorageValue = {} as WrappedStorageValue,
    unwrapped: ValuesObjectRecord = {},
    nonwrapped: ValuesObjectRecord = {},
  ) {
    return {
      [ValueModesKeys.Wrapped]: wrapped,
      [ValueModesKeys.Unwrapped]: unwrapped,
      [ValueModesKeys.Nonwrapped]: nonwrapped,
    } as StorageValuesObject
  }

  private domainKeyForMode(mode: StorageValueModes) {
    if (mode === StorageValueModes.Default) {
      return ValueModesKeys.Unwrapped
    } else if (mode === StorageValueModes.Nonwrapped) {
      return ValueModesKeys.Nonwrapped
    } else {
      throw Error('Invalid mode')
    }
  }

  /**
   * Clears simple values from storage only. Does not affect payloads.
   */
  async clearValues() {
    await this.enqueueKeyValueWrite(async () => {
      const previousValues = this.values
      const previousNeedsPersist = this.needsPersist
      const previousPendingMutations = new Map(this.pendingKeyValueMutations)
      const previousPendingClearVersion = this.pendingClearVersion
      await this.setInitialValues()
      const appliedMutationSequence = ++this.keyValueMutationSequence
      this.pendingKeyValueMutations.clear()
      this.pendingClearVersion = appliedMutationSequence

      try {
        await this.persistCurrentValuesToDisk()
      } catch (error) {
        if (this.keyValueMutationSequence === appliedMutationSequence) {
          this.values = previousValues
          this.pendingKeyValueMutations = previousPendingMutations
          this.pendingClearVersion = previousPendingClearVersion
        }
        this.needsPersist = previousNeedsPersist
        throw error
      }
    })
  }

  /**
   * Runs `operation` strictly after any previously-enqueued storage write has
   * settled, by chaining onto a single promise that represents the tail of the
   * write queue. The chained tail swallows the previous result/rejection so a
   * failure in one operation does not poison subsequent ones, while the returned
   * promise still surfaces this operation's own result/rejection to the caller.
   *
   * This cannot deadlock: the operation never awaits the queue from within
   * itself — `storageWriteQueue` is reassigned to the tail BEFORE `operation`
   * runs, so the operation only ever depends on writes that were enqueued
   * before it, not on itself. The queue is always advanced (it resolves whether
   * `operation` fulfills or rejects), so a rejection releases the queue for the
   * next write.
   */
  private enqueueStorageWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.storageWriteQueue.then(operation, operation)

    // Advance the tail regardless of success/failure so the next write is not
    // blocked by, nor sees the rejection of, this one.
    this.storageWriteQueue = run.then(
      () => undefined,
      () => undefined,
    )

    return run
  }

  public async getAllRawPayloads(): Promise<FullyFormedTransferPayload[]> {
    const observedGeneration = this.observedStorageObjectGeneration
    return this.runPayloadReadForGeneration(observedGeneration, () =>
      this.device.getAllDatabaseEntries(this.identifier),
    )
  }

  public async getRawPayloads(uuids: string[]): Promise<FullyFormedTransferPayload[]> {
    const observedGeneration = this.observedStorageObjectGeneration
    return this.runPayloadReadForGeneration(observedGeneration, () =>
      this.device.getDatabaseEntries(this.identifier, uuids),
    )
  }

  public async savePayload(payload: FullyFormedPayloadInterface): Promise<void> {
    return this.savePayloads([payload])
  }

  public async savePayloads(payloads: FullyFormedPayloadInterface[]): Promise<void> {
    const observedGeneration = this.observedStorageObjectGeneration

    if (this.persistencePolicy === StoragePersistencePolicies.Ephemeral) {
      return
    }

    const { encrypted, decrypted, deleted, discardable } = CreatePayloadSplitWithDiscardables(payloads)

    const rootKeyEncryptionAvailable = this.encryptionProvider.hasRootKeyEncryptionSource()

    const encryptable: DecryptedPayloadInterface[] = []
    const unencryptable: DecryptedPayloadInterface[] = []

    const { rootKeyEncryption, keySystemRootKeyEncryption, itemsKeyEncryption } =
      SplitPayloadsByEncryptionType(decrypted)

    if (itemsKeyEncryption) {
      extendArray(encryptable, itemsKeyEncryption)
    }

    if (keySystemRootKeyEncryption) {
      extendArray(encryptable, keySystemRootKeyEncryption)
    }

    if (rootKeyEncryption) {
      if (!rootKeyEncryptionAvailable) {
        extendArray(unencryptable, rootKeyEncryption)
      } else {
        extendArray(encryptable, rootKeyEncryption)
      }
    }

    if (discardable.length > 0) {
      await this.deletePayloads(discardable)
    }

    const encryptableSplit = SplitPayloadsByEncryptionType(encryptable)

    const keyLookupSplit = CreateEncryptionSplitWithKeyLookup(encryptableSplit)

    const encryptedResults = await this.encryptionProvider.encryptSplit(keyLookupSplit)

    const exportedEncrypted = [...encrypted, ...encryptedResults].map(CreateEncryptedLocalStorageContextPayload)

    const exportedDecrypted = unencryptable.map(CreateDecryptedLocalStorageContextPayload)

    const exportedDeleted = deleted.map(CreateDeletedLocalStorageContextPayload)

    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(() =>
        this.runPayloadMutationForGeneration(observedGeneration, () =>
          this.device.saveDatabaseEntries(
            [...exportedEncrypted, ...exportedDecrypted, ...exportedDeleted],
            this.identifier,
          ),
        ),
      ),
    )
  }

  public async deletePayloads(payloads: DeletedPayloadInterface[]) {
    await this.deletePayloadsWithUuids(Uuids(payloads))
  }

  public async deletePayloadsWithUuids(uuids: string[]): Promise<void> {
    const observedGeneration = this.observedStorageObjectGeneration
    await this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(() =>
        this.runPayloadMutationForGeneration(observedGeneration, async () => {
          await Promise.all(uuids.map((uuid) => this.device.removeDatabaseEntry(uuid, this.identifier)))
        }),
      ),
    )
  }

  public async deletePayloadWithUuid(uuid: string) {
    const observedGeneration = this.observedStorageObjectGeneration
    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(() =>
        this.runPayloadMutationForGeneration(observedGeneration, async () => {
          await this.device.removeDatabaseEntry(uuid, this.identifier)
        }),
      ),
    )
  }

  public async clearAllPayloads() {
    const observedGeneration = this.observedStorageObjectGeneration
    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(() =>
        this.runPayloadMutationForGeneration(observedGeneration, () =>
          this.device.removeAllDatabaseEntries(this.identifier),
        ),
      ),
    )
  }

  public clearAllData(): Promise<void> {
    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(() =>
        this.withStorageObjectMutationLock(async () => {
          const priorGeneration = await this.readDurableStorageObjectGeneration()
          // The first epoch fences pre-clear writers. The second is committed
          // only after payload deletion, fencing contexts initialized mid-clear.
          const clearingGeneration = this.nextClearingStorageObjectGeneration(priorGeneration)
          await this.persistStorageGenerationTombstone(clearingGeneration)

          await this.device.removeAllDatabaseEntries(this.identifier)
          await this.device.removeRawStorageValue(namespacedKey(this.identifier, RawStorageKey.SnjsVersion))

          const finalGeneration = this.nextStableStorageObjectGeneration(clearingGeneration)
          await this.persistStorageGenerationTombstone(finalGeneration, false)
        }),
      ),
    )
  }
}
