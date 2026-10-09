import {
  ContentType,
  CreateEncryptedLocalStorageContextPayload,
  DecryptedPayload,
  EncryptedPayload,
  EncryptionProviderInterface,
  FillItemContent,
  FullyFormedTransferPayload,
  InternalEventBusInterface,
  ItemManager,
  LoggerInterface,
  NoteContent,
  PayloadEmitSource,
  PayloadManager,
  PayloadManagerInterface,
  PayloadTimestampDefaults,
  StorageServiceInterface,
} from '@standardnotes/snjs'
import { reloadForeignDatabasePayloads } from './ReloadForeignDatabasePayloads'

const NOTE_UUID = 'peer-saved-note-uuid'

const decryptedNoteContent = (title: string) => FillItemContent<NoteContent>({ title, text: 'body' })

const decryptedPayload = (uuid: string, title = 'peer version') =>
  new DecryptedPayload({
    uuid,
    content_type: ContentType.TYPES.Note,
    content: decryptedNoteContent(title),
    ...PayloadTimestampDefaults(),
  })

/**
 * The ON-DISK shape, produced by the very function DiskStorageService.savePayloads uses, so
 * this fixture cannot drift from what getRawPayloads really returns. Every account row on disk
 * is ciphertext: `content` is a "004:..." string, and `errorDecrypting`/`waitingForKey` are
 * FALSE (it is intact ciphertext, not a failed decryption — which is why these rows are also
 * absent from the errored-items report).
 *
 * The previous fixture here passed `content: { references: [] }` — a DECRYPTED transfer payload
 * that getRawPayloads can never return for an account item — which is exactly why this spec
 * passed over a path that emitted ciphertext into the item graph 100% of the time.
 */
const rawEncryptedRow = (uuid: string): FullyFormedTransferPayload =>
  CreateEncryptedLocalStorageContextPayload(
    new EncryptedPayload({
      uuid,
      content_type: ContentType.TYPES.Note,
      content: '004:fake-ciphertext-for-this-row',
      enc_item_key: '004:fake-enc-item-key',
      items_key_id: 'items-key-uuid',
      errorDecrypting: false,
      waitingForKey: false,
      deleted: false,
      ...PayloadTimestampDefaults(),
    }),
  ) as unknown as FullyFormedTransferPayload

const rawDeletedRow = (uuid: string): FullyFormedTransferPayload =>
  ({
    uuid,
    content_type: ContentType.TYPES.Note,
    content: undefined,
    deleted: true,
    dirty: true,
    ...PayloadTimestampDefaults(),
  }) as unknown as FullyFormedTransferPayload

/**
 * Collect every payload out of a KeyedDecryptionSplit regardless of which lane the real
 * CreateDecryptionSplitWithKeyLookup put it in (usesItemsKeyWithKeyLookup for notes), so the
 * fake cannot pass by reading a key the production code never writes.
 */
const splitItems = (split: unknown): EncryptedPayload[] =>
  Object.values((split ?? {}) as Record<string, { items?: EncryptedPayload[] } | undefined>).flatMap(
    (entry) => entry?.items ?? [],
  )

/** An account that holds the items key decrypts every peer row, as a real sibling tab does. */
const decryptingEncryption = (titleByUuid: Record<string, string> = {}) =>
  ({
    decryptSplit: jest.fn(async (split: unknown) =>
      splitItems(split).map((payload) => decryptedPayload(payload.uuid, titleByUuid[payload.uuid] ?? 'peer version')),
    ),
  }) as unknown as jest.Mocked<Pick<EncryptionProviderInterface, 'decryptSplit'>>

/** A key we do not hold: decryptSplit hands the payload back still encrypted. */
const nonDecryptingEncryption = () =>
  ({
    decryptSplit: jest.fn(async (split: unknown) => splitItems(split)),
  }) as unknown as jest.Mocked<Pick<EncryptionProviderInterface, 'decryptSplit'>>

