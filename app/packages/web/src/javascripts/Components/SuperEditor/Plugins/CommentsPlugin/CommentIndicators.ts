import { $getNodeByKey, $getRoot, $isElementNode, LexicalEditor, LexicalNode } from 'lexical'
import type { CommentAnchor } from '@/Comments/comments'
import { canUseCommentRange, isBoundCommentRange } from '@/Comments/CommentRangeAnchor'
import { $getChecklistTodoId, $isChecklistItemNode } from '../../Lexical/Nodes/ChecklistItemNode'
import { lexicalCommentBlockRanges } from './LexicalCommentTargets'

/** DOM-only adornments: never modify encrypted note text or the undo history. */
export function markCommentAnchors(editor: LexicalEditor, anchors: CommentAnchor[]): () => void {
  const marked = new Set<HTMLElement>()
  if (!anchors.length) {
    return () => {}
  }
  editor.getEditorState().read(() => {
    const root = $getRoot()
    const exactRanges: { start: number; end: number }[] = []
    let rootText: string | undefined
    const mark = (element: HTMLElement | null | undefined): void => {
      if (element && !marked.has(element)) {
        element.setAttribute('data-note-comment-indicator', 'true')
        marked.add(element)
      }
    }
    const tasks = new Map<string, LexicalNode>()
    const ambiguousTasks = new Set<string>()
    const stack = anchors.some((anchor) => anchor.kind === 'checklist') ? [...root.getChildren()] : []
    let remaining = 50_000
    while (stack.length && remaining-- > 0) {
      const node = stack.pop()!
      const todoId = $isChecklistItemNode(node) ? $getChecklistTodoId(node) : undefined
      if (todoId) {
        if (tasks.has(todoId)) {
          tasks.delete(todoId)
          ambiguousTasks.add(todoId)
        } else if (!ambiguousTasks.has(todoId)) {
          tasks.set(todoId, node)
        }
      }
      if ($isElementNode(node)) {
        stack.push(...node.getChildren())
      }
    }
    for (const anchor of anchors) {
      let node: LexicalNode | undefined | null
      if (anchor.kind === 'checklist') {
        node = tasks.get(anchor.todoId)
      } else if (anchor.kind === 'super') {
        if (anchor.exactRange) {
          if (!canUseCommentRange(anchor)) {
            continue
          }
          const range = anchor.exactRange
          rootText ??= root.getTextContent()
          if (rootText.slice(range.start, range.end) === range.text) {
            exactRanges.push({ start: range.start, end: range.end })
          }
          continue
        }
        if (isBoundCommentRange(anchor)) {
          continue
        }
        const snippet = anchor.snippet?.replace(/…$/, '')
        node = $getNodeByKey(anchor.blockKey)
        if (!node?.isAttached() || (snippet && !node.getTextContent().includes(snippet))) {
          const matches = snippet ? root.getChildren().filter((child) => child.getTextContent().includes(snippet)) : []
          node = matches.length === 1 ? matches[0] : undefined
        }
      }
      const element = node && editor.getElementByKey(node.getKey())
      mark(element)
    }
    if (exactRanges.length) {
      // Validate every quote against this editor state, then mark the union in
      // one ordered sweep. Many comments on the same section must not rescan
      // every block or rewrite the same DOM attribute once per comment.
      exactRanges.sort((left, right) => left.start - right.start || left.end - right.end)
      const merged: typeof exactRanges = []
      for (const range of exactRanges) {
        const previous = merged.at(-1)
        if (previous && range.start < previous.end) {
          previous.end = Math.max(previous.end, range.end)
        } else {
          merged.push(range)
        }
      }
      let blocks: ReturnType<typeof lexicalCommentBlockRanges>
      try {
        blocks = lexicalCommentBlockRanges()
      } catch {
        // Preserve ordinary anchors, but never guess unsupported projections.
        return
      }
      let rangeIndex = 0
      for (const block of blocks) {
        while (rangeIndex < merged.length && merged[rangeIndex].end <= block.start) {
          rangeIndex++
        }
        const range = merged[rangeIndex]
        if (!range) {
          break
        }
        if (block.start < range.end && block.end > range.start) {
          mark(editor.getElementByKey(block.key))
        }
      }
    }
  })
  return () => marked.forEach((element) => element.removeAttribute('data-note-comment-indicator'))
}
