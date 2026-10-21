import {
  ApplicationIdentifier,
  DatabaseFullEntryLoadChunkResponse,
  DatabaseLoadOptions,
  DeviceInterface,
  Environment,
  FullyFormedTransferPayload,
  GetSortedPayloadsByPriority,
  NamespacedRootKeyInKeychain,
  TransferPayload,
} from '../../../snjs'

/** Small localStorage device for the isolated demo; it never clears other apps' data. */
export default class WebDeviceInterface implements DeviceInterface {
  readonly environment = Environment.Web
  private destroyed = false
  private readonly prefix = 'srn-filepicker-demo:'

  deinit(): void {
    this.destroyed = true
  }

  async getRawStorageValue(key: string): Promise<string | undefined> {
    return localStorage.getItem(this.prefix + key) ?? undefined
  }

  async getJsonParsedRawStorageValue(key: string): Promise<unknown> {
    const value = await this.getRawStorageValue(key)
    if (value === undefined) {
      return undefined
    }
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }

  async setRawStorageValue(key: string, value: string): Promise<void> {
    localStorage.setItem(this.prefix + key, value)
  }

  async removeRawStorageValue(key: string): Promise<void> {
    localStorage.removeItem(this.prefix + key)
  }

  private removePrefix(prefix: string): void {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key)
      }
    }
  }

  async removeAllRawStorageValues(): Promise<void> {
    this.removePrefix(this.prefix)
  }

  async removeRawStorageValuesForIdentifier(identifier: ApplicationIdentifier): Promise<void> {
    this.removePrefix(`${this.prefix}${identifier}-`)
  }

  async openDatabase(identifier: ApplicationIdentifier): Promise<{ isNewDatabase: boolean }> {
    const marker = `database:${identifier}`
    const isNewDatabase = (await this.getRawStorageValue(marker)) === undefined
    await this.setRawStorageValue(marker, 'open')
    return { isNewDatabase }
  }

  async getDatabaseLoadChunks(
    options: DatabaseLoadOptions,
    identifier: ApplicationIdentifier,
  ): Promise<DatabaseFullEntryLoadChunkResponse> {
    const sorted = GetSortedPayloadsByPriority(await this.getAllDatabaseEntries(identifier), options)
    const remainingChunks = [{ entries: sorted.contentTypePriorityPayloads }]
    for (let index = 0; index < sorted.remainingPayloads.length; index += options.batchSize) {
      remainingChunks.push({ entries: sorted.remainingPayloads.slice(index, index + options.batchSize) })
    }
    return {
      fullEntries: {
        itemsKeys: { entries: sorted.itemsKeyPayloads },
        keySystemRootKeys: { entries: sorted.keySystemRootKeyPayloads },
        keySystemItemsKeys: { entries: sorted.keySystemItemsKeyPayloads },
        remainingChunks,
      },
      remainingChunksItemCount: sorted.contentTypePriorityPayloads.length + sorted.remainingPayloads.length,
    }
  }

  async clearAllDataFromDevice(): Promise<{ killsApplication: boolean }> {
    await this.removeAllRawStorageValues()
    return { killsApplication: false }
  }

  private databasePrefix(identifier: ApplicationIdentifier): string {
    return `database-entry:${identifier}:`
  }

  async getAllDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(
    identifier: ApplicationIdentifier,
  ): Promise<T[]> {
    const keys = Object.keys(localStorage)
      .filter((key) => key.startsWith(this.prefix + this.databasePrefix(identifier)))
      .map((key) => key.slice((this.prefix + this.databasePrefix(identifier)).length))
    return this.getDatabaseEntries<T>(identifier, keys)
  }

  async getDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(
    identifier: ApplicationIdentifier,
    keys: string[],
  ): Promise<T[]> {
    const entries: T[] = []
    for (const key of keys) {
      const value = await this.getRawStorageValue(this.databasePrefix(identifier) + key)
      if (value !== undefined) {
        entries.push(JSON.parse(value) as T)
      }
    }
    return entries
  }

  async saveDatabaseEntry(payload: TransferPayload, identifier: ApplicationIdentifier): Promise<void> {
    await this.setRawStorageValue(this.databasePrefix(identifier) + payload.uuid, JSON.stringify(payload))
  }

  async saveDatabaseEntries(payloads: TransferPayload[], identifier: ApplicationIdentifier): Promise<void> {
    for (const payload of payloads) {
      await this.saveDatabaseEntry(payload, identifier)
    }
  }

  async removeDatabaseEntry(id: string, identifier: ApplicationIdentifier): Promise<void> {
    await this.removeRawStorageValue(this.databasePrefix(identifier) + id)
  }

  async removeAllDatabaseEntries(identifier: ApplicationIdentifier): Promise<void> {
    this.removePrefix(this.prefix + this.databasePrefix(identifier))
  }

  async getNamespacedKeychainValue(
    identifier: ApplicationIdentifier,
  ): Promise<NamespacedRootKeyInKeychain | undefined> {
    return (await this.getJsonParsedRawStorageValue(`keychain:${identifier}`)) as
      NamespacedRootKeyInKeychain | undefined
  }

  async setNamespacedKeychainValue(
    value: NamespacedRootKeyInKeychain,
    identifier: ApplicationIdentifier,
  ): Promise<void> {
    await this.setRawStorageValue(`keychain:${identifier}`, JSON.stringify(value))
  }

  async clearNamespacedKeychainValue(identifier: ApplicationIdentifier): Promise<void> {
    await this.removeRawStorageValue(`keychain:${identifier}`)
  }

  async clearRawKeychainValue(): Promise<void> {
    this.removePrefix(`${this.prefix}keychain:`)
  }

  openUrl(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async performSoftReset(): Promise<void> {
    window.location.reload()
  }

  async performHardReset(): Promise<void> {
    await this.removeAllRawStorageValues()
    window.location.reload()
  }

  isDeviceDestroyed(): boolean {
    return this.destroyed
  }
}
