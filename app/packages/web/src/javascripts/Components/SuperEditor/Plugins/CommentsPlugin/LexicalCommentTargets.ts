import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { $isHeadingNode } from '@lexical/rich-text'
import { $getChecklistTodoId, $isChecklistItemNode } from '../../Lexical/Nodes/ChecklistItemNode'
import type { CommentTarget, CapturedCommentTarget } from '@/Comments/CommentTargets'
import { MAX_COMMENT_TEXT_LENGTH, type CommentAnchor } from '@/Comments/comments'

/** Reproduce ElementNode's block separators and reject custom text projections. */
function textStarts(): Map<string, number> {
  const starts = new Map<string, number>()
  let remaining = 50_000
  const visit = (node: LexicalNode, start: number, depth: number): void => {
    if (remaining-- <= 0 || depth > 128) {
      throw new Error('This note is too complex for an exact comment target.')
    }
    starts.set(node.getKey(), start)
    if (!$isElementNode(node)) {
      return
    }
    const beforeChildren = starts.size
    let position = start
    let projected = ''
    const children = node.getChildren()
    children.forEach((child, index) => {
      visit(child, position, depth + 1)
      const text = child.getTextContent()
      projected += text
      position += text.length
      if ($isElementNode(child) && !child.isInline() && index !== children.length - 1) {
        projected += '\n\n'
        position += 2
      }
    })
    if (projected !== node.getTextContent()) {
      // Preserve an embed's exact span but never guess text points inside a
      // custom projection. Ordinary blocks around it remain anchorable.
      for (const key of [...starts.keys()].slice(beforeChildren)) {
        starts.delete(key)
      }
    }
  }
  visit($getRoot(), 0, 0)
  return starts
}

function prefixLength(key: string, offset: number, type: 'text' | 'element'): number {
  const starts = textStarts()
  const node = $getNodeByKey(key)
  const start = starts.get(key)
  if (!node || start === undefined || !Number.isInteger(offset) || offset < 0) {
    throw new Error('The selected text is no longer available.')
  }
  if (type === 'text') {
    if ($isElementNode(node) || offset > node.getTextContent().length) {
      throw new Error('The selected text position changed.')
    }
    return start + offset
  }
  if (!$isElementNode(node) || offset > node.getChildrenSize()) {
    throw new Error('The selected section position changed.')
  }
  const child = node.getChildAtIndex(offset)
  return child ? starts.get(child.getKey())! : start + node.getTextContent().length
}

export function lexicalCommentBlockRanges(): { key: string; start: number; end: number }[] {
  const root = $getRoot()
  const starts = textStarts()
  return root.getChildren().map((node) => ({
    key: node.getKey(),
    start: starts.get(node.getKey())!,
    end: starts.get(node.getKey())! + node.getTextContent().length,
  }))
}

export function captureLexicalCommentTarget(
  editor: LexicalEditor,
  target: CommentTarget,
  todoId?: string,
): CapturedCommentTarget {
  const state = editor.getEditorState()
  const snapshot = JSON.stringify(state.toJSON())
  let anchor: CommentAnchor | undefined
  state.read(() => {
    const root = $getRoot()
    if (target === 'note') {
      return
    }
    if (target === 'checklist') {
      if (!todoId) {
        throw new Error('Choose an existing checklist item before adding a comment.')
      }
      const stack = [...root.getChildren()]
      let match: (typeof stack)[number] | undefined
      let remaining = 50_000
      while (stack.length && remaining--) {
        const node = stack.pop()!
        if ($isChecklistItemNode(node) && $getChecklistTodoId(node) === todoId) {
          if (match) {
            throw new Error('The checklist item identifier is ambiguous. Reopen the note before commenting.')
          }
          match = node
        }
        if ($isElementNode(node)) {
          stack.push(...node.getChildren())
        }
      }
      if (!match) {
        throw new Error('Checklist item not found in the live editor. Re-read its current item IDs.')
      }
      anchor = { kind: 'checklist', todoId, snippet: match.getTextContent().trim().slice(0, 80) || undefined }
      return
    }
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) {
      throw new Error('Select text in this note’s live editor before commenting.')
    }
    const first = selection.isBackward() ? selection.focus : selection.anchor
    const last = selection.isBackward() ? selection.anchor : selection.focus
    const source = root.getTextContent()
    let block = first.getNode().getTopLevelElementOrThrow()
    let start: number, end: number
    if (target === 'selection') {
      if (selection.isCollapsed()) {
        throw new Error('Select a nonempty text range before adding a selection comment.')
      }
      start = prefixLength(first.key, first.offset, first.type)
      end = prefixLength(last.key, last.offset, last.type)
    } else {
      const children = root.getChildren()
      let index = children.findIndex((node) => node.getKey() === block.getKey())
      while (index >= 0 && !$isHeadingNode(children[index])) {
        index--
      }
      if (index < 0) {
        throw new Error(
          'This selection has no heading section. Choose text under a heading or comment on the whole note.',
        )
      }
      block = children[index] as typeof block
      const level = Number(($isHeadingNode(block) ? block.getTag() : 'h1').slice(1))
      let next = index + 1
      while (next < children.length) {
        const node = children[next]
        if ($isHeadingNode(node) && Number(node.getTag().slice(1)) <= level) {
          break
        }
        next++
      }
      start = prefixLength(root.getKey(), index, 'element')
      end = prefixLength(root.getKey(), next, 'element')
    }
    const text = source.slice(start, end)
    if (!text.trim() || text.length > MAX_COMMENT_TEXT_LENGTH) {
      throw new Error(
        `This comment target must contain at most ${MAX_COMMENT_TEXT_LENGTH} characters. Select a smaller range.`,
      )
    }
    anchor = {
      kind: 'super',
      blockKey: block.getKey(),
      snippet: text.trim().slice(0, 80),
      target,
      exactRange: { start, end, text },
    }
  })
  return {
    anchor,
    assertCurrent(options) {
      if (!editor.getRootElement()) {
        throw new Error('The comment editor closed. Reopen the note and select its target again.')
      }
      if (target !== 'note' && JSON.stringify(editor.getEditorState().toJSON()) !== snapshot) {
        throw new Error('The note changed after the comment target was captured. Select it again before saving.')
      }
      if (options?.sharedMutation && !editor.isEditable()) {
        throw new Error(
          'Live collaboration is waiting for a socket saver. Retry the shared comment after editing resumes.',
        )
      }
    },
  }
}
