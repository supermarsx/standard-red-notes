import { autorun } from 'mobx'
import {
  ContentReferenceType,
  FolderContent,
  FolderContentType,
  SNFolder,
  VaultDisplayOptions,
  ContentType,
  DecryptedPayload,
  DeletedPayload,
  FillItemContent,
  ItemManager,
  NoteContent,
  PayloadEmitSource,
  PayloadManager,
  PayloadTimestampDefaults,
  SNTag,
  TagContent,
} from '@standardnotes/snjs'
import { NavigationController } from './NavigationController'

const graph = () => {
  const events = { publish: jest.fn(), publishSync: jest.fn(), addEventHandler: jest.fn() }
  const payloads = new PayloadManager(
    { debug: jest.fn(), error: jest.fn() } as unknown as ConstructorParameters<typeof PayloadManager>[0],
    events as unknown as ConstructorParameters<typeof PayloadManager>[1],
  )
  const items = new ItemManager(payloads, events as unknown as ConstructorParameters<typeof ItemManager>[1])
  const controller = () =>
    new NavigationController(
      ...([
        {},
        {},
        { addWithShortcut: jest.fn(() => jest.fn()) },
        {},
        {},
        {},
        items,
        { getValue: (_key: unknown, fallback: unknown) => fallback },
        {},
        {},
        {},
        events,
      ] as unknown as ConstructorParameters<typeof NavigationController>),
    )
  return { items, payloads, controller }
}
const note = (uuid: string) =>
  new DecryptedPayload<NoteContent>({
    uuid,
    content_type: ContentType.TYPES.Note,
    content: FillItemContent<NoteContent>({ title: uuid, text: 'content' }),
    ...PayloadTimestampDefaults(),
  })
const remove = (uuid: string) =>
  new DeletedPayload({
    uuid,
    content_type: ContentType.TYPES.Note,
    deleted: true,
    content: undefined,
    ...PayloadTimestampDefaults(),
  })

