import { MutationType, SNNote } from '@standardnotes/snjs'
import { NotesController } from './NotesController'
import { NOTE_VIEW_KEY } from '@/View/editorViewPreferences'

jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: {} }))
jest.mock('@/Achievements', () => ({ achievements: {}, METRICS: {} }))
jest.mock('@/Services/Achievements/restoreCounter', () => ({ recordItemRestore: jest.fn() }))

function harness() {
  const note = {
    uuid: 'note',
    locked: false,
    payload: {},
    getAppDomainValue: () => ({ tocMode: 'left' }),
  } as unknown as SNNote
  let current = note
  const written: Record<string, unknown> = {}
  const application = {
    sessions: { isCurrentSessionReadOnly: () => false },
    items: { findItem: () => current },
    mutator: {
      changeItem: jest.fn(async (_note, mutate) =>
        mutate({
          setAppDataItem: (key: string, value: unknown) => {
            written[key] = value
          },
        }),
      ),
    },
    sync: { sync: jest.fn(async () => undefined) },
  }
  const controller = Object.create(NotesController.prototype) as NotesController
  Object.assign(controller, { application })
  return {
    controller,
    note,
    application,
    written,
    replace: (next: SNNote) => {
      current = next
    },
  }
}

it('merges view settings into the latest note metadata without changing the body or user timestamps', async () => {
  const h = harness()
  h.replace({
    ...h.note,
    getAppDomainValue: () => ({ tocMode: 'floating', commentsVisible: true }),
  } as unknown as SNNote)
  await h.controller.patchNoteViewPreferences(h.note, { tocWidth: 310 })
  expect(h.written).toEqual({ [NOTE_VIEW_KEY]: { tocMode: 'floating', commentsVisible: true, tocWidth: 310 } })
  expect(h.application.mutator.changeItem).toHaveBeenCalledWith(
    h.note,
    expect.any(Function),
    MutationType.NoUpdateUserTimestamps,
  )
  expect(h.application.sync.sync).toHaveBeenCalledTimes(1)
})

it('rejects a note that disappears before its metadata can be saved', async () => {
  const h = harness()
  h.replace(undefined as unknown as SNNote)
  await expect(h.controller.patchNoteViewPreferences(h.note, { tocVisible: true })).rejects.toThrow('finish loading')
  expect(h.application.mutator.changeItem).not.toHaveBeenCalled()
})

it('rejects writes to locked notes', async () => {
  const h = harness()
  await expect(
    h.controller.patchNoteViewPreferences({ ...h.note, locked: true } as SNNote, { tocVisible: true }),
  ).rejects.toThrow('read only')
  expect(h.application.mutator.changeItem).not.toHaveBeenCalled()
})
