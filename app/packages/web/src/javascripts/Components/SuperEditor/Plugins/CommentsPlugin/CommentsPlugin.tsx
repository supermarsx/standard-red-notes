import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_EDITOR, createCommand } from 'lexical'
import { useEffect } from 'react'
import type { SuperCommentAnchor } from '@/Comments/comments'

/**
 * Standard Red Notes: bridge between the Super (Lexical) editor and the comments
 * panel for INLINE comment anchoring.
 *
 * Dispatching CAPTURE_COMMENT_ANCHOR_COMMAND reads the current selection's
 * top-level block and reports a `super` anchor (the block's Lexical node key +
 * a short text snippet) back through the provided callback. The comments panel
 * can then attach that anchor to a new comment so it shows as an "inline" comment
 * with the quoted context.
 *
 * First-version scope: this captures + reports the anchor. The node key is stable
 * for the life of an editor session (it survives edits to other blocks) and the
 * snippet lets us re-find / display the anchored text. A richer follow-up would
 * also DECORATE the anchored block (a margin marker / highlight) and SCROLL to it
 * when a comment is clicked — both can be built on top of this same node key
 * without changing the stored data model.
 */
export const CAPTURE_COMMENT_ANCHOR_COMMAND = createCommand<(anchor: SuperCommentAnchor | null) => void>(
  'CAPTURE_COMMENT_ANCHOR_COMMAND',
)

const SNIPPET_MAX = 80

export function CommentsPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      CAPTURE_COMMENT_ANCHOR_COMMAND,
      (report) => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          report(null)
          return true
        }
        try {
          const anchorNode = selection.anchor.getNode()
          const block = anchorNode.getTopLevelElementOrThrow()
          const text = block.getTextContent().trim()
          const anchor: SuperCommentAnchor = { kind: 'super', blockKey: block.getKey() }
          if (text) {
            anchor.snippet = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text
          }
          report(anchor)
        } catch {
          report(null)
        }
        return true
      },
      COMMAND_PRIORITY_EDITOR,
    )
  }, [editor])

  return null
}
