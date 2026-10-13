import { SNApplication } from '@Lib/Application/Application'
import { SNLog } from '@Lib/Log'
import { ApiVersion } from '@standardnotes/api'
import { ContentType } from '@standardnotes/domain-core'
import {
  ApplicationIdentifier,
  Environment,
  FullyFormedTransferPayload,
  NamespacedRootKeyInKeychain,
  NoteContent,
  Platform,
  SNNote,
  TransferPayload,
} from '@standardnotes/models'
import {
  AlertService,
  ApplicationEvent,
  DatabaseFullEntryLoadChunkResponse,
  DatabaseLoadOptions,
  DeinitMode,
  DeinitSource,
  DeviceInterface,
  EncryptionService,
  GetSortedPayloadsByPriority,
  namespacedKey,
  RawStorageKey,
} from '@standardnotes/services'
import type { SNWebCrypto } from '@standardnotes/sncrypto-web'
import { webcrypto } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * WHAT THIS IS FOR.
 *
 * A note created in the first moments of a first launch was lost. The application reports itself
 * launched before its database has loaded, and on a first launch there was no default items key
 * until the first full sync had COMPLETED. A note created before then could not be encrypted for
 * the local database; the sync that failed to write it went on to mark it clean; nothing ever wrote
 * it afterwards; and the modal it raised told the person to restart, which is what made the loss
 * final.
 *
 * WHY IT RUNS THE REAL THING. The two halves of that - no key yet, and a failed write that leaves
 * the item clean - sit in different services and only meet in a launched application. Every stubbed
 * spec of the sync service was green over it. So this constructs a real SNApplication: the real
 * payload and item managers, the real encryption service on real crypto, the real disk storage
 * service. The only stand-in is the device, below, because there is no IndexedDB here.
 */

/**
 * A device that keeps what IndexedDB and localStorage would keep, and nothing else. The item store
 * is keyed by uuid and written all-or-nothing, which is what the web `Database` does (`keyPath:
 * 'uuid'`, one readwrite transaction per save). Every row is copied on the way in and on the way
 * out, as structured clone does, so the application can never be handed back its own object and
 * have that pass for "stored".
 */
class InMemoryDevice implements DeviceInterface {
  environment = Environment.Web

  readonly rows = new Map<string, TransferPayload>()
  private readonly rawValues = new Map<string, string>()
  private readonly keychain = new Map<string, NamespacedRootKeyInKeychain>()
  private databaseExists = false

  /** While set, an item write is refused the way a failed IndexedDB transaction is: nothing lands. */
  writeFault: Error | undefined

  deinit(): void {}

  async getRawStorageValue(key: string): Promise<string | undefined> {
    return this.rawValues.get(key)
  }

