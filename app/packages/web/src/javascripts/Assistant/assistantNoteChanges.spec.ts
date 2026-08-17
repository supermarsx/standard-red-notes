import {
  ContentType,
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  NoteType,
  PayloadEmitSource,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  applyAssistantNoteChange,
  buildAssistantNoteChange,
  captureAssistantNoteSnapshot,
} from './assistantNoteChanges'

const createNote = (title: string, text: string, uuid = 'note-1'): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title, text, noteType: NoteType.Plain }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

describe('assistant note changes', () => {
  it('renders a bounded git-style line diff with accurate additions and removals', () => {
    const before = captureAssistantNoteSnapshot(createNote('Plan', 'keep\nold\ntail'))
    const after = captureAssistantNoteSnapshot(createNote('Launch plan', 'keep\nnew\nextra\ntail'))

    const change = buildAssistantNoteChange({ noteUuid: 'note-1', before, after })

    expect(change).toMatchObject({ addedLines: 3, removedLines: 2, truncated: false })
    expect(change?.patch).toContain('diff --git a/note-title.txt b/note-title.txt')
    expect(change?.patch).toContain('-Plan')
    expect(change?.patch).toContain('+Launch plan')
    expect(change?.patch).toContain('diff --git a/note.md b/note.md')
    expect(change?.patch).toContain('-old')
    expect(change?.patch).toContain('+new')
    expect(change?.patch).toContain('+extra')
  })

  it('records format-only conversions even when the visible Markdown is unchanged', () => {
    const before = captureAssistantNoteSnapshot(createNote('Plan', 'same text'))
    const after = {
      ...before,
      text: '{"root":{"type":"root","children":[]}}',
      noteType: NoteType.Super,
      editorIdentifier: 'org.standardnotes.super-editor',
    }

    const change = buildAssistantNoteChange({
      noteUuid: 'note-1',
      before,
      after,
      beforeDisplayText: 'same text',
      afterDisplayText: 'same text',
    })

    expect(change).toMatchObject({ addedLines: 1, removedLines: 1 })
    expect(change?.patch).toContain('diff --git a/note-format.txt b/note-format.txt')
    expect(change?.patch).toContain(`-${NoteType.Plain}`)
    expect(change?.patch).toContain(`+${NoteType.Super} (org.standardnotes.super-editor)`)
  })

  it('undoes and redoes only while the note still matches the recorded boundary', async () => {
    let live = createNote('After', 'new')
    const before = captureAssistantNoteSnapshot(createNote('Before', 'old'))
    const after = captureAssistantNoteSnapshot(live)
    const change = buildAssistantNoteChange({ noteUuid: live.uuid, before, after })!
    const sync = jest.fn().mockResolvedValue(undefined)
    const changeItem = jest.fn(async (_note, mutate, _mutationType, emitSource) => {
      const next = {
        title: live.title,
        text: live.text,
        preview_plain: live.preview_plain,
        preview_html: live.preview_html,
        noteType: live.noteType,
        editorIdentifier: live.editorIdentifier,
      }
      mutate(next)
      live = createNote(next.title, next.text)
      expect(emitSource).toBe(PayloadEmitSource.AssistantChanged)
      return live
    })
    const application = {
      items: { findItem: () => live },
      isAuthorizedToRenderItem: () => true,
      sessions: { isCurrentSessionReadOnly: () => false },
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      mutator: { changeItem },
      sync: { sync },
    } as unknown as WebApplication

    await expect(applyAssistantNoteChange(application, change, 'undo')).resolves.toEqual({
      position: 'before',
      alreadyApplied: false,
    })
    expect(live.title).toBe('Before')
    expect(live.text).toBe('old')

    await expect(applyAssistantNoteChange(application, change, 'redo')).resolves.toEqual({
      position: 'after',
      alreadyApplied: false,
    })
    expect(live.title).toBe('After')
    expect(live.text).toBe('new')
    expect(changeItem).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('refuses to overwrite a later user edit during undo', async () => {
    const before = captureAssistantNoteSnapshot(createNote('Before', 'old'))
    const after = captureAssistantNoteSnapshot(createNote('After', 'new'))
    const changedAgain = createNote('After', 'new plus a user edit')
    const application = {
      items: { findItem: () => changedAgain },
      isAuthorizedToRenderItem: () => true,
      sessions: { isCurrentSessionReadOnly: () => false },
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      mutator: { changeItem: jest.fn() },
      sync: { sync: jest.fn() },
    } as unknown as WebApplication
    const change = buildAssistantNoteChange({ noteUuid: changedAgain.uuid, before, after })!

    await expect(applyAssistantNoteChange(application, change, 'undo')).rejects.toThrow('changed again')
    expect(application.mutator.changeItem).not.toHaveBeenCalled()
  })

  it('flushes every mounted editor before evaluating the undo boundary', async () => {
    let live = createNote('After', 'new')
    const firstFlush = jest.fn(async () => undefined)
    const secondFlush = jest.fn(async () => {
      live = createNote('After', 'new plus pending typing')
    })
    const before = captureAssistantNoteSnapshot(createNote('Before', 'old'))
    const after = captureAssistantNoteSnapshot(createNote('After', 'new'))
    const application = {
      itemControllerGroup: {
        itemControllers: [
          { item: { uuid: live.uuid }, flushAndAwaitPendingSaveStrict: firstFlush },
          { item: { uuid: live.uuid }, flushAndAwaitPendingSaveStrict: secondFlush },
        ],
      },
      items: { findItem: () => live },
      isAuthorizedToRenderItem: () => true,
      sessions: { isCurrentSessionReadOnly: () => false },
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      mutator: { changeItem: jest.fn() },
      sync: { sync: jest.fn() },
    } as unknown as WebApplication
    const change = buildAssistantNoteChange({ noteUuid: live.uuid, before, after })!

    await expect(applyAssistantNoteChange(application, change, 'undo')).rejects.toThrow('changed again')
    expect(firstFlush).toHaveBeenCalledTimes(1)
    expect(secondFlush).toHaveBeenCalledTimes(1)
    expect(application.mutator.changeItem).not.toHaveBeenCalled()
  })
})
