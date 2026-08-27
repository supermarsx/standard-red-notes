/**
 * REGRESSION GUARD: trashing / deleting a COLD-LOADED (lite) note.
 *
 * `lazyDecryptEnabled` is on in the web app, so a note the user has never opened keeps only its
 * metadata in memory and its body is stripped. The model safety guard deliberately REFUSES to
 * dirty such a payload (syncing it would overwrite the real ciphertext with an empty body), which
 * surfaced in production as an uncaught `LitePayloadSafetyError` from
 * `setTrashSelectedNotes → deleteNotes → changeSelectedNotes → changeItems → getResult`, with the
 * note simply not deleting and nothing shown to the user.
 *
 * These tests drive the controller against a REAL `NoteMutator` (so the real guard runs) and
 * assert three things the previous code got wrong: the note is actually trashed, the notes acted
 * upon are the ones the user confirmed, and any note that could not be written is reported.
 */
import {
  ContentType,
  DecryptedPayload,
  DecryptedPayloadInterface,
  FillItemContent,
  MutationType,
  NoteContent,
  NoteMutator,
  PayloadTimestampDefaults,
  SNNote,
  createLitePayloadFromDecrypted,
} from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import { NotesController } from './NotesController'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  dismissToast: jest.fn(),
  updateToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Info: 'info', Progress: 'progress', Regular: 'regular' },
}))

jest.mock('@standardnotes/ui-services', () => ({
  ...jest.requireActual('@standardnotes/ui-services'),
  confirmDialog: jest.fn(),
}))

jest.mock('@/Achievements', () => ({
  achievements: { increment: jest.fn(), setAtLeast: jest.fn() },
  METRICS: new Proxy({}, { get: (_target, key) => String(key) }),
}))

jest.mock('@/Services/Achievements/restoreCounter', () => ({
  recordItemRestore: jest.fn(() => 1),
}))

const mockedAddToast = jest.mocked(addToast)
const mockedConfirmDialog = jest.mocked(confirmDialog)

const fullPayload = (uuid: string, title: string, text: string): DecryptedPayloadInterface<NoteContent> =>
  new DecryptedPayload<NoteContent>({
    uuid,
    content_type: ContentType.TYPES.Note,
    content: FillItemContent<NoteContent>({ title, text }),
    ...PayloadTimestampDefaults(),
  })

const createHarness = () => {
  /** In-memory item collection, standing in for ItemManager. */
  const items = new Map<string, SNNote>()
  /** On-disk full payloads, standing in for `sync.getFullContentPayload`. */
  const disk = new Map<string, DecryptedPayloadInterface<NoteContent>>()

  let selection: string[] = []

  const seedFullNote = (uuid: string, title = uuid, text = `body of ${uuid}`) => {
    const payload = fullPayload(uuid, title, text)
    disk.set(uuid, payload)
    items.set(uuid, new SNNote(payload))
    return items.get(uuid) as SNNote
  }

  /** A note as it exists after a cold load: metadata only, body stripped. */
  const seedLiteNote = (uuid: string, options: { onDisk?: boolean } = {}) => {
    const payload = fullPayload(uuid, uuid, `body of ${uuid}`)
    if (options.onDisk ?? true) {
      disk.set(uuid, payload)
    }
    items.set(uuid, new SNNote(createLitePayloadFromDecrypted(payload)))
    return items.get(uuid) as SNNote
  }

  const changeItems = jest.fn(
    async (notes: SNNote[], mutate: (mutator: NoteMutator) => void, mutationType: MutationType) => {
      /** Mirrors MutatorService: resolve LIVE items by uuid, build every payload, then emit. */
      const payloads = notes.map((note) => {
        const live = items.get(note.uuid)
        if (!live) {
          throw Error('Attempting to change non-existant item')
        }
        const mutator = new NoteMutator(live, mutationType)
        mutate(mutator)
        return mutator.getResult()
      })

      payloads.forEach((payload) => items.set(payload.uuid, new SNNote(payload)))

      return payloads.map((payload) => items.get(payload.uuid) as SNNote)
    },
  )

  const selectNextItem = jest.fn(() => {
    /**
     * The real `selectNextItem` fires an UNAWAITED async selection replacement. Reproducing that
     * here is the point of the race test: the controller must not re-read the selection after an
     * await and act on whatever landed in the meantime.
     */
    void Promise.resolve().then(() => {
      selection = ['next-note']
    })
  })

  const application = {
    items: { findItem: (uuid: string) => items.get(uuid) },
    sync: {
      sync: jest.fn().mockResolvedValue(undefined),
      getFullContentPayload: jest.fn(async (uuid: string) => disk.get(uuid)),
    },
    mutator: {
      changeItems,
      changeItem: jest.fn(),
      emitItemFromPayload: jest.fn(async (payload: DecryptedPayloadInterface) => {
        items.set(payload.uuid, new SNNote(payload as DecryptedPayloadInterface<NoteContent>))
        return items.get(payload.uuid)
      }),
      deleteItem: jest.fn(async (note: SNNote) => {
        items.delete(note.uuid)
      }),
    },
    itemListController: {
      selectNextItem,
      deselectAll: jest.fn(),
      getFilteredSelectedItems: () => selection.map((uuid) => items.get(uuid)).filter((note) => !!note),
    },
    alerts: { alert: jest.fn().mockResolvedValue(undefined) },
  }

  const controller = Object.create(NotesController.prototype) as NotesController
  Object.assign(controller as object, { application })

  return {
    controller,
    application,
    changeItems,
    selectNextItem,
    items,
    disk,
    seedFullNote,
    seedLiteNote,
    select: (...uuids: string[]) => {
      selection = uuids
    },
  }
}

