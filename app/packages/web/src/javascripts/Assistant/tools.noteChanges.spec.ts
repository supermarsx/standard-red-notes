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
import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { WebApplication } from '@/Application/WebApplication'
import { AssistantTools } from './tools'
import { applyAssistantNoteChange, AssistantNoteChange, captureAssistantNoteSnapshot } from './assistantNoteChanges'

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
  beforeAll(() => {
    if (!globalThis.TextEncoder) {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
    }
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
    }
  })

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

  it('patches one Super checklist node in place, preserves note identity/state, and produces an undoable audit', async () => {
    const superDocument = {
      root: {
        type: 'root',
        version: 1,
        children: [
          {
            type: 'heading',
            version: 1,
            tag: 'h2',
            children: [{ type: 'text', version: 1, text: 'Purchases & Setup', format: 1 }],
          },
          {
            type: 'list',
            version: 1,
            listType: 'check',
            children: [
              {
                type: 'listitem',
                version: 1,
                checked: false,
                $: { srnChecklistTodoId: 'todo-scanner', future: { opaque: true } },
                children: [{ type: 'text', version: 1, text: 'Configure scanner', format: 2 }],
              },
            ],
          },
          { type: 'future-embed', version: 9, uuid: 'embed-stable', opaque: { keep: true } },
        ],
      },
    }
    const originalText = JSON.stringify(superDocument)
    let live = makeNote('Office setup', originalText, {
      noteType: NoteType.Super,
      editorIdentifier: 'org.standardnotes.super-editor',
      references: [{ uuid: 'linked-note', content_type: ContentType.TYPES.Note }],
    })
    const assignedKeys: string[][] = []
    const changeItem = jest.fn(async (_note: SNNote, mutate: (mutator: NoteMutator) => void) => {
      const mutable: Record<string, unknown> = {
        title: live.title,
        text: live.text,
        preview_plain: live.preview_plain,
        preview_html: live.preview_html,
        noteType: live.noteType,
        editorIdentifier: live.editorIdentifier,
      }
      const touched = new Set<string>()
      const proxy = new Proxy(mutable, {
        set(target, property, value) {
          touched.add(String(property))
          return Reflect.set(target, property, value)
        },
      })
      mutate(proxy as unknown as NoteMutator)
      assignedKeys.push([...touched].sort())
      live = makeNote(String(mutable.title), String(mutable.text), {
        noteType: mutable.noteType as NoteType,
        editorIdentifier: mutable.editorIdentifier as string,
        preview_plain: mutable.preview_plain as string,
        preview_html: mutable.preview_html as string | undefined,
        references: [{ uuid: 'linked-note', content_type: ContentType.TYPES.Note }],
      })
      return live
    })
    const sync = jest.fn().mockResolvedValue(undefined)
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      items: {
        findItem: () => live,
        getItems: () => [live],
        getSortedTagsForItem: () => [{ uuid: 'tag-1', title: 'Hardware' }],
      },
      mutator: { changeItem, deleteItem: jest.fn(), insertItem: jest.fn() },
      sync: { sync },
    } as unknown as WebApplication
    const changes: AssistantNoteChange[] = []
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      expectedNoteSnapshots: new Map([[live.uuid, captureAssistantNoteSnapshot(live)]]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
      onNoteChange: (_callId, change) => changes.push(change),
    })

    const section = (await tools.call('notes.readBlocks', {
      uuid: live.uuid,
      view: 'section',
      section: { heading: { text: 'Purchases & Setup' } },
    })) as { revision: { contentHash: string; updatedAt?: string } }
    const result = await tools.call(
      'notes.patchBlocks',
      {
        uuid: live.uuid,
        base: section.revision,
        operations: [
          {
            type: 'insert',
            position: 'after',
            target: { todoId: 'todo-scanner' },
            block: { kind: 'markdown-fragment', markdown: '- [ ] Monitor **Philips E24E2**' },
          },
        ],
      },
      'patch-call',
    )

    expect(result).toMatchObject({ ok: true, status: 'applied', note: { uuid: 'note-1', title: 'Office setup' } })
    const updatedDocument = JSON.parse(live.text)
    expect(updatedDocument.root.children[1].children).toHaveLength(2)
    expect(updatedDocument.root.children[1].children[0]).toEqual(
      (superDocument.root.children[1] as { children: unknown[] }).children[0],
    )
    expect(updatedDocument.root.children[1].children[1]).toMatchObject({
      type: 'listitem',
      children: [
        { text: 'Monitor ', format: 0 },
        { text: 'Philips E24E2', format: 1 },
      ],
      $: { srnChecklistTodoId: expect.stringMatching(/^todo-/) },
    })
    expect(updatedDocument.root.children[2]).toEqual(superDocument.root.children[2])
    expect(live.uuid).toBe('note-1')
    expect(live.title).toBe('Office setup')
    expect(live.references).toEqual([{ uuid: 'linked-note', content_type: ContentType.TYPES.Note }])
    expect(assignedKeys[0]).toEqual(['preview_html', 'preview_plain', 'text'])
    expect((application.mutator as unknown as { insertItem: jest.Mock }).insertItem).not.toHaveBeenCalled()
    expect((application.mutator as unknown as { deleteItem: jest.Mock }).deleteItem).not.toHaveBeenCalled()
    expect(changes).toHaveLength(1)
    expect(changes[0].before.text).toBe(originalText)
    expect(changes[0].after.text).toBe(live.text)

    await expect(applyAssistantNoteChange(application, changes[0], 'undo')).resolves.toMatchObject({
      position: 'before',
    })
    expect(live.text).toBe(originalText)
  })

  it('returns a structured conflict instead of mutating when a Super note changed after its block read', async () => {
    const firstText = JSON.stringify({
      root: {
        type: 'root',
        version: 1,
        children: [{ type: 'heading', version: 1, tag: 'h2', children: [{ type: 'text', version: 1, text: 'A' }] }],
      },
    })
    let live = makeNote('Concurrent', firstText, {
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
      expectedNoteSnapshots: new Map([[live.uuid, captureAssistantNoteSnapshot(live)]]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })
    const read = (await tools.call('notes.readBlocks', { uuid: live.uuid, view: 'outline' })) as {
      revision: { contentHash: string; updatedAt?: string }
    }
    live = makeNote('Concurrent', firstText.replace('"A"', '"User edit"'), {
      noteType: NoteType.Super,
      editorIdentifier: 'org.standardnotes.super-editor',
    })

    await expect(
      tools.call('notes.patchBlocks', {
        uuid: live.uuid,
        base: read.revision,
        operations: [
          {
            type: 'insert',
            position: 'inside-section',
            target: { heading: { text: 'A' } },
            block: { kind: 'paragraph', text: 'Assistant edit' },
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, status: 'conflict', rebase: { outline: expect.any(Array) } })
    expect(changeItem).not.toHaveBeenCalled()
  })

  it('requires an explicit fullReplacement acknowledgement for a whole Super-note rewrite', async () => {
    const live = makeNote(
      'Structured',
      JSON.stringify({
        root: { type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [] }] },
      }),
      { noteType: NoteType.Super, editorIdentifier: 'org.standardnotes.super-editor' },
    )
    const application = {
      sessions: { isCurrentSessionReadOnly: () => false },
      isAuthorizedToRenderItem: () => true,
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      items: { findItem: () => live, getItems: () => [live] },
      mutator: { changeItem: jest.fn() },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      selectedNoteUuids: new Set([live.uuid]),
      confirmBeforeWrite: false,
      requestConfirmation: async () => true,
      presentPane: () => undefined,
    })

    await expect(tools.call('notes.updateSuper', { uuid: live.uuid, markdown: 'Replacement' })).rejects.toThrow(
      /fullReplacement:true/,
    )
  })
})
