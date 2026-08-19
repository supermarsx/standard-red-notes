import { AssistantChangeRecord } from '@/Assistant/assistantChangeLedger'
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { NoteType, SNNote } from '@standardnotes/snjs'
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode } from 'lexical'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $setChecklistTodoId } from '../Lexical/Nodes/ChecklistItemNode'
import {
  assistantChangeScrollBehavior,
  jumpToAssistantChange,
  resolveAssistantChangeNodeKeys,
} from './AssistantChangeDecorationsPlugin'

const changeRecord = (operation: AssistantChangeRecord['operations'][number]): AssistantChangeRecord => ({
  changeId: 'change-1',
  noteUuid: 'note-1',
  source: { assistantMessageId: 'message-1', assistantRunId: 'run-1' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  baseRevision: { contentHash: 'before-hash' },
  newRevision: { contentHash: 'after-hash' },
  operations: [operation],
  operationIds: [operation.operationId],
  affectedTodoIds: operation.affected.flatMap((locator) => locator.todoId ?? []),
  affectedNodeUuids: operation.affected.flatMap((locator) => locator.nodeUuid ?? []),
  status: 'applied',
  undo: {
    noteUuid: 'note-1',
    noteTitle: 'Tracked note',
    before: { title: 'Tracked note', text: 'before', previewPlain: 'before', noteType: NoteType.Plain },
    after: { title: 'Tracked note', text: 'after', previewPlain: 'after', noteType: NoteType.Plain },
    patch: '-before\n+after',
    addedLines: 1,
    removedLines: 1,
    truncated: false,
  },
})

const recordForEditor = (
  editor: ReturnType<typeof createHeadlessEditor>,
  operation: AssistantChangeRecord['operations'][number],
): AssistantChangeRecord => {
  const record = changeRecord(operation)
  const text = JSON.stringify(editor.getEditorState().toJSON())
  return { ...record, undo: { ...record.undo, after: { ...record.undo.after, text } } }
}

const currentNoteFor = (record: AssistantChangeRecord, text = record.undo.after.text): SNNote =>
  ({
    uuid: record.noteUuid,
    title: record.undo.after.title,
    text,
    preview_plain: record.undo.after.previewPlain,
    preview_html: record.undo.after.previewHtml,
    noteType: record.undo.after.noteType,
    editorIdentifier: record.undo.after.editorIdentifier,
  }) as SNNote

describe('assistant editor change decorations', () => {
  it('resolves a changed block by its structural path and never decorates deleted content', () => {
    const editor = createHeadlessEditor({ namespace: 'assistant-change-path' })
    let paragraphKey = ''
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode('Changed'))
        paragraphKey = paragraph.getKey()
        $getRoot().append(paragraph)
      },
      { discrete: true },
    )

    const operation = {
      operationId: 'operation-1',
      type: 'replace-text' as const,
      summary: 'Changed one paragraph.',
      affected: [{ path: [0] }],
    }
    const record = recordForEditor(editor, operation)
    expect(resolveAssistantChangeNodeKeys(editor, record, currentNoteFor(record))).toEqual([paragraphKey])
    expect(
      resolveAssistantChangeNodeKeys(
        editor,
        recordForEditor(editor, { ...operation, deleted: true }),
        currentNoteFor(record),
      ),
    ).toEqual([])
  })

  it('disables path/key fallback after user edits and refuses a false jump', () => {
    const editor = createHeadlessEditor({ namespace: 'assistant-change-stale-path' })
    editor.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Assistant result'))), {
      discrete: true,
    })
    const record = recordForEditor(editor, {
      operationId: 'operation-stale',
      type: 'replace-text',
      summary: 'Changed one paragraph.',
      affected: [{ path: [0] }],
    })
    const note = currentNoteFor(record)

    editor.update(
      () => {
        const first = $getRoot().getFirstChild()
        if ($isElementNode(first)) {
          first.append($createTextNode(' plus a user edit'))
        }
      },
      { discrete: true },
    )

    expect(resolveAssistantChangeNodeKeys(editor, record, note)).toEqual([])
    expect(jumpToAssistantChange(editor, record, note)).toBe(false)
  })

  it('prefers a stable checklist id when the retained path is stale', () => {
    const editor = createHeadlessEditor({
      namespace: 'assistant-change-checklist',
      nodes: [ListNode, ListItemNode],
    })
    let itemKey = ''
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode('Changed task'))
        $setChecklistTodoId(item, 'todo-stable-change')
        itemKey = item.getKey()
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Earlier block')),
          $createListNode('check').append(item),
        )
      },
      { discrete: true },
    )

    expect(
      resolveAssistantChangeNodeKeys(
        editor,
        changeRecord({
          operationId: 'operation-2',
          type: 'toggle-checklist',
          summary: 'Checked one task.',
          affected: [{ path: [99], todoId: 'todo-stable-change' }],
        }),
      ),
    ).toEqual([itemKey])
  })

  it('keeps the visible marker accessible and disables motion for reduced-motion users', () => {
    const pluginSource = readFileSync(join(__dirname, 'AssistantChangeDecorationsPlugin.tsx'), 'utf8')
    const themeSource = readFileSync(join(__dirname, '../Lexical/Theme/editor.scss'), 'utf8')

    expect(pluginSource).toContain('role="status"')
    expect(pluginSource).toContain('aria-live="polite"')
    expect(pluginSource).toContain("element.dataset.assistantChangeMarker = 'AI changed'")
    expect(pluginSource).toContain('stopUpdates()')
    expect(themeSource).toContain('var(--sn-stylekit-info-color)')
    expect(themeSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(themeSource).toContain('animation: none')
  })

  it('uses non-animated scrolling when reduced motion is requested', () => {
    const originalMatchMedia = globalThis.matchMedia
    jest.useFakeTimers()
    try {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: jest.fn(() => ({ matches: true })),
      })
      expect(assistantChangeScrollBehavior()).toBe('auto')

      const editor = createHeadlessEditor({ namespace: 'assistant-change-reduced-motion' })
      editor.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Assistant result'))), {
        discrete: true,
      })
      const record = recordForEditor(editor, {
        operationId: 'operation-reduced-motion',
        type: 'replace-text',
        summary: 'Changed one paragraph.',
        affected: [{ path: [0] }],
      })
      const target = document.createElement('div')
      const scrollIntoView = jest.fn()
      Object.defineProperty(target, 'scrollIntoView', { configurable: true, value: scrollIntoView })
      jest.spyOn(editor, 'getElementByKey').mockReturnValue(target)
      jest.spyOn(editor, 'focus').mockImplementation(() => undefined)

      expect(jumpToAssistantChange(editor, record, currentNoteFor(record))).toBe(true)
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center', inline: 'nearest' })

      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: jest.fn(() => ({ matches: false })),
      })
      expect(assistantChangeScrollBehavior()).toBe('smooth')
    } finally {
      jest.runOnlyPendingTimers()
      jest.useRealTimers()
      Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: originalMatchMedia })
    }
  })
})
