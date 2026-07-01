import {
  SNApplication,
  ApplicationIdentifier,
  Environment,
  RawKeychainValue,
  TransferPayload,
  NamespacedRootKeyInKeychain,
  WebOrDesktopDeviceInterface,
  Platform,
  FullyFormedTransferPayload,
  DatabaseLoadOptions,
  GetSortedPayloadsByPriority,
  DatabaseKeysLoadChunk,
  DatabaseKeysLoadChunkResponse,
  ApplicationInterface,
  namespacedKey,
  RawStorageKey,
} from '@standardnotes/snjs'
import { Database, DatabaseCrossTabHooks } from '../Database'

export abstract class WebOrDesktopDevice implements WebOrDesktopDeviceInterface {
  platform?: Platform

  constructor(public appVersion: string) {}

  private databases: Database[] = []

  abstract environment: Environment

  setApplication(application: SNApplication): void {
    const database = new Database(application.identifier, application.alerts)

    this.databases.push(database)
  }

  /**
   * Standard Red Notes: wire cross-tab coordination hooks into the per-identifier
   * Database (save-broadcast + keychain-lock write veto). Called from the web bootstrap
   * (WebApplication) which holds the CrossTabCoordinator(s); the base device just forwards
   * the hooks to the matching Database so the low-level store stays snjs-free.
   */
  setDatabaseCrossTabHooks(identifier: ApplicationIdentifier, hooks: DatabaseCrossTabHooks): void {
    const database = this.databaseForIdentifier(identifier)
    if (database) {
      database.setCrossTabHooks(hooks)
    }
  }

  removeApplication(application: ApplicationInterface): void {
    const database = this.databaseForIdentifier(application.identifier)

    if (database) {
      database.deinit()
      this.databases = this.databases.filter((db) => db !== database)
    }
  }

  deinit() {
    for (const database of this.databases) {
      database.deinit()
    }

    this.databases = []
  }

  public async getJsonParsedRawStorageValue(key: string): Promise<unknown | undefined> {
    const value = await this.getRawStorageValue(key)
    if (value == undefined) {
      return undefined
    }

    try {
      return JSON.parse(value)
    } catch (e) {
      return value
    }
  }

  private databaseForIdentifier(identifier: ApplicationIdentifier) {
    return this.databases.find((database) => database.databaseName === identifier) as Database
  }

  async clearAllDataFromDevice(workspaceIdentifiers: ApplicationIdentifier[]): Promise<{ killsApplication: boolean }> {
    await this.clearRawKeychainValue()

    await this.removeAllRawStorageValues()

    await Database.deleteAll(workspaceIdentifiers)

    return { killsApplication: false }
  }

  async getRawStorageValue(key: string): Promise<string | undefined> {
    const result = localStorage.getItem(key)

    if (result == undefined) {
      return undefined
    }

    return result
  }

  async setRawStorageValue(key: string, value: string) {
    localStorage.setItem(key, value)
  }

  async removeRawStorageValue(key: string) {
    localStorage.removeItem(key)
  }

  async removeAllRawStorageValues() {
    localStorage.clear()
  }

  async removeRawStorageValuesForIdentifier(identifier: ApplicationIdentifier) {
    await this.removeRawStorageValue(namespacedKey(identifier, RawStorageKey.SnjsVersion))
    await this.removeRawStorageValue(namespacedKey(identifier, RawStorageKey.StorageObject))
  }

  async openDatabase(identifier: ApplicationIdentifier) {
    this.databaseForIdentifier(identifier).unlock()
    return new Promise((resolve, reject) => {
      this.databaseForIdentifier(identifier)
        .openDatabase(() => {
          resolve({ isNewDatabase: true })
        })
        .then(() => {
          resolve({ isNewDatabase: false })
        })
        .catch((error) => {
          reject(error)
        })
    }) as Promise<{ isNewDatabase?: boolean } | undefined>
  }