  async getJsonParsedRawStorageValue(key: string): Promise<unknown | undefined> {
    const value = this.rawValues.get(key)
    if (value == undefined) {
      return undefined
    }
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  async setRawStorageValue(key: string, value: string): Promise<void> {
    this.rawValues.set(key, value)
  }

  async removeRawStorageValue(key: string): Promise<void> {
    this.rawValues.delete(key)
  }

  async removeAllRawStorageValues(): Promise<void> {
    this.rawValues.clear()
  }

  async removeRawStorageValuesForIdentifier(identifier: ApplicationIdentifier): Promise<void> {
    this.rawValues.delete(namespacedKey(identifier, RawStorageKey.SnjsVersion))
    this.rawValues.delete(namespacedKey(identifier, RawStorageKey.StorageObject))
  }

  async openDatabase(): Promise<{ isNewDatabase?: boolean } | undefined> {
    const isNewDatabase = !this.databaseExists
    this.databaseExists = true
    return { isNewDatabase }
  }

  async getDatabaseLoadChunks(options: DatabaseLoadOptions): Promise<DatabaseFullEntryLoadChunkResponse> {
    const sorted = GetSortedPayloadsByPriority(await this.getAllDatabaseEntries(), options)
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
    this.rows.clear()
    this.rawValues.clear()
    this.keychain.clear()
    return { killsApplication: false }
  }

  async getAllDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(): Promise<T[]> {
    return Array.from(this.rows.values()).map((row) => structuredClone(row) as T)
  }

  async getDatabaseEntries<T extends FullyFormedTransferPayload = FullyFormedTransferPayload>(
    _identifier: ApplicationIdentifier,
    keys: string[],
  ): Promise<T[]> {
    return keys
      .map((key) => this.rows.get(key))
      .filter((row): row is TransferPayload => row !== undefined)
      .map((row) => structuredClone(row) as T)
  }

  async saveDatabaseEntry(payload: TransferPayload): Promise<void> {
    return this.saveDatabaseEntries([payload])
  }

  async saveDatabaseEntries(payloads: TransferPayload[]): Promise<void> {
    if (this.writeFault) {
      throw this.writeFault
    }
    for (const payload of payloads) {
      this.rows.set(payload.uuid, structuredClone(payload))
    }
  }

  async removeDatabaseEntry(id: string): Promise<void> {
    this.rows.delete(id)
  }

  async removeAllDatabaseEntries(): Promise<void> {
    this.rows.clear()
  }

  async getNamespacedKeychainValue(
    identifier: ApplicationIdentifier,
  ): Promise<NamespacedRootKeyInKeychain | undefined> {
    return this.keychain.get(identifier)
  }

  async setNamespacedKeychainValue(
    value: NamespacedRootKeyInKeychain,
    identifier: ApplicationIdentifier,
  ): Promise<void> {
    this.keychain.set(identifier, value)
  }

  async clearNamespacedKeychainValue(identifier: ApplicationIdentifier): Promise<void> {
    this.keychain.delete(identifier)
  }

  async clearRawKeychainValue(): Promise<void> {
    this.keychain.clear()
  }

  openUrl(): void {}

  async performSoftReset(): Promise<void> {}

  async performHardReset(): Promise<void> {}

  isDeviceDestroyed(): boolean {
    return false
  }
}

class SilentAlerts extends AlertService {
  async confirm(): Promise<boolean> {
    return true
  }

  async confirmV2(): Promise<boolean> {
    return true
  }

  async alert(): Promise<void> {}

  async alertV2(): Promise<void> {}

  blockingDialog(): () => void {
    return () => undefined
  }
}

/**
 * The real crypto, taken from the bundle the package ships: its ESM entry point cannot be required
 * here. The bundle is UMD and reaches for a browser's `self`, and needs SubtleCrypto, which jsdom
 * does not have and Node does not make a global in every jest environment - so both are installed
 * rather than letting a missing global turn these into tests that are skipped.
 */
const createRealCrypto = (): SNWebCrypto => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  }
  Object.assign(globalThis, { self: globalThis })
  const bundle = join(dirname(require.resolve('@standardnotes/sncrypto-web/package.json')), 'dist', 'sncrypto-web.js')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SNWebCrypto: RealCrypto } = require(bundle) as { SNWebCrypto: new () => SNWebCrypto }
  return new RealCrypto()
}

const IDENTIFIER = 'first-launch-persistence-spec'
const NOTE_TEXT = 'written in the first instant'

type Launched = {
  application: SNApplication
  /** Every time the application told its host that a local write had failed (the modal). */
  writeErrors: unknown[]
  /** Resolves when everything launch started in the background - database load, first syncs - is done. */
  settled: Promise<void>
}

