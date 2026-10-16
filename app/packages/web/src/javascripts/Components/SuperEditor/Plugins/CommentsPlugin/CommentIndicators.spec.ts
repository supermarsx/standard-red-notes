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
import { captureLexicalCommentTarget } from './LexicalCommentTargets'
import * as LexicalTargets from './LexicalCommentTargets'

it.each(['same', 'spread'] as const)('projects blocks once and bounds overlap work for %s-block comments', (mode) => {
  const view = setup()
  const originalProjection = LexicalTargets.lexicalCommentBlockRanges
  let intervalReads = 0
  let blockKey = ''
  const starts: number[] = []
  let offset = 0
  try {
    view.editor.update(
      () => {
        $getRoot().clear()
        for (let index = 0; index < 400; index++) {
          const block = $createParagraphNode().append($createTextNode(`Paragraph ${index}`))
          starts.push(offset)
          offset += `Paragraph ${index}`.length + 2
          if (index === 0) blockKey = block.getKey()
          $getRoot().append(block)
        }
      },
      { discrete: true },
    )
    const projection = jest.spyOn(LexicalTargets, 'lexicalCommentBlockRanges').mockImplementation(() =>
      originalProjection().map((block) => ({
        key: block.key,
        get start() {
          intervalReads++
          return block.start
        },
        get end() {
          intervalReads++
          return block.end
        },
      })),
    )
    const setAttribute = jest.spyOn(view.editor.getElementByKey(blockKey)!, 'setAttribute')
    markCommentAnchors(
      view.editor,
      Array.from({ length: 80 }, (_, index) => ({
        kind: 'super' as const,
        blockKey,
        target: 'selection' as const,
        exactRange: {
          start: starts[mode === 'same' ? 0 : index * 5],
          end: starts[mode === 'same' ? 0 : index * 5] + 9,
          text: 'Paragraph',
        },
      })),
    )
    expect(projection).toHaveBeenCalledTimes(1)
    expect(intervalReads).toBeLessThanOrEqual(400 * 4 + 80 * 2)
    expect(setAttribute.mock.calls.filter(([name]) => name === 'data-note-comment-indicator')).toHaveLength(1)
    expect(view.root.querySelectorAll('[data-note-comment-indicator]')).toHaveLength(mode === 'same' ? 1 : 80)
  } finally {
    view.close()
  }
})

it('marks the union of overlapping exact ranges and leaves a quote-mismatched block untouched', () => {
  const view = setup()
  const keys: string[] = []
  try {
    view.editor.update(
      () => {
        $getRoot().clear()
        for (const text of ['ab', 'cd', 'ef', 'gh']) {
          const block = $createParagraphNode().append($createTextNode(text))
          keys.push(block.getKey())
          $getRoot().append(block)
        }
      },
      { discrete: true },
    )
    const clear = markCommentAnchors(view.editor, [
      { kind: 'super', blockKey: 'old-key', exactRange: { start: 1, end: 5, text: 'b\n\nc' } },
      { kind: 'super', blockKey: 'old-key', exactRange: { start: 4, end: 10, text: 'cd\n\nef' } },
      { kind: 'super', blockKey: 'old-key', exactRange: { start: 12, end: 13, text: 'wrong' } },
    ])
    expect(keys.map((key) => view.editor.getElementByKey(key)?.dataset.noteCommentIndicator)).toEqual([
      'true',
      'true',
      'true',
      undefined,
    ])
    clear()
    expect(view.root.querySelector('[data-note-comment-indicator]')).toBeNull()
  } finally {
    view.close()
  }
})

it('does not mark an empty block merely because two valid ranges meet at its offset', () => {
  const view = setup()
  let emptyKey = ''
  try {
    view.editor.update(
      () => {
        const empty = $createParagraphNode()
        emptyKey = empty.getKey()
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('a')),
            empty,
            $createParagraphNode().append($createTextNode('b')),
          )
      },
      { discrete: true },
    )
    markCommentAnchors(view.editor, [
      { kind: 'super', blockKey: 'old', exactRange: { start: 0, end: 3, text: 'a\n\n' } },
      { kind: 'super', blockKey: 'old', exactRange: { start: 3, end: 6, text: '\n\nb' } },
    ])
    expect(view.editor.getElementByKey(emptyKey)?.dataset.noteCommentIndicator).toBeUndefined()
    expect(view.root.querySelectorAll('[data-note-comment-indicator]')).toHaveLength(2)
  } finally {
    view.close()
  }
})

it('refuses ambiguous checklist anchors just as target capture does', () => {
  const view = setup()
  try {
    view.editor.update(
      () => {
        const duplicate = $createListItemNode(false).append($createTextNode('Different duplicated task'))
        $setChecklistTodoId(duplicate, 'todo-one')
        $getRoot().append($createListNode('check').append(duplicate))
      },
      { discrete: true },
    )
    expect(() => captureLexicalCommentTarget(view.editor, 'checklist', 'todo-one')).toThrow('ambiguous')
    markCommentAnchors(view.editor, [{ kind: 'checklist', todoId: 'todo-one' }])
    expect(view.root.querySelector('[data-note-comment-indicator]')).toBeNull()
  } finally {
    view.close()
  }
})

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
