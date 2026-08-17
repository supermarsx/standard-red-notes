import {
  FullyFormedPayloadInterface,
  PayloadInterface,
  RootKeyInterface,
  FullyFormedTransferPayload,
} from '@standardnotes/models'
import { StoragePersistencePolicies, StorageValueModes } from './StorageTypes'

export interface StorageServiceInterface {
  initializeFromDisk(): Promise<void>
  /**
   * Revalidates that this service still observes the current, fully committed
   * storage generation. A false result means payload storage must not be read
   * or written until the application reloads its storage context.
   */
  isStorageContextCurrent(): Promise<boolean>
  isStorageWrapped(): boolean
  decryptStorage(): Promise<void>
  getAllRawPayloads(): Promise<FullyFormedTransferPayload[]>
  getAllKeys(mode?: StorageValueModes): string[]
  getValue<T>(key: string, mode?: StorageValueModes, defaultValue?: T): T
  canDecryptWithKey(key: RootKeyInterface): Promise<boolean>
  setValue<T>(key: string, value: T, mode?: StorageValueModes): void
  /**
   * Like {@link setValue} but resolves only after the value has been flushed to disk.
   * Use for CRITICAL keys (sync/pagination token, root key + key params) where a
   * silently-dropped write would cause data loss or an unrecoverable auth state.
   */
  setValueAndAwaitPersist<T>(key: string, value: T, mode?: StorageValueModes): Promise<void>
  /**
   * Applies all changes to the in-memory value cache together and flushes them with
   * one raw-storage replacement. An `undefined` value removes that key. If the raw
   * write rejects, the cache is restored without issuing a compensating disk write.
   */
  setValuesAtomicallyAndAwaitPersist(values: Readonly<Record<string, unknown>>, mode?: StorageValueModes): Promise<void>
  removeValue(key: string, mode?: StorageValueModes): Promise<void>
  setPersistencePolicy(persistencePolicy: StoragePersistencePolicies): Promise<void>
  clearAllData(): Promise<void>

  getRawPayloads(uuids: string[]): Promise<FullyFormedTransferPayload[]>
  savePayload(payload: PayloadInterface): Promise<void>
  savePayloads(decryptedPayloads: PayloadInterface[]): Promise<void>
  deletePayloads(payloads: FullyFormedPayloadInterface[]): Promise<void>
  deletePayloadsWithUuids(uuids: string[]): Promise<void>

  clearAllPayloads(): Promise<void>
  isEphemeralSession(): boolean
}
