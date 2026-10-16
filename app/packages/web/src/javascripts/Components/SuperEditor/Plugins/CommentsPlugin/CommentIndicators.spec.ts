/** @jest-environment jsdom */
import { bindCommentRange } from '@/Comments/CommentRangeAnchor'

jest.mock('@/Application/Crypto', () => ({
  WebCrypto: {
    sodiumCryptoGenericHash: (message: string) =>
      jest
        .requireActual<typeof import('node:crypto')>('node:crypto')
        .createHash('sha256')
        .update(message)
        .digest('hex'),
  },
}))

import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $setChecklistTodoId } from '../../Lexical/Nodes/ChecklistItemNode'
import { markCommentAnchors } from './CommentIndicators'

function setup() {
  const editor = createEditor({
    namespace: 'comments',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  const root = document.createElement('div')
  document.body.append(root)
  editor.setRootElement(root)
  let blockKey = ''
  let taskKey = ''
  editor.update(
    () => {
      const paragraph = $createParagraphNode().append($createTextNode('Paragraph with a comment'))
      const task = $createListItemNode(false).append($createTextNode('Do this task'))
      $setChecklistTodoId(task, 'todo-one')
      blockKey = paragraph.getKey()
      taskKey = task.getKey()
      $getRoot().append(paragraph, $createListNode('check').append(task))
    },
    { discrete: true },
  )
  return {
    editor,
    root,
    blockKey,
    taskKey,
    close: () => {
      editor.setRootElement(null)
      root.remove()
    },
  }
}

it('marks multiline blocks and checklist anchors without editing the document or undo state', () => {
  const view = setup()
  try {
    const before = JSON.stringify(view.editor.getEditorState().toJSON())
    const clear = markCommentAnchors(view.editor, [
      { kind: 'super', blockKey: view.blockKey, snippet: 'Paragraph' },
      { kind: 'checklist', todoId: 'todo-one' },
    ])
    expect(view.editor.getElementByKey(view.blockKey)?.dataset.noteCommentIndicator).toBe('true')
    expect(view.editor.getElementByKey(view.taskKey)?.dataset.noteCommentIndicator).toBe('true')
    expect(JSON.stringify(view.editor.getEditorState().toJSON())).toBe(before)
    clear()
    expect(view.root.querySelector('[data-note-comment-indicator]')).toBeNull()
    expect(view.root.textContent).toContain('Do this task')
  } finally {
    view.close()
  }
})

it('recovers an anchor after editor keys change only when the snippet is unambiguous', () => {
  const view = setup()
  try {
    const clear = markCommentAnchors(view.editor, [
      { kind: 'super', blockKey: 'old-session-key', snippet: 'Paragraph with a comment…' },
    ])
    expect(view.editor.getElementByKey(view.blockKey)?.dataset.noteCommentIndicator).toBe('true')
    clear()
    view.editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('Paragraph with a comment')))
      },
      { discrete: true },
    )
    markCommentAnchors(view.editor, [
      { kind: 'super', blockKey: 'old-session-key', snippet: 'Paragraph with a comment' },
    ])
    expect(view.root.querySelector('[data-note-comment-indicator]')).toBeNull()
  } finally {
    view.close()
  }
})

it('uses exact range offsets after key changes and refuses fuzzy relocation when quoted text moved', () => {
  const view = setup()
  try {
    const anchor = {
      kind: 'super' as const,
      blockKey: 'old-key',
      target: 'selection' as const,
      snippet: 'Paragraph',
      exactRange: { start: 0, end: 9, text: 'Paragraph' },
    }
    const before = JSON.stringify(view.editor.getEditorState().toJSON())
    const clear = markCommentAnchors(view.editor, [anchor])
    expect(view.editor.getElementByKey(view.blockKey)?.dataset.noteCommentIndicator).toBe('true')
    expect(JSON.stringify(view.editor.getEditorState().toJSON())).toBe(before)
    clear()
    view.editor.update(
      () => {
        $getRoot()
          .getFirstChild()!
          .insertBefore($createParagraphNode().append($createTextNode('Inserted earlier')))
      },
      { discrete: true },
    )
    markCommentAnchors(view.editor, [anchor])
    expect(view.root.querySelector('[data-note-comment-indicator]')).toBeNull()
  } finally {
    view.close()
  }
})
it('never uses a signed range with stripped or tampered precision as a fuzzy snippet anchor', () => {
  const view = setup()
  try {
    const anchor = bindCommentRange({
      kind: 'super',
      blockKey: view.blockKey,
      snippet: 'Paragraph',
      target: 'selection',
      exactRange: { start: 0, end: 9, text: 'Paragraph' },
    })
    const clear = markCommentAnchors(view.editor, [anchor])
    expect(view.root.querySelector('[data-note-comment-indicator]')).not.toBeNull()
    clear()
    markCommentAnchors(view.editor, [
      { kind: 'super', blockKey: anchor.blockKey, snippet: anchor.snippet },
      { ...anchor, target: 'section' },
      { ...anchor, exactRange: { start: 0, end: 4, text: 'Para' } },
    ])
    expect(view.root.querySelector('[data-note-comment-indicator]')).toBeNull()
  } finally {
    view.close()
  }
})
