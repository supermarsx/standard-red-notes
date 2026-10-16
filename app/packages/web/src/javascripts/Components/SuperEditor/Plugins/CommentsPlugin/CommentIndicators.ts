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
    let exactBlocks: ReturnType<typeof lexicalCommentBlockRanges> | undefined
    let exactUnavailable = false
    const tasks = new Map<string, LexicalNode>()
    const stack = anchors.some((anchor) => anchor.kind === 'checklist') ? [...root.getChildren()] : []
    let remaining = 50_000
    while (stack.length && remaining-- > 0) {
      const node = stack.pop()!
      const todoId = $isChecklistItemNode(node) ? $getChecklistTodoId(node) : undefined
      if (todoId) {
        tasks.set(todoId, node)
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
          if (exactUnavailable || !canUseCommentRange(anchor)) {
            continue
          }
          const range = anchor.exactRange
          if (root.getTextContent().slice(range.start, range.end) === range.text) {
            try {
              exactBlocks ??= lexicalCommentBlockRanges()
            } catch {
              exactUnavailable = true
              continue
            }
            for (const block of exactBlocks) {
              if (block.start < range.end && block.end > range.start) {
                const element = editor.getElementByKey(block.key)
                if (element) {
                  element.setAttribute('data-note-comment-indicator', 'true')
                  marked.add(element)
                }
              }
            }
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
      if (element) {
        element.setAttribute('data-note-comment-indicator', 'true')
        marked.add(element)
      }
    }
  })
  return () => marked.forEach((element) => element.removeAttribute('data-note-comment-indicator'))
}
