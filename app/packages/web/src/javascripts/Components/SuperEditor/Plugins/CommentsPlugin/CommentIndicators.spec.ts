/** @jest-environment jsdom */
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