describe('NotesController trash/delete under lazy-decrypt', () => {
  beforeEach(() => {
    mockedConfirmDialog.mockResolvedValue(true)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('trashes a cold-loaded lite note end to end, keeping its real body', async () => {
    const harness = createHarness()
    harness.seedLiteNote('note-1')
    harness.select('note-1')

    const didDelete = await harness.controller.deleteNotes(false)

    expect(didDelete).toBe(true)
    const after = harness.items.get('note-1') as SNNote
    expect(after.trashed).toBe(true)
    /** The body must survive: writing the stripped payload is the data loss the guard prevents. */
    expect(after.text).toEqual('body of note-1')
    expect(mockedAddToast).not.toHaveBeenCalled()
  })

  it('acts on the notes the user confirmed, not on whatever the selection moved to', async () => {
    const harness = createHarness()
    harness.seedLiteNote('note-1')
    harness.seedFullNote('next-note')
    harness.select('note-1')

    await harness.controller.deleteNotes(false)

    expect(harness.selectNextItem).toHaveBeenCalled()
    expect((harness.items.get('note-1') as SNNote).trashed).toBe(true)
    /** The note the selection jumped to must be untouched — trashing it would be silent data loss. */
    expect((harness.items.get('next-note') as SNNote).trashed).toBeFalsy()
  })

  it('reports partial failure with a count when some bodies cannot be read back', async () => {
    const harness = createHarness()
    harness.seedLiteNote('note-1')
    harness.seedLiteNote('note-2', { onDisk: false })
    harness.seedLiteNote('note-3', { onDisk: false })
    harness.select('note-1', 'note-2', 'note-3')

    await harness.controller.deleteNotes(false)

    /** The one note that could be written still is — a failure elsewhere must not block it. */
    expect((harness.items.get('note-1') as SNNote).trashed).toBe(true)
    expect((harness.items.get('note-2') as SNNote).trashed).toBeFalsy()
    expect((harness.items.get('note-3') as SNNote).trashed).toBeFalsy()

    expect(mockedAddToast).toHaveBeenCalledTimes(1)
    const toast = mockedAddToast.mock.calls[0][0]
    expect(toast.type).toEqual(ToastType.Error)
    expect(toast.message).toEqual(
      '1 of 3 notes moved to trash; 2 failed. Their content could not be loaded from this device. ' +
        'Open them once, then try again.',
    )

    /** Toasting does not replace diagnosis: the failure is still logged. */
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed for 2 of 3 notes'), ['note-2', 'note-3'])
  })

  it('reports a single note that could not be trashed', async () => {
    const harness = createHarness()
    harness.seedLiteNote('note-1', { onDisk: false })
    harness.select('note-1')

    const didDelete = await harness.controller.deleteNotes(false)

    expect(didDelete).toBe(false)
    expect((harness.items.get('note-1') as SNNote).trashed).toBeFalsy()
    expect(mockedAddToast.mock.calls[0][0].message).toEqual(
      'This note could not be moved to trash. Its content could not be loaded from this device. ' +
        'Open the note once, then try again.',
    )
  })

  it('does not toast, or mutate, when the user cancels the confirmation', async () => {
    const harness = createHarness()
    mockedConfirmDialog.mockResolvedValue(false)
    harness.seedLiteNote('note-1', { onDisk: false })
    harness.select('note-1')

    expect(await harness.controller.deleteNotes(false)).toBe(false)
    expect(harness.changeItems).not.toHaveBeenCalled()
    expect(mockedAddToast).not.toHaveBeenCalled()
  })

  it('reports notes that could not be permanently deleted instead of counting them as deleted', async () => {
    const harness = createHarness()
    harness.seedFullNote('note-1')
    harness.seedFullNote('note-2')
    harness.select('note-1', 'note-2')

    harness.application.mutator.deleteItem.mockImplementation(async (note: SNNote) => {
      if (note.uuid === 'note-2') {
        throw new Error('blob deletion failed')
      }
      harness.items.delete(note.uuid)
    })

    const didDelete = await harness.controller.deleteNotes(true)

    expect(didDelete).toBe(true)
    expect(harness.items.has('note-1')).toBe(false)
    expect(harness.items.has('note-2')).toBe(true)
    expect(mockedAddToast.mock.calls[0][0].message).toEqual(
      '1 of 2 notes deleted; 1 failed. See the developer console for details, then try again.',
    )
  })
})
