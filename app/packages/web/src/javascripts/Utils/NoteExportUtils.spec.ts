import { ContentType, NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

// The export path must re-hydrate each note's body before reading it: under
// lazy-decrypt an un-opened note is a body-less "lite" projection (text === ''),
// so reading raw note.text writes a BLANK file. Mock the rehydration helper so we
// can assert the export actually calls it and uses its (full) result — not the
// note's empty in-memory text.
const getFullNoteTextMock = jest.fn<Promise<string>, [unknown, SNNote]>()
jest.mock('./Items/rehydrateLazyDecryptedNote', () => ({
  getFullNoteText: (sync: unknown, note: SNNote) => getFullNoteTextMock(sync, note),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createNoteExport, noteHasEmbeddedFiles } = require('./NoteExportUtils') as typeof import('./NoteExportUtils')

const makeLiteNote = (overrides: Partial<SNNote> = {}): SNNote => {
  return {
    uuid: 'note-uuid-1',
    // Real notes always carry a content_type; the export path now filters on it
    // (never emit an items key / user preferences), so the mock must set it too.
    content_type: ContentType.TYPES.Note,
    title: 'Lite Note',
    // LITE: body was stripped on cold-load — reading this directly exports blank.
    text: '',
    noteType: NoteType.Plain,
    ...overrides,
  } as unknown as SNNote
}

const makeApplication = (): WebApplication => {
  return {
    // getPreference(key, default) → return the default in tests.
    getPreference: (_key: unknown, def: unknown) => def,
    sync: { id: 'sync-slice' },
    componentManager: {
      editorForNote: () => ({ fileType: 'txt' }),
    },
  } as unknown as WebApplication
}

describe('createNoteExport (lazy-decrypt re-hydration)', () => {
  beforeEach(() => {
    getFullNoteTextMock.mockReset()
  })

  it('re-hydrates the note body and exports the FULL text (not the empty lite text)', async () => {
    const application = makeApplication()
    const note = makeLiteNote()
    const REHYDRATED = 'the real body that lives only on disk'
    getFullNoteTextMock.mockResolvedValue(REHYDRATED)

    const result = await createNoteExport(application, [note])

    // The export MUST route through the rehydration helper (with the sync slice).
    expect(getFullNoteTextMock).toHaveBeenCalledTimes(1)
    expect(getFullNoteTextMock).toHaveBeenCalledWith(application.sync, note)

    // And the produced blob must contain the re-hydrated body, so its size matches
    // the full text — NOT 0, which is what reading raw note.text ('') would give.
    expect(result).toBeDefined()
    expect(result?.blob.size).toBe(new Blob([REHYDRATED]).size)
    expect(result?.blob.size).toBeGreaterThan(0)
  })

  it('exports EMPTY when the body cannot be re-hydrated (guards the assertion above is meaningful)', async () => {
    // Control: if re-hydration yields '' (the pre-fix behavior of reading raw
    // note.text), the blob is empty. This proves the non-empty size above is due to
    // the re-hydrated body, not incidental content.
    const application = makeApplication()
    const note = makeLiteNote()
    getFullNoteTextMock.mockResolvedValue('')

    const result = await createNoteExport(application, [note])

    expect(getFullNoteTextMock).toHaveBeenCalledTimes(1)
    expect(result?.blob.size).toBe(0)
  })

  it('EXCLUDES an items key / user preferences from a note export (no key-material leak)', async () => {
    const application = makeApplication()
    getFullNoteTextMock.mockResolvedValue('body')

    const itemsKey = makeLiteNote({ content_type: ContentType.TYPES.ItemsKey } as Partial<SNNote>)
    const userPrefs = makeLiteNote({ content_type: ContentType.TYPES.UserPrefs } as Partial<SNNote>)

    // A set containing ONLY non-exportable items produces nothing (all filtered out).
    const result = await createNoteExport(application, [itemsKey, userPrefs])

    expect(result).toBeUndefined()
    // The re-hydration/export path must never even run for a non-exportable item.
    expect(getFullNoteTextMock).not.toHaveBeenCalled()
  })
})

describe('noteHasEmbeddedFiles', () => {
  it('detects embedded files from the RE-HYDRATED text, not the empty lite text', () => {
    const note = makeLiteNote({ noteType: NoteType.Super } as Partial<SNNote>)
    // Raw lite text is empty → false; but the re-hydrated body has an snfile node.
    expect(noteHasEmbeddedFiles(note)).toBe(false)
    expect(noteHasEmbeddedFiles(note, '[{"type":"snfile","id":"x"}]')).toBe(true)
  })
})
