import { promises as fs } from 'node:fs'
import path from 'node:path'
import snjs from '@standardnotes/snjs'

// snjs's published type bundle doesn't re-export these internal types at the
// package root, so we mirror the structural shapes we depend on. The runtime
// objects come straight from snjs.
type ApplicationIdentifier = string
type TransferPayload = { uuid: string } & Record<string, unknown>
type FullyFormedTransferPayload = TransferPayload
type NamespacedRootKeyInKeychain = Record<string, unknown>
type DatabaseLoadOptions = { contentTypePriority: string[]; uuidPriority: string[]; batchSize: number }
type DatabaseFullEntryLoadChunk = { entries: FullyFormedTransferPayload[] }
type DatabaseFullEntryLoadChunkResponse = {
  fullEntries: {
    itemsKeys: DatabaseFullEntryLoadChunk
    keySystemRootKeys: DatabaseFullEntryLoadChunk
    keySystemItemsKeys: DatabaseFullEntryLoadChunk
    remainingChunks: DatabaseFullEntryLoadChunk[]
  }
  remainingChunksItemCount: number
}

const { Environment, GetSortedPayloadsByPriority } = snjs as unknown as {
  Environment: { Web: number; Desktop: number }
  GetSortedPayloadsByPriority: (
    entries: FullyFormedTransferPayload[],
    options: DatabaseLoadOptions,
  ) => {
    itemsKeyPayloads: FullyFormedTransferPayload[]
    keySystemRootKeyPayloads: FullyFormedTransferPayload[]
    keySystemItemsKeyPayloads: FullyFormedTransferPayload[]
    contentTypePriorityPayloads: FullyFormedTransferPayload[]
    remainingPayloads: FullyFormedTransferPayload[]
  }
}

type Json = Record<string, unknown>

/**
 * Headless, file-backed DeviceInterface for snjs. Persists three JSON files in
 * `dataDir`: raw key/value storage, the keychain (root keys), and the item
 * payload database. Suitable for a single-user server-side bridge; all data is
 * the same ciphertext snjs would write to a browser's IndexedDB/localStorage.
 */
export class NodeDevice {
  public environment = Environment.Web as unknown as number

  private storage = new Map<string, string>()
  private keychain: Record<string, NamespacedRootKeyInKeychain> = {}
  private db = new Map<string, TransferPayload>()
  private destroyed = false
  private loaded = false

  constructor(private readonly dataDir: string) {}

