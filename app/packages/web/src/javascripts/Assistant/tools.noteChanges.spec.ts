import {
  ContentType,
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  NoteMutator,
  NoteType,
  PayloadEmitSource,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { AssistantTools } from './tools'
import { AssistantNoteChange, captureAssistantNoteSnapshot } from './assistantNoteChanges'

jest.mock('@/Components/SuperEditor/Tools/HeadlessSuperConverter', () => ({
  HeadlessSuperConverter: class {},
}))

const makeNote = (title: string, text: string, overrides: Partial<NoteContent> = {}): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid: 'note-1',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title, text, noteType: NoteType.Plain, ...overrides }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

describe('AssistantTools note change presentation', () => {
  it('flushes the open editor, emits an assistant-originated mutation, and publishes its diff', async () => {
    let live = makeNote('Draft', 'first\nold')
    const flush = jest.fn(async () => {
      live = makeNote('Draft', 'first\nlatest local line')
    })
    const sync = jest.fn().mockResolvedValue(undefined)
    const changeItem = jest.fn(
      async (
        _note: SNNote,
        mutate: (mutator: NoteMutator) => void,
        _mutationType: unknown,
        source: PayloadEmitSource,
      ) => {
        const mutable = {
          title: live.title,
          text: live.text,
          preview_plain: live.preview_plain,
          preview_html: live.preview_html,
          noteType: live.noteType,
          editorIdentifier: live.editorIdentifier,
        }
        mutate(mutable as unknown as NoteMutator)
        live = makeNote(mutable.title, mutable.text)
        return live
      },
    )
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [{ item: live, flushAndAwaitPendingSaveStrict: flush }] },
      items: {
        findItem: () => live,
        getItems: () => [live],
        getSortedTagsForItem: () => [],
      },
      mutator: { changeItem },
      sync: { sync },
    } as unknown as WebApplication
    const changes: AssistantNoteChange[] = []
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
      onNoteChange: (_callId, change) => changes.push(change),
    })

    await expect(
      tools.call('notes.update', { uuid: live.uuid, title: 'Final', text: 'first\nnew' }, 'call-1'),
    ).resolves.toMatchObject({ ok: true, note: { title: 'Final' } })

    expect(flush).toHaveBeenCalledTimes(1)
    expect(changeItem.mock.calls[0][3]).toBe(PayloadEmitSource.AssistantChanged)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ noteTitle: 'Final', addedLines: 2, removedLines: 2 })
    expect(changes[0].patch).toContain('-latest local line')
    expect(changes[0].patch).toContain('+new')
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('rejects schema-blind body replacement for web-native structured editors', async () => {
    const live = makeNote('Calendar', '{"events":[]}', { editorIdentifier: 'org.standardnotes.calendar' })
    const changeItem = jest.fn()
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      items: { findItem: () => live, getItems: () => [live] },
      mutator: { changeItem },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })

    await expect(tools.call('notes.update', { uuid: live.uuid, text: 'break the schema' })).rejects.toThrow(
      /structured editor/,
    )
    await expect(
      tools.call('notes.update', { uuid: live.uuid, format: 'super', markdown: '# Break the schema' }),
    ).rejects.toThrow(/structured editor/)
    await expect(tools.call('notes.updateSuper', { uuid: live.uuid, markdown: '# Break the schema' })).rejects.toThrow(
      /structured editor/,
    )
    expect(changeItem).not.toHaveBeenCalled()
  })

  it('rejects a multibyte edit before mutation when its encrypted undo record cannot fit', async () => {
    const live = makeNote('Small', 'before')
    const changeItem = jest.fn()
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      items: { findItem: () => live, getItems: () => [live] },
      mutator: { changeItem },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })

    await expect(tools.call('notes.update', { uuid: live.uuid, text: '€'.repeat(40_000) })).rejects.toThrow(
      /encrypted undo record/,
    )
    expect(changeItem).not.toHaveBeenCalled()
  })

  it('refuses a lossy whole-note rewrite of a scheduled Super checklist', async () => {
    const checklist = JSON.stringify({
      root: {
        type: 'root',
        version: 1,
        children: [
          {
            type: 'list',
            version: 1,
            listType: 'check',
            children: [
              {
                type: 'listitem',
                version: 1,
                checked: false,
                $: { srnChecklistTodoId: 'todo-1', srnChecklistSchedule: { dueAt: '2026-08-20T09:00:00.000Z' } },
                children: [{ type: 'text', version: 1, text: 'Ship', format: 0 }],
              },
            ],
          },
        ],
      },
    })
    const live = makeNote('Release', checklist, {
      noteType: NoteType.Super,
      editorIdentifier: 'org.standardnotes.super-editor',
    })
    const changeItem = jest.fn()
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      items: { findItem: () => live, getItems: () => [live] },
      mutator: { changeItem },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })

    await expect(tools.call('notes.updateSuper', { uuid: live.uuid, markdown: '- [ ] Ship safely' })).rejects.toThrow(
      /Checklist identities, due dates, and recurrence/,
    )
    expect(changeItem).not.toHaveBeenCalled()
  })

  it('refuses an edit when the selected note changed after its context was sent', async () => {
    const sent = makeNote('Draft', 'sent body')
    const live = makeNote('Draft', 'newer user body')
    const changeItem = jest.fn()
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      items: { findItem: () => live, getItems: () => [live] },
      mutator: { changeItem },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      expectedNoteSnapshots: new Map([[live.uuid, captureAssistantNoteSnapshot(sent)]]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })

    await expect(tools.call('notes.update', { uuid: live.uuid, text: 'assistant body' })).rejects.toThrow(
      /changed after its content was sent/,
    )
    expect(changeItem).not.toHaveBeenCalled()
  })
})
