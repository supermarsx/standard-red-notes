import { autorun } from 'mobx'
import {
  ContentType,
  DecryptedPayload,
  DeletedPayload,
  FillItemContent,
  ItemManager,
  MutatorService,
  NoteContent,
  NoteMutator,
  PayloadEmitSource,
  PayloadManager,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import { confirmDialog } from '@standardnotes/ui-services'
import { NotesController } from './NotesController'

jest.mock('@standardnotes/ui-services', () => ({
  ...jest.requireActual('@standardnotes/ui-services'),
  confirmDialog: jest.fn(),
}))
jest.mock('@/Achievements', () => ({ achievements: { increment: jest.fn() }, METRICS: {} }))

const setup = async () => {
  const events = { publish: jest.fn(), publishSync: jest.fn(), addEventHandler: jest.fn() }
  const payloads = new PayloadManager(
    { debug: jest.fn(), error: jest.fn() } as unknown as ConstructorParameters<typeof PayloadManager>[0],
    events as unknown as ConstructorParameters<typeof PayloadManager>[1],
  )
  const items = new ItemManager(payloads, events as unknown as ConstructorParameters<typeof ItemManager>[1])
  const mutator = new MutatorService(
    items,
    payloads,
    { alert: jest.fn() } as unknown as ConstructorParameters<typeof MutatorService>[2],
    events as unknown as ConstructorParameters<typeof MutatorService>[3],
  )
  let selected = ['personal-trash']
  const application = {
    events,
    items,
    mutator,
    preferences: { getValue: (_key: unknown, fallback: unknown) => fallback },
    commands: { add: jest.fn(() => jest.fn()) },
    keyboardService: { addCommandHandler: jest.fn(() => jest.fn()) },
    itemControllerGroup: { addActiveControllerChangeObserver: jest.fn(() => jest.fn()), itemControllers: [] },
    itemListController: {
      getFilteredSelectedItems: () => items.findItems<SNNote>(selected),
      selectNextItem: jest.fn(),
    },
    sync: { sync: jest.fn().mockResolvedValue(undefined) },
    alerts: { alert: jest.fn().mockResolvedValue(undefined) },
  }
  const seed = async (uuid: string, trashed: boolean, vault?: string) => {
    await payloads.emitPayload(
      new DecryptedPayload<NoteContent>({
        uuid,
        content_type: ContentType.TYPES.Note,
        key_system_identifier: vault,
        content: FillItemContent<NoteContent>({ title: uuid, text: 'content', trashed }),
        ...PayloadTimestampDefaults(),
      }),
      PayloadEmitSource.LocalDatabaseLoaded,
    )
  }
  await seed('personal-trash', true)
  await seed('vault-trash', true, 'vault-a')
  await seed('ordinary', false)
  const controller = new NotesController(
    application as unknown as ConstructorParameters<typeof NotesController>[0],
    {} as ConstructorParameters<typeof NotesController>[1],
    {} as ConstructorParameters<typeof NotesController>[2],
  )
  return {
    items,
    payloads,
    mutator,
    controller,
    seed,
    select: (uuid: string) => {
      selected = [uuid]
    },
  }
}

describe('observed Trash count', () => {
  beforeEach(() => {
    jest.mocked(confirmDialog).mockResolvedValue(true)
  })

  it('updates an already observed badge immediately after permanent deletion and Empty Trash across vaults', async () => {
    const { controller, items, payloads } = await setup()
    const counts: number[] = []
    const stop = autorun(() => counts.push(controller.trashedNotesCount))
    try {
      expect(counts).toEqual([2])
      await controller.deleteNotesPermanently()
      expect(items.findItem('personal-trash')).toBeUndefined()
      expect(counts).toEqual([2, 1])
      await controller.emptyTrash()
      expect(items.findItem('vault-trash')).toBeUndefined()
      expect(items.findItem('ordinary')).toBeDefined()
      expect(counts).toEqual([2, 1, 0])
    } finally {
      stop()
      controller.deinit()
      items.deinit()
      payloads.deinit()
    }
  })

  it('tracks cross-tab clean tombstones, trash/restoration and new inserts without pulsing for body-only saves', async () => {
    const { controller, items, payloads, mutator, seed } = await setup()
    const counts: number[] = []
    const stop = autorun(() => counts.push(controller.trashedNotesCount))
    try {
      await payloads.emitPayload(
        new DeletedPayload({
          uuid: 'personal-trash',
          content_type: ContentType.TYPES.Note,
          deleted: true,
          content: undefined,
          ...PayloadTimestampDefaults(),
        }),
        PayloadEmitSource.LocalRetrieved,
      )
      expect(counts).toEqual([2, 1])
      await mutator.changeItem<NoteMutator>(items.findSureItem('ordinary'), (m) => {
        m.trashed = true
      })
      expect(counts).toEqual([2, 1, 2])
      await mutator.changeItem<NoteMutator>(items.findSureItem('ordinary'), (m) => {
        m.text = 'new text'
      })
      expect(counts).toEqual([2, 1, 2])
      await mutator.changeItem<NoteMutator>(items.findSureItem('ordinary'), (m) => {
        m.trashed = false
      })
      await seed('new-trash', true, 'another-vault')
      expect(counts).toEqual([2, 1, 2, 1, 2])
    } finally {
      stop()
      controller.deinit()
      items.deinit()
      payloads.deinit()
    }
  })

  it('unsubscribes the count observer on teardown', async () => {
    const { controller, items, payloads, seed } = await setup()
    controller.deinit()
    await expect(seed('after-close', true)).resolves.toBeUndefined()
    items.deinit()
    payloads.deinit()
  })
})