  private file(name: string): string {
    return path.join(this.dataDir, name)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }
    await fs.mkdir(this.dataDir, { recursive: true })
    this.storage = new Map(Object.entries((await this.readJson('storage.json')) as Record<string, string>))
    this.keychain = (await this.readJson('keychain.json')) as Record<string, NamespacedRootKeyInKeychain>
    const dbObj = (await this.readJson('db.json')) as Record<string, TransferPayload>
    this.db = new Map(Object.entries(dbObj))
    this.loaded = true
  }

  private async readJson(name: string): Promise<Json> {
    try {
      const raw = await fs.readFile(this.file(name), 'utf8')
      return JSON.parse(raw) as Json
    } catch {
      return {}
    }
  }

  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0

  /** Returns a promise that resolves once all currently-queued writes finish. */
  public async flushWrites(): Promise<void> {
    await this.writeChain.catch(() => {})
  }

  // Serialize all file writes through one chain. snjs issues many concurrent
  // storage/db writes during sync; a shared fixed temp name would otherwise
  // race on rename. Unique temp names + a serialized chain keep it atomic.
  private writeJson(name: string, value: unknown): Promise<void> {
    // Serialize NOW (synchronously, at enqueue) so the bytes written reflect the
    // state at call time — not whatever the live object has mutated to by the
    // time the deferred write actually runs (which corrupted the keychain).
    const data = JSON.stringify(value)
    // Run after the previous write whether it succeeded OR failed: a single
    // transient FS error must never poison the chain and silently stop ALL
    // subsequent persistence.
    const run = this.writeChain.then(
      () => this.doWrite(name, data),
      () => this.doWrite(name, data),
    )
    // The chain tail must always settle as resolved so the next write proceeds.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async doWrite(name: string, data: string): Promise<void> {
    const tmp = this.file(`${name}.${this.writeSeq++}.tmp`)
    try {
      await fs.writeFile(tmp, data, 'utf8')
      await fs.rename(tmp, this.file(name))
    } catch (error) {
      // Best-effort cleanup so failed renames don't leak temp files forever.
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  private async persistStorage(): Promise<void> {
    await this.writeJson('storage.json', Object.fromEntries(this.storage))
  }
  private async persistKeychain(): Promise<void> {
    await this.writeJson('keychain.json', this.keychain)
  }
  private async persistDb(): Promise<void> {
    await this.writeJson('db.json', Object.fromEntries(this.db))
  }

  // --- raw storage -------------------------------------------------------

  async getRawStorageValue(key: string): Promise<string | undefined> {
    await this.ensureLoaded()
    return this.storage.get(key)
  }

  async getJsonParsedRawStorageValue(key: string): Promise<unknown | undefined> {
    const value = await this.getRawStorageValue(key)
    if (value == null) {
      return undefined
    }
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  async setRawStorageValue(key: string, value: string): Promise<void> {
    await this.ensureLoaded()
    this.storage.set(key, value)
    await this.persistStorage()
  }

  async removeRawStorageValue(key: string): Promise<void> {
    await this.ensureLoaded()
    this.storage.delete(key)
    await this.persistStorage()
  }

  async removeAllRawStorageValues(): Promise<void> {
    await this.ensureLoaded()
    this.storage.clear()
    await this.persistStorage()
  }

  async removeRawStorageValuesForIdentifier(identifier: ApplicationIdentifier): Promise<void> {
    await this.ensureLoaded()
    for (const key of [...this.storage.keys()]) {
      if (key.includes(identifier)) {
        this.storage.delete(key)
      }
    }
    await this.persistStorage()
  }

  // --- database ----------------------------------------------------------

  async openDatabase(_identifier: ApplicationIdentifier): Promise<{ isNewDatabase?: boolean } | undefined> {
    const existed = this.loaded || (await this.fileExists('db.json'))
    await this.ensureLoaded()
    return { isNewDatabase: !existed }
  }

  private async fileExists(name: string): Promise<boolean> {
    try {
      await fs.access(this.file(name))
      return true
    } catch {
      return false
    }
  }

  async getDatabaseLoadChunks(
    options: DatabaseLoadOptions,
    identifier: ApplicationIdentifier,
  ): Promise<DatabaseFullEntryLoadChunkResponse> {
    const entries = await this.getAllDatabaseEntries(identifier)
    const sorted = GetSortedPayloadsByPriority(entries, options)

    const remainingChunks: DatabaseFullEntryLoadChunk[] = [{ entries: sorted.contentTypePriorityPayloads }]
    for (let i = 0; i < sorted.remainingPayloads.length; i += options.batchSize) {
      remainingChunks.push({ entries: sorted.remainingPayloads.slice(i, i + options.batchSize) })
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

  async getAllDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(
    _identifier: ApplicationIdentifier,
  ): Promise<T[]> {
    await this.ensureLoaded()
    return [...this.db.values()] as unknown as T[]
  }

  async getDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(
    _identifier: ApplicationIdentifier,
    keys: string[],
  ): Promise<T[]> {
    await this.ensureLoaded()
    return keys.map((k) => this.db.get(k)).filter((v): v is TransferPayload => v != null) as unknown as T[]
  }

  async saveDatabaseEntry(payload: TransferPayload, _identifier: ApplicationIdentifier): Promise<void> {
    await this.ensureLoaded()
    this.db.set(payload.uuid, payload)
    await this.persistDb()
  }

  async saveDatabaseEntries(payloads: TransferPayload[], _identifier: ApplicationIdentifier): Promise<void> {
    await this.ensureLoaded()
    for (const payload of payloads) {
      this.db.set(payload.uuid, payload)
    }
    await this.persistDb()
  }

  async removeDatabaseEntry(id: string, _identifier: ApplicationIdentifier): Promise<void> {
    await this.ensureLoaded()
    this.db.delete(id)
    await this.persistDb()
  }

  async removeAllDatabaseEntries(_identifier: ApplicationIdentifier): Promise<void> {
    await this.ensureLoaded()
    this.db.clear()
    await this.persistDb()
  }

  // --- keychain ----------------------------------------------------------

  async getNamespacedKeychainValue(
    identifier: ApplicationIdentifier,
  ): Promise<NamespacedRootKeyInKeychain | undefined> {
    await this.ensureLoaded()
    return this.keychain[identifier]
  }

  async setNamespacedKeychainValue(
    value: NamespacedRootKeyInKeychain,
    identifier: ApplicationIdentifier,
  ): Promise<void> {
    await this.ensureLoaded()
    this.keychain[identifier] = value
    await this.persistKeychain()
  }

  async clearNamespacedKeychainValue(identifier: ApplicationIdentifier): Promise<void> {
    await this.ensureLoaded()
    delete this.keychain[identifier]
    await this.persistKeychain()
  }

  async clearRawKeychainValue(): Promise<void> {
    await this.ensureLoaded()
    this.keychain = {}
    await this.persistKeychain()
  }

  // --- lifecycle ---------------------------------------------------------

  async clearAllDataFromDevice(_workspaceIdentifiers: ApplicationIdentifier[]): Promise<{ killsApplication: boolean }> {
    this.storage.clear()
    this.keychain = {}
    this.db.clear()
    await Promise.all([this.persistStorage(), this.persistKeychain(), this.persistDb()])
    return { killsApplication: false }
  }

  openUrl(_url: string): void {
    /* no-op in headless mode */
  }

  performSoftReset(): void {
    /* no-op */
  }

  performHardReset(): void {
    this.destroyed = true
  }

  isDeviceDestroyed(): boolean {
    return this.destroyed
  }

  deinit(): void {
    this.destroyed = true
  }
}