describe('reloadForeignDatabasePayloads', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('coalesces UUIDs and reloads from disk without scheduling or persisting another sync edge', async () => {
    const storage = {
      getRawPayloads: jest.fn().mockResolvedValue([rawEncryptedRow('a'), rawEncryptedRow('b')]),
    } as unknown as jest.Mocked<Pick<StorageServiceInterface, 'getRawPayloads'>>
    const payloads = {
      emitPayloads: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Pick<PayloadManagerInterface, 'emitPayloads'>>

    await reloadForeignDatabasePayloads(['a', 'b', 'a'], storage, payloads, decryptingEncryption())

    expect(storage.getRawPayloads).toHaveBeenCalledTimes(1)
    expect(storage.getRawPayloads).toHaveBeenCalledWith(['a', 'b'])
    expect(payloads.emitPayloads).toHaveBeenCalledTimes(1)
    const [emitted, source] = payloads.emitPayloads.mock.calls[0]
    expect(source).toBe(PayloadEmitSource.LocalDatabaseLoaded)
    expect(emitted.map((payload) => payload.uuid)).toEqual(['a', 'b'])
  })

  it('does nothing for an empty invalidation batch', async () => {
    const storage = { getRawPayloads: jest.fn() }
    const payloads = { emitPayloads: jest.fn() }

    await reloadForeignDatabasePayloads([], storage as never, payloads as never, decryptingEncryption())

    expect(storage.getRawPayloads).not.toHaveBeenCalled()
    expect(payloads.emitPayloads).not.toHaveBeenCalled()
  })

  it('decrypts the peer rows before emitting them, never handing ciphertext to the item graph', async () => {
    const storage = {
      getRawPayloads: jest.fn().mockResolvedValue([rawEncryptedRow(NOTE_UUID)]),
    } as unknown as jest.Mocked<Pick<StorageServiceInterface, 'getRawPayloads'>>
    const payloads = {
      emitPayloads: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Pick<PayloadManagerInterface, 'emitPayloads'>>
    const encryption = decryptingEncryption()

    await reloadForeignDatabasePayloads([NOTE_UUID], storage, payloads, encryption)

    expect(encryption.decryptSplit).toHaveBeenCalledTimes(1)
    const [emitted] = payloads.emitPayloads.mock.calls[0]
    expect(emitted).toHaveLength(1)
    expect(typeof emitted[0].content).toBe('object')
  })

  it('still propagates a peer tab deletion, which needs no decryption', async () => {
    const storage = {
      getRawPayloads: jest.fn().mockResolvedValue([rawDeletedRow(NOTE_UUID)]),
    } as unknown as jest.Mocked<Pick<StorageServiceInterface, 'getRawPayloads'>>
    const payloads = {
      emitPayloads: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Pick<PayloadManagerInterface, 'emitPayloads'>>
    const encryption = decryptingEncryption()

    await reloadForeignDatabasePayloads([NOTE_UUID], storage, payloads, encryption)

    expect(encryption.decryptSplit).not.toHaveBeenCalled()
    const [emitted] = payloads.emitPayloads.mock.calls[0]
    expect(emitted.map((payload) => payload.uuid)).toEqual([NOTE_UUID])
    expect(emitted[0].deleted).toBe(true)
  })

  /**
   * THE REGRESSION THIS FILE EXISTS FOR, driven through the REAL PayloadManager, ItemManager,
   * ItemCollection and navigation display controller rather than a mocked emit: a peer tab's
   * save must not be able to remove a note from this tab's list or deselect it.
   */
  describe('through the real item graph', () => {
    const buildGraph = () => {
      const logger = { debug: jest.fn(), error: jest.fn() } as unknown as LoggerInterface
      const internalEventBus = { publish: jest.fn(), publishSync: jest.fn() } as unknown as InternalEventBusInterface
      const payloadManager = new PayloadManager(logger, internalEventBus)
      const items = new ItemManager(payloadManager, internalEventBus)
      return { payloadManager, items }
    }

    const storageReturning = (rows: FullyFormedTransferPayload[]) =>
      ({
        getRawPayloads: jest.fn().mockResolvedValue(rows),
      }) as unknown as jest.Mocked<Pick<StorageServiceInterface, 'getRawPayloads'>>

    it('keeps the note displayable and never reports it as removed to the UI', async () => {
      const { payloadManager, items } = buildGraph()

      await payloadManager.emitPayload(decryptedPayload(NOTE_UUID, 'my note'), PayloadEmitSource.LocalInserted)
      expect(items.getDisplayableNotes().map((note) => note.uuid)).toEqual([NOTE_UUID])

      const removedUuids: string[] = []
      const unsubscribe = items.addObserver(ContentType.TYPES.Note, ({ removed }) => {
        removedUuids.push(...removed.map((item) => item.uuid))
      })

      await reloadForeignDatabasePayloads(
        [NOTE_UUID],
        storageReturning([rawEncryptedRow(NOTE_UUID)]),
        payloadManager,
        decryptingEncryption({ [NOTE_UUID]: 'peer edited title' }),
      )
      unsubscribe()

      const displayable = items.getDisplayableNotes()
      expect(displayable.map((note) => note.uuid)).toEqual([NOTE_UUID])
      expect(displayable[0].title).toBe('peer edited title')
      expect(removedUuids).toEqual([])
    })

    it('leaves the copy already in memory alone when the peer row cannot be decrypted', async () => {
      const { payloadManager, items } = buildGraph()

      await payloadManager.emitPayload(decryptedPayload(NOTE_UUID, 'my note'), PayloadEmitSource.LocalInserted)

      const removedUuids: string[] = []
      const unsubscribe = items.addObserver(ContentType.TYPES.Note, ({ removed }) => {
        removedUuids.push(...removed.map((item) => item.uuid))
      })

      await reloadForeignDatabasePayloads(
        [NOTE_UUID],
        storageReturning([rawEncryptedRow(NOTE_UUID)]),
        payloadManager,
        nonDecryptingEncryption(),
      )
      unsubscribe()

      const displayable = items.getDisplayableNotes()
      expect(displayable.map((note) => note.uuid)).toEqual([NOTE_UUID])
      expect(displayable[0].title).toBe('my note')
      expect(removedUuids).toEqual([])
      expect(consoleError).toHaveBeenCalled()
    })

    it('a peer tab deletion still removes the note from the list', async () => {
      const { payloadManager, items } = buildGraph()

      await payloadManager.emitPayload(decryptedPayload(NOTE_UUID, 'my note'), PayloadEmitSource.LocalInserted)
      expect(items.getDisplayableNotes()).toHaveLength(1)

      await reloadForeignDatabasePayloads(
        [NOTE_UUID],
        storageReturning([rawDeletedRow(NOTE_UUID)]),
        payloadManager,
        decryptingEncryption(),
      )

      expect(items.getDisplayableNotes()).toHaveLength(0)
    })
  })
})