describe('navigation count snapshots', () => {
  let migration: jest.SpyInstance
  beforeEach(() => {
    migration = jest
      .spyOn(
        NavigationController.prototype as unknown as {
          runFolderMigrationIfNeeded(): Promise<void>
        },
        'runFolderMigrationIfNeeded',
      )
      .mockResolvedValue(undefined)
  })
  afterEach(() => {
    migration.mockRestore()
  })

  it('starts from already loaded counts and corrects observed tag/all-note counts on remote clean deletion', async () => {
    const { items, payloads, controller: construct } = graph()
    await payloads.emitPayloads(
      [
        note('a'),
        note('b'),
        new DecryptedPayload<TagContent>({
          uuid: 'tag',
          content_type: ContentType.TYPES.Tag,
          content: FillItemContent<TagContent>({
            title: 'topic',
            references: [
              { uuid: 'a', content_type: ContentType.TYPES.Note },
              { uuid: 'b', content_type: ContentType.TYPES.Note },
            ],
          }),
          ...PayloadTimestampDefaults(),
        }),
      ],
      PayloadEmitSource.LocalDatabaseLoaded,
    )
    const controller = construct()
    const tag = items.findSureItem<SNTag>('tag')
    const counts: Array<{ all: number; tag: number }> = []
    const stop = autorun(() => counts.push({ all: controller.allNotesCount, tag: controller.getNotesCount(tag) }))
    try {
      expect(counts.at(-1)).toEqual({ all: 2, tag: 2 })
      await payloads.emitPayload(remove('a'), PayloadEmitSource.LocalRetrieved)
      expect(items.findItem('a')).toBeUndefined()
      expect(counts.at(-1)).toEqual({ all: 1, tag: 1 })
      await payloads.emitPayload(remove('b'), PayloadEmitSource.RemoteRetrieved)
      expect(counts.at(-1)).toEqual({ all: 0, tag: 0 })
    } finally {
      stop()
      controller.deinit()
      items.deinit()
      payloads.deinit()
    }
  })

  it('updates the observed note count when a mixed deletion/file batch leaves the aggregate size unchanged', async () => {
    const { items, payloads, controller: construct } = graph()
    await payloads.emitPayload(note('a'), PayloadEmitSource.LocalDatabaseLoaded)
    const controller = construct()
    const counts: number[] = []
    const stop = autorun(() => counts.push(controller.allNotesCount))
    try {
      expect(counts).toEqual([1])
      await payloads.emitPayloads(
        [
          remove('a'),
          new DecryptedPayload({
            uuid: 'file',
            content_type: ContentType.TYPES.File,
            content: FillItemContent({}),
            ...PayloadTimestampDefaults(),
          }),
        ],
        PayloadEmitSource.RemoteRetrieved,
      )
      expect(counts).toEqual([1, 0])
    } finally {
      stop()
      controller.deinit()
      items.deinit()
      payloads.deinit()
    }
  })

  it('keeps folder badges matched to direct scoped membership through trash/restore and peer deletion', async () => {
    const { items, payloads, controller: construct } = graph()
    const a = note('a').copy({ key_system_identifier: 'vault-a' })
    const b = note('b').copy({ key_system_identifier: 'vault-a' })
    const excluded = note('excluded').copy({ key_system_identifier: 'vault-b' })
    const folder = (uuid: string, notes: string[], parent?: string) =>
      new DecryptedPayload<FolderContent>({
        uuid,
        content_type: FolderContentType,
        content: FillItemContent<FolderContent>({
          title: uuid,
          references: [
            ...notes.map((uuid) => ({ uuid, content_type: ContentType.TYPES.Note })),
            ...(parent
              ? [
                  {
                    uuid: parent,
                    content_type: FolderContentType,
                    reference_type: ContentReferenceType.FolderToParentFolder as const,
                  },
                ]
              : []),
          ],
        }),
        ...PayloadTimestampDefaults(),
      })
    await payloads.emitPayloads(
      [a, b, excluded, folder('parent', ['a']), folder('child', ['a', 'b', 'excluded'], 'parent')],
      PayloadEmitSource.LocalDatabaseLoaded,
    )
    items.setVaultDisplayOptions(new VaultDisplayOptions({ exclusive: 'vault-a' }))
    const controller = construct()
    const parent = items.findSureItem<SNFolder>('parent'),
      child = items.findSureItem<SNFolder>('child')
    const counts: Array<{ parent: number; child: number }> = []
    const stop = autorun(() =>
      counts.push({ parent: controller.getFolderNotesCount(parent), child: controller.getFolderNotesCount(child) }),
    )
    try {
      expect(counts.at(-1)).toEqual({ parent: 1, child: 2 })
      expect(items.countableNotesForFolder(parent, false)).toBe(1)
      expect(items.countableNotesForFolder(parent, true)).toBe(2)
      await payloads.emitPayload(
        b.copy({ content: FillItemContent<NoteContent>({ title: 'b', trashed: true }) }),
        PayloadEmitSource.LocalChanged,
      )
      expect(counts.at(-1)).toEqual({ parent: 1, child: 1 })
      await payloads.emitPayload(b, PayloadEmitSource.LocalChanged)
      expect(counts.at(-1)).toEqual({ parent: 1, child: 2 })
      await payloads.emitPayload(remove('a'), PayloadEmitSource.LocalRetrieved)
      expect(counts.at(-1)).toEqual({ parent: 0, child: 1 })
      await payloads.emitPayload(remove('b'), PayloadEmitSource.RemoteRetrieved)
      expect(counts.at(-1)).toEqual({ parent: 0, child: 0 })
      expect(items.findItem('excluded')).toBeDefined()
    } finally {
      stop()
      controller.deinit()
      items.deinit()
      payloads.deinit()
    }
  })
})