describe('first-launch persistence, against the real services', () => {
  const applications: SNApplication[] = []
  const realFetch = globalThis.fetch

  beforeEach(() => {
    SNLog.onLog = () => undefined
    SNLog.onError = () => undefined
    /** There is no session in any of these, so no server: a refused connection is the honest answer. */
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
  })

  afterEach(() => {
    for (const application of applications.splice(0)) {
      if (!application.dealloced) {
        application.deinit(DeinitMode.Soft, DeinitSource.SignOut)
      }
    }
    globalThis.fetch = realFetch
    ;(SNLog.onLog as unknown) = undefined
    ;(SNLog.onError as unknown) = undefined
  })

  /**
   * Hands the application back at the moment the web app is told it has launched (the Launched
   * event is what renders the interface), which is BEFORE the database has loaded and before any
   * sync. Pass true to be handed it only once all of that has finished instead.
   */
  const launch = async (device: InMemoryDevice, waitUntilSettled = false): Promise<Launched> => {
    const application = new SNApplication({
      environment: Environment.Web,
      platform: Platform.LinuxWeb,
      deviceInterface: device,
      crypto: createRealCrypto(),
      alertService: new SilentAlerts(),
      identifier: IDENTIFIER,
      defaultHost: 'http://127.0.0.1:9',
      appVersion: '1.0.0',
      apiVersion: ApiVersion.v1,
    })
    applications.push(application)

    const writeErrors: unknown[] = []
    let reportLaunched: () => void = () => undefined
    const launched = new Promise<void>((resolve) => {
      reportLaunched = resolve
    })
    application.addEventObserver(async (event, data) => {
      if (event === ApplicationEvent.LocalDatabaseWriteError) {
        writeErrors.push(data)
      }
      if (event === ApplicationEvent.Launched) {
        reportLaunched()
      }
    })

    await application.prepareForLaunch({ receiveChallenge: () => undefined })
    const settled = application.launch(true)
    await (waitUntilSettled ? settled : launched)

    return { application, writeErrors, settled }
  }

  /** Closing the tab. Waits for what is in flight first, so nothing here depends on cutting a write short. */
  const quit = async (launched: Launched) => {
    await launched.settled
    await launched.application.sync.sync({ sourceDescription: 'first-launch spec, before quitting' })
    launched.application.deinit(DeinitMode.Soft, DeinitSource.SignOut)
  }

  const createNote = async (application: SNApplication, title: string, localOnly = false): Promise<string> => {
    const template = application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title,
      text: NOTE_TEXT,
      references: [],
    })
    const note = await application.mutator.insertItem(template)
    if (localOnly) {
      await application.mutator.changeItem(note, (mutator) => {
        mutator.localOnly = true
      })
    }
    return note.uuid
  }

  const itemsKeyCount = (application: SNApplication) => application.items.getItems(ContentType.TYPES.ItemsKey).length

  const noteInMemory = (application: SNApplication, uuid: string) => application.items.findItem<SNNote>(uuid)

  /** What the device itself holds for a uuid - read off the store, not through the application. */
  const storedRow = (device: InMemoryDevice, uuid: string) => device.rows.get(uuid) as { content?: unknown } | undefined

  const expectStoredEncrypted = (device: InMemoryDevice, uuid: string) => {
    const row = storedRow(device, uuid)
    expect(row).toBeDefined()
    expect(typeof row?.content).toBe('string')
    expect(String(row?.content).startsWith('004:')).toBe(true)
    expect(JSON.stringify(row)).not.toContain(NOTE_TEXT)
  }

  const expectPresentAfterRelaunch = async (device: InMemoryDevice, uuid: string, title: string) => {
    const next = await launch(device, true)
    const note = noteInMemory(next.application, uuid)
    expect(note?.title).toBe(title)
    expect(note?.text).toBe(NOTE_TEXT)
    expect(next.writeErrors).toEqual([])
  }

  const waitUntil = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return condition()
  }

  describe('a note created the instant the application reports itself launched', () => {
    it.each([
      ['an ordinary note', false],
      ['a local-only note, which no upload would ever have saved either', true],
    ])('writes %s to the device with no write error, and has it on the next launch', async (_kind, localOnly) => {
      const device = new InMemoryDevice()
      const first = await launch(device)

      /**
       * The precondition that makes this the first-launch case and not an ordinary one: launched,
       * and not a single items key in existence. If launch ever hands back an application that
       * already has its key, this is no longer testing the gap and must be rewritten, not relaxed.
       */
      expect(first.application.isLaunched()).toBe(true)
      expect(itemsKeyCount(first.application)).toBe(0)

      const uuid = await createNote(first.application, 'first-launch note', localOnly)
      await first.application.sync.sync({ sourceDescription: 'first-launch spec' })

      expect(first.writeErrors).toEqual([])
      expectStoredEncrypted(device, uuid)
      expect(noteInMemory(first.application, uuid)?.dirty).toBeFalsy()

      await quit(first)
      await expectPresentAfterRelaunch(device, uuid, 'first-launch note')
    })
  })

  describe('a local write that fails', () => {
    beforeEach(() => {
      /** The sync service logs every save that fails. Here that is the behaviour under test. */
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    /**
     * The key being late for a reason of its own. Whatever the reason, the note that could not be
     * written must still be pending afterwards - that is the whole difference between a save that
     * is late and a note that is gone.
     */
    it('leaves the note pending while no items key exists, and writes it once one does', async () => {
      const device = new InMemoryDevice()
      const first = await launch(device)
      const encryption = first.application.encryption as unknown as EncryptionService
      const keyCreation = jest.spyOn(encryption, 'createNewDefaultItemsKey').mockResolvedValue(undefined as never)

      const uuid = await createNote(first.application, 'late-key note')
      await first.application.sync.sync({ sourceDescription: 'late-key spec, key missing' })

      expect(itemsKeyCount(first.application)).toBe(0)
      expect(storedRow(device, uuid)).toBeUndefined()
      /** Not written, so not clean: it is still owed a write, and the host has been told. */
      expect(noteInMemory(first.application, uuid)?.dirty).toBe(true)
      expect(first.writeErrors.length).toBeGreaterThan(0)

      keyCreation.mockRestore()
      await first.application.sync.sync({ sourceDescription: 'late-key spec, key available' })

      expect(itemsKeyCount(first.application)).toBe(1)
      expectStoredEncrypted(device, uuid)
      expect(noteInMemory(first.application, uuid)?.dirty).toBeFalsy()

      await quit(first)
      await expectPresentAfterRelaunch(device, uuid, 'late-key note')
    })

    /**
     * A full disk, a blocked database. Nobody calls sync() again here: what writes the note once
     * the device accepts writes is the application's own retry, which is what lets the message it
     * shows say "still open, still trying" instead of "restart".
     */
    it('leaves the note pending while the device refuses writes, and writes it by itself once it accepts them', async () => {
      const device = new InMemoryDevice()
      const first = await launch(device, true)
      await first.application.sync.sync({ sourceDescription: 'device-fault spec, settle' })
      expect(itemsKeyCount(first.application)).toBe(1)

      const quota = new Error('The quota has been exceeded.')
      quota.name = 'QuotaExceededError'
      device.writeFault = quota

      const uuid = await createNote(first.application, 'device-fault note')
      await first.application.sync.sync({ sourceDescription: 'device-fault spec, device refusing' })

      expect(storedRow(device, uuid)).toBeUndefined()
      expect(noteInMemory(first.application, uuid)?.dirty).toBe(true)
      expect(first.writeErrors).toContain(quota)

      device.writeFault = undefined

      expect(await waitUntil(() => storedRow(device, uuid) !== undefined, 10_000)).toBe(true)
      expect(await waitUntil(() => noteInMemory(first.application, uuid)?.dirty !== true, 5_000)).toBe(true)
      expectStoredEncrypted(device, uuid)

      await quit(first)
      await expectPresentAfterRelaunch(device, uuid, 'device-fault note')
    })
  })
})
