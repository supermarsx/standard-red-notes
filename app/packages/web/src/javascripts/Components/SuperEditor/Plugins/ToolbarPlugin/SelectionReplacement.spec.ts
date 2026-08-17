import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, $isListItemNode, ListItemNode, ListNode } from '@lexical/list'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isTextNode,
  $setSelection,
} from 'lexical'
import {
  $getChecklistDueAt,
  $getChecklistRecurrence,
  $getChecklistTodoId,
  $setChecklistSchedule,
  $setChecklistTodoId,
} from '../../Lexical/Nodes/ChecklistItemNode'
import { createChecklistRecurrence } from '../../Checklist/checklistRecurrence'
import { captureSelectionSnapshot, restoreAndReplaceSelection } from './SelectionReplacement'

const createEditor = () => createHeadlessEditor({ namespace: 'selection-replacement', nodes: [ListNode, ListItemNode] })

function selectTwoChecklistRows(editor: ReturnType<typeof createEditor>) {
  let keys!: { first: string; second: string; firstText: string; secondText: string }
  editor.update(
    () => {
      const firstText = $createTextNode('First task')
      const secondText = $createTextNode('Second task')
      const first = $createListItemNode(true).append(firstText)
      const second = $createListItemNode(false).append(secondText)
      $setChecklistTodoId(first, 'todo-first')
      $setChecklistTodoId(second, 'todo-second')
      const dueAt = '2026-08-20T09:00:00.000Z'
      $setChecklistSchedule(second, dueAt, createChecklistRecurrence('weekly', dueAt, 'UTC'))
      $getRoot().append($createListNode('check').append(first, second))
      const selection = $createRangeSelection()
      selection.anchor.set(firstText.getKey(), 0, 'text')
      selection.focus.set(secondText.getKey(), secondText.getTextContentSize(), 'text')
      $setSelection(selection)
      keys = {
        first: first.getKey(),
        second: second.getKey(),
        firstText: firstText.getKey(),
        secondText: secondText.getKey(),
      }
    },
    { discrete: true },
  )
  return keys
}

describe('AI selection replacement', () => {
  it('rewrites checklist rows in place without losing checkbox or scheduling identity', () => {
    const editor = createEditor()
    const keys = selectTwoChecklistRows(editor)
    const snapshot = captureSelectionSnapshot(editor)!

    expect(restoreAndReplaceSelection(editor, snapshot, 'Improved first\nImproved second')).toBe('replaced')

    editor.getEditorState().read(() => {
      const first = $getNodeByKey(keys.first)
      const second = $getNodeByKey(keys.second)
      expect($isListItemNode(first) && first.getTextContent()).toBe('Improved first')
      expect($isListItemNode(second) && second.getTextContent()).toBe('Improved second')
      expect($isListItemNode(first) && first.getChecked()).toBe(true)
      expect($isListItemNode(second) && second.getChecked()).toBe(false)
      expect($isListItemNode(first) && $getChecklistTodoId(first)).toBe('todo-first')
      expect($isListItemNode(second) && $getChecklistTodoId(second)).toBe('todo-second')
      expect($isListItemNode(second) && $getChecklistDueAt(second)).toBe('2026-08-20T09:00:00.000Z')
      expect($isListItemNode(second) && $getChecklistRecurrence(second)).toMatchObject({ frequency: 'weekly' })
    })
  })

  it('fails closed when the model changes checklist row cardinality', () => {
    const editor = createEditor()
    selectTwoChecklistRows(editor)
    const snapshot = captureSelectionSnapshot(editor)!
    expect(restoreAndReplaceSelection(editor, snapshot, 'Collapsed into one row')).toBe('checklist-shape-mismatch')
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('First task\n\nSecond task')
  })

  it('fails closed when realtime editing changes a captured row during the request', () => {
    const editor = createEditor()
    const keys = selectTwoChecklistRows(editor)
    const snapshot = captureSelectionSnapshot(editor)!
    editor.update(
      () => {
        const second = $getNodeByKey(keys.second)
        if ($isListItemNode(second)) {
          second.clear().append($createTextNode('Changed remotely'))
        }
      },
      { discrete: true },
    )
    expect(restoreAndReplaceSelection(editor, snapshot, 'Stale first\nStale second')).toBe('stale-selection')
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('Changed remotely')
  })

  it('fails closed when realtime editing changes checklist formatting without changing its text', () => {
    const editor = createEditor()
    const keys = selectTwoChecklistRows(editor)
    const snapshot = captureSelectionSnapshot(editor)!
    editor.update(
      () => {
        const firstText = $getNodeByKey(keys.firstText)
        if ($isTextNode(firstText)) {
          firstText.toggleFormat('bold')
        }
      },
      { discrete: true },
    )

    expect(restoreAndReplaceSelection(editor, snapshot, 'Stale first\nStale second')).toBe('stale-selection')
    editor.getEditorState().read(() => {
      const firstText = $getNodeByKey(keys.firstText)
      expect($isTextNode(firstText) && firstText.hasFormat('bold')).toBe(true)
      expect($getRoot().getTextContent()).toBe('First task\n\nSecond task')
    })
  })

  it('rejects partial selections spanning multiple checklist rows', () => {
    const editor = createEditor()
    const keys = selectTwoChecklistRows(editor)
    editor.update(
      () => {
        const selection = $createRangeSelection()
        selection.anchor.set(keys.firstText, 2, 'text')
        selection.focus.set(keys.secondText, 4, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    const snapshot = captureSelectionSnapshot(editor)!
    expect(snapshot.unsupportedStructuredSelection).toBe(true)
    expect(restoreAndReplaceSelection(editor, snapshot, 'Unsafe replacement')).toBe('unsupported-structured-selection')
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('First task\n\nSecond task')
  })

  it('rejects a repeated-text range after its source node shifts', () => {
    const editor = createEditor()
    let textKey = ''
    editor.update(
      () => {
        const text = $createTextNode('same same')
        textKey = text.getKey()
        $getRoot().append($createParagraphNode().append(text))
        const selection = $createRangeSelection()
        selection.anchor.set(textKey, 5, 'text')
        selection.focus.set(textKey, 9, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    const snapshot = captureSelectionSnapshot(editor)!
    editor.update(
      () => {
        const text = $getNodeByKey(textKey)
        if ($isTextNode(text)) {
          text.setTextContent('Xsame same')
        }
      },
      { discrete: true },
    )
    expect(restoreAndReplaceSelection(editor, snapshot, 'changed')).toBe('stale-selection')
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('Xsame same')
  })
})