  async getDatabaseLoadChunks(
    options: DatabaseLoadOptions,
    identifier: string,
  ): Promise<DatabaseKeysLoadChunkResponse> {
    /**
     * COLD-LOAD STREAMING (large-vault OOM fix): previously this read the ENTIRE
     * IndexedDB into one in-memory array (getAllDatabaseEntries -> getAllPayloads)
     * before chunking, so a 50GB vault OOM'd the tab before any decrypt ran. We now
     * read only lightweight metadata (uuid/content_type/updated_at) to sort+chunk by
     * priority, and return KEYS (uuids) per chunk. SyncService then fetches each
     * chunk's actual ciphertext on demand via getDatabaseEntries right before it
     * decrypts+strips+discards that batch, so peak raw-ciphertext memory is ~one
     * batch instead of the whole corpus. The IndexedDB store keyPath is 'uuid', so
     * the entry key is simply the uuid.
     */
    const metadata = await this.databaseForIdentifier(identifier).getAllMetadata()

    const {
      itemsKeyPayloads,
      keySystemRootKeyPayloads,
      keySystemItemsKeyPayloads,
      contentTypePriorityPayloads,
      remainingPayloads,
    } = GetSortedPayloadsByPriority(metadata, options)

    const itemsKeysChunk: DatabaseKeysLoadChunk = {
      keys: itemsKeyPayloads.map((item) => item.uuid),
    }

    const keySystemRootKeysChunk: DatabaseKeysLoadChunk = {
      keys: keySystemRootKeyPayloads.map((item) => item.uuid),
    }

    const keySystemItemsKeysChunk: DatabaseKeysLoadChunk = {
      keys: keySystemItemsKeyPayloads.map((item) => item.uuid),
    }

    const contentTypePriorityChunk: DatabaseKeysLoadChunk = {
      keys: contentTypePriorityPayloads.map((item) => item.uuid),
    }

    const remainingKeys = remainingPayloads.map((item) => item.uuid)

    const remainingKeysChunks: DatabaseKeysLoadChunk[] = []
    for (let i = 0; i < remainingKeys.length; i += options.batchSize) {
      remainingKeysChunks.push({
        keys: remainingKeys.slice(i, i + options.batchSize),
      })
    }

    const result: DatabaseKeysLoadChunkResponse = {
      keys: {
        itemsKeys: itemsKeysChunk,
        keySystemRootKeys: keySystemRootKeysChunk,
        keySystemItemsKeys: keySystemItemsKeysChunk,
        remainingChunks: [contentTypePriorityChunk, ...remainingKeysChunks],
      },
      remainingChunksItemCount: contentTypePriorityPayloads.length + remainingPayloads.length,
    }

    return result
  }

  async getAllDatabaseEntries(identifier: ApplicationIdentifier) {
    return this.databaseForIdentifier(identifier).getAllPayloads()
  }

  getDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(
    identifier: string,
    keys: string[],
  ): Promise<T[]> {
    return this.databaseForIdentifier(identifier).getPayloadsForKeys(keys)
  }

  async saveDatabaseEntry(payload: TransferPayload, identifier: ApplicationIdentifier) {
    return this.databaseForIdentifier(identifier).savePayload(payload)
  }

  async saveDatabaseEntries(payloads: TransferPayload[], identifier: ApplicationIdentifier) {
    return this.databaseForIdentifier(identifier).savePayloads(payloads)
  }

  async removeDatabaseEntry(id: string, identifier: ApplicationIdentifier) {
    return this.databaseForIdentifier(identifier).deletePayload(id)
  }

  async removeAllDatabaseEntries(identifier: ApplicationIdentifier) {
    return this.databaseForIdentifier(identifier).clearAllPayloads()
  }

  async getNamespacedKeychainValue(identifier: ApplicationIdentifier) {
    const keychain = await this.getKeychainValue()

    if (!keychain) {
      return
    }

    return keychain[identifier]
  }

  async setNamespacedKeychainValue(value: NamespacedRootKeyInKeychain, identifier: ApplicationIdentifier) {
    let keychain = await this.getKeychainValue()

    if (!keychain) {
      keychain = {}
    }

    return this.setKeychainValue({
      ...keychain,
      [identifier]: value,
    })
  }

  async clearNamespacedKeychainValue(identifier: ApplicationIdentifier) {
    const keychain = await this.getKeychainValue()
    if (!keychain) {
      return
    }

    delete keychain[identifier]

    return this.setKeychainValue(keychain)
  }

  setRawKeychainValue(value: unknown): Promise<void> {
    return this.setKeychainValue(value)
  }

  openUrl(url: string) {
    const win = window.open(url, '_blank')
    if (win) {
      win.focus()
    }
  }

  abstract getKeychainValue(): Promise<RawKeychainValue>

  abstract setKeychainValue(value: unknown): Promise<void>

  abstract clearRawKeychainValue(): Promise<void>

  abstract isDeviceDestroyed(): boolean

  abstract performHardReset(): Promise<void>

  async performSoftReset(): Promise<void> {
    window.location.reload()
  }
}
