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
  private keyValueMutationSequence = 0

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
      await this.device.clearNamespacedKeychainValue(this.identifier)
      await this.device.removeAllDatabaseEntries(this.identifier)
      await this.device.removeRawStorageValuesForIdentifier(this.identifier)
      await this.clearAllPayloads()
    }
  }

  public isEphemeralSession(): boolean {
    return this.persistencePolicy === StoragePersistencePolicies.Ephemeral
  }

  public async initializeFromDisk(): Promise<void> {
    const value = await this.device.getRawStorageValue(this.getPersistenceKey())
    const values = value ? JSON.parse(value as string) : undefined

    await this.setInitialValues(values)
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

    const values = await this.executeCriticalFunction(async () => {
      const generatedValues = await this.generatePersistableValues()

      const persistencePolicySuddenlyChanged = this.persistencePolicy === StoragePersistencePolicies.Ephemeral
      if (!persistencePolicySuddenlyChanged) {
        await this.device?.setRawStorageValue(this.getPersistenceKey(), JSON.stringify(generatedValues))
      }

      return generatedValues
    })

    /** Save the persisted value so we have access to it in memory (for unit tests afawk) */
    this.values[ValueModesKeys.Wrapped] = values[ValueModesKeys.Wrapped]
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
  private async generatePersistableValues() {
    const rawContent = <Partial<StorageValuesObject>>Copy(this.values)

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
      this.needsPersist = true
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
    await this.enqueueKeyValueWrite(async () => {
      if (!this.values) {
        throw Error('Attempting to atomically set storage values before loading local storage.')
      }

      const domainKey = this.domainKeyForMode(mode)
      const domain = this.values[domainKey]
      const previousNeedsPersist = this.needsPersist
      const previousValues = new Map<string, { existed: boolean; value: unknown; appliedMutationVersion: number }>()

      for (const [key, value] of Object.entries(values)) {
        const existed = Object.prototype.hasOwnProperty.call(domain, key)
        const previousValue = domain[key]

        if (value === undefined) {
          delete domain[key]
        } else {
          domain[key] = value
        }

        previousValues.set(key, {
          existed,
          value: previousValue,
          appliedMutationVersion: this.recordKeyValueMutation(key, mode),
        })
      }

      try {
        await this.persistCurrentValuesToDisk()
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
          this.recordKeyValueMutation(key, mode)
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
    domainStorage[key] = value
    this.recordKeyValueMutation(key, mode)
  }

  private keyValueMutationVersionKey(key: string, mode: StorageValueModes): string {
    return `${mode}:${key}`
  }

  private getKeyValueMutationVersion(key: string, mode: StorageValueModes): number {
    return this.keyValueMutationVersions.get(this.keyValueMutationVersionKey(key, mode)) ?? 0
  }

  private recordKeyValueMutation(key: string, mode: StorageValueModes): number {
    const mutationKey = this.keyValueMutationVersionKey(key, mode)
    const version = ++this.keyValueMutationSequence
    this.keyValueMutationVersions.set(mutationKey, version)
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

    const domain = this.values[this.domainKeyForMode(mode)]

    if (Object.prototype.hasOwnProperty.call(domain, key)) {
      await this.setValuesAtomicallyAndAwaitPersist({ [key]: undefined }, mode)
    }
  }

  /**
   * Default persistence key. Platforms can override as needed.
   */
  private getPersistenceKey() {
    return namespacedKey(this.identifier, RawStorageKey.StorageObject)
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
      await this.setInitialValues()
      const appliedMutationSequence = ++this.keyValueMutationSequence

      try {
        await this.persistCurrentValuesToDisk()
      } catch (error) {
        if (this.keyValueMutationSequence === appliedMutationSequence) {
          this.values = previousValues
          this.keyValueMutationSequence++
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
    return this.device.getAllDatabaseEntries(this.identifier)
  }

  public async getRawPayloads(uuids: string[]): Promise<FullyFormedTransferPayload[]> {
    return this.device.getDatabaseEntries(this.identifier, uuids)
  }

  public async savePayload(payload: FullyFormedPayloadInterface): Promise<void> {
    return this.savePayloads([payload])
  }

  public async savePayloads(payloads: FullyFormedPayloadInterface[]): Promise<void> {
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
      this.executeCriticalFunction(async () => {
        return this.device?.saveDatabaseEntries(
          [...exportedEncrypted, ...exportedDecrypted, ...exportedDeleted],
          this.identifier,
        )
      }),
    )
  }

  public async deletePayloads(payloads: DeletedPayloadInterface[]) {
    await this.deletePayloadsWithUuids(Uuids(payloads))
  }

  public async deletePayloadsWithUuids(uuids: string[]): Promise<void> {
    await this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(async () => {
        await Promise.all(uuids.map((uuid) => this.device.removeDatabaseEntry(uuid, this.identifier)))
      }),
    )
  }

  public async deletePayloadWithUuid(uuid: string) {
    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(async () => {
        await this.device.removeDatabaseEntry(uuid, this.identifier)
      }),
    )
  }

  public async clearAllPayloads() {
    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(async () => {
        return this.device.removeAllDatabaseEntries(this.identifier)
      }),
    )
  }

  public clearAllData(): Promise<void> {
    return this.enqueueStorageWrite(() =>
      this.executeCriticalFunction(async () => {
        await this.clearValues()
        await this.clearAllPayloadsWithoutQueue()

        await this.device.removeRawStorageValue(namespacedKey(this.identifier, RawStorageKey.SnjsVersion))

        await this.device.removeRawStorageValue(this.getPersistenceKey())
      }),
    )
  }

  /**
   * The unqueued body of clearAllPayloads, for use by callers that are already
   * running inside the storage write queue (e.g. clearAllData). Calling the
   * public clearAllPayloads from within a queued op would enqueue a NEW write
   * that waits for the current op's tail to settle — but the current op cannot
   * settle until that nested write finishes, which is a deadlock. This method
   * performs the device call directly without touching the queue.
   */
  private async clearAllPayloadsWithoutQueue(): Promise<void> {
    await this.executeCriticalFunction(async () => {
      return this.device.removeAllDatabaseEntries(this.identifier)
    })
  }
}
