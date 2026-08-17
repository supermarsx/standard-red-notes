import { ContentType, SNNote, SNTag } from '@standardnotes/snjs'
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
      isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
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
      isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
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
      isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
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
      isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
      items: { getItems: jest.fn().mockReturnValue(notes) },
    } as unknown as WebApplication

    const selection = { scope: 'all-notes' as const }
    expect(resolveContextNotes(application, selection).notes).toHaveLength(MAX_CONTEXT_NOTES)
    expect(resolveContextNoteUuids(application, selection)).toEqual(notes.map((note) => note.uuid))
  })

  it('never discloses locked, partial, or render-denied notes to broad context', () => {
    const readable = {
      uuid: 'readable',
      title: 'Allowed',
      text: 'Visible body',
      content_type: ContentType.TYPES.Note,
      trashed: false,
    } as unknown as SNNote
    const locked = { ...readable, uuid: 'locked', locked: true, text: 'Locked secret' } as unknown as SNNote
    const lite = {
      ...readable,
      uuid: 'lite',
      text: '',
      payload: { content: { __lazyLite: true } },
    } as unknown as SNNote
    const denied = { ...readable, uuid: 'denied', text: 'Denied secret' } as unknown as SNNote
    const application = {
      isAuthorizedToRenderItem: jest.fn((note: SNNote) => note.uuid !== denied.uuid),
      items: { getItems: jest.fn().mockReturnValue([readable, locked, lite, denied]) },
    } as unknown as WebApplication

    expect(resolveContextNotes(application, { scope: 'all-notes' }).notes).toEqual([
      expect.objectContaining({ uuid: readable.uuid, text: readable.text }),
    ])
    expect(resolveContextNoteUuids(application, { scope: 'all-notes' })).toEqual([readable.uuid])
  })

  it('falls back to a readable child title when its tag parent is protected', () => {
    const note = {
      uuid: 'tagged-note',
      title: 'Allowed note',
      text: 'Visible body',
      content_type: ContentType.TYPES.Note,
      trashed: false,
    } as unknown as SNNote
    const parent = {
      uuid: 'protected-parent',
      title: 'Secret parent',
      content_type: ContentType.TYPES.Tag,
    } as unknown as SNTag
    const child = {
      uuid: 'readable-child',
      title: 'Visible child',
      parentId: parent.uuid,
      content_type: ContentType.TYPES.Tag,
    } as unknown as SNTag
    const application = {
      isAuthorizedToRenderItem: jest.fn((item: { uuid: string }) => item.uuid !== parent.uuid),
      items: {
        findItem: jest.fn().mockReturnValue(child),
        itemsReferencingItem: jest.fn().mockReturnValue([note]),
        getTagParent: jest.fn((tag: SNTag) => (tag.uuid === child.uuid ? parent : undefined)),
      },
    } as unknown as WebApplication

    const resolved = resolveContextNotes(application, {
      scope: 'collection',
      collection: { type: 'tag', uuid: child.uuid },
    })
    expect(resolved.collectionLabel).toBe(child.title)
    expect(resolved.notes).toEqual([expect.objectContaining({ uuid: note.uuid })])
  })
})
