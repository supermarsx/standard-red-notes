import { ContentType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { MAX_CONTEXT_NOTES, resolveContextNoteUuids, resolveContextNotes } from './assistantContextSource'

describe('assistant context authorization scope', () => {
  it('retains the current note when focus moves from the editor into the assistant', () => {
    const note = {
      uuid: 'focused-note',
      title: 'Editor-owned note',
      text: 'Current body',
      noteType: 'org.standardnotes.plain-text',
      content_type: ContentType.TYPES.Note,
      trashed: false,
    } as unknown as SNNote
    const application = {
      itemListController: {
        activeControllerItem: undefined,
        firstSelectedItem: note,
        selectedItemsCount: 1,
      },
    } as unknown as WebApplication

    expect(resolveContextNotes(application, { scope: 'current-note' }).notes).toEqual([
      expect.objectContaining({ uuid: note.uuid, title: note.title, text: note.text }),
    ])
    expect(resolveContextNoteUuids(application, { scope: 'current-note' })).toEqual([note.uuid])
  })

  it('fails closed when there is no active or uniquely selected note', () => {
    const application = {
      itemListController: {
        activeControllerItem: undefined,
        firstSelectedItem: undefined,
        selectedItemsCount: 0,
      },
    } as unknown as WebApplication

    expect(resolveContextNoteUuids(application, { scope: 'current-note' })).toEqual([])
  })

  it('fails closed when a non-note is active even if a stale note remains selected', () => {
    const selectedNote = {
      uuid: 'stale-selected-note',
      title: 'Previously selected',
      text: 'Do not disclose me',
      content_type: ContentType.TYPES.Note,
      trashed: false,
    } as unknown as SNNote
    const application = {
      itemListController: {
        activeControllerItem: { uuid: 'active-file', content_type: ContentType.TYPES.File },
        firstSelectedItem: selectedNote,
        selectedItemsCount: 1,
      },
    } as unknown as WebApplication

    expect(resolveContextNotes(application, { scope: 'current-note' }).notes).toEqual([])
    expect(resolveContextNoteUuids(application, { scope: 'current-note' })).toEqual([])
  })

  it('keeps every explicitly selected all-notes UUID authorized while capping prompt material', () => {
    const notes = Array.from({ length: MAX_CONTEXT_NOTES + 5 }, (_, index) => ({
      uuid: `note-${index}`,
      title: `Note ${index}`,
      text: 'Body',
      noteType: 'org.standardnotes.plain-text',
      content_type: ContentType.TYPES.Note,
      trashed: false,
    })) as unknown as SNNote[]
    const application = {
      items: { getItems: jest.fn().mockReturnValue(notes) },
    } as unknown as WebApplication

    const selection = { scope: 'all-notes' as const }
    expect(resolveContextNotes(application, selection).notes).toHaveLength(MAX_CONTEXT_NOTES)
    expect(resolveContextNoteUuids(application, selection)).toEqual(notes.map((note) => note.uuid))
  })
})
