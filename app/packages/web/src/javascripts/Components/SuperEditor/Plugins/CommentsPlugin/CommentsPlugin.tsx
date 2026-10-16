import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_EDITOR, createCommand } from 'lexical'
import { useEffect } from 'react'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { useApplicationOrNull } from '@/Components/ApplicationProvider'
import { readPrivateNoteComments } from '@/Comments/PrivateNoteComments'
import { readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import { COMMENT_INDICATORS_PREF_KEY, showCommentIndicators } from '@/Comments/CommentPreferences'
import { markCommentAnchors } from './CommentIndicators'
import type { CommentAnchor, SuperCommentAnchor } from '@/Comments/comments'
import { $isListItemNode } from '@lexical/list'
import {
  $ensureChecklistTodoId,
  $getChecklistTodoId,
  $isChecklistItemNode,
} from '../../Lexical/Nodes/ChecklistItemNode'

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
 * Anchored comments receive DOM-only markers. Stored anchors remain unchanged;
 * after a reload a unique snippet can locate a block whose session key changed.
 */
export const CAPTURE_COMMENT_ANCHOR_COMMAND = createCommand<(anchor: CommentAnchor | null) => void>(
  'CAPTURE_COMMENT_ANCHOR_COMMAND',
)

const SNIPPET_MAX = 80

export function CommentsPlugin({ note }: { note?: SNNote }): null {
  const [editor] = useLexicalComposerContext()
  const application = useApplicationOrNull()
  const noteUuid = note?.uuid

  useEffect(() => {
    if (!application || !noteUuid) {
      return
    }
    let clearMarkers = () => {}
    let previousRoot: HTMLElement | null = null
    let anchors: CommentAnchor[] = []
    const refresh = () => {
      clearMarkers()
      const root = editor.getRootElement()
      if (previousRoot !== root) {
        previousRoot?.removeAttribute('data-comment-indicators')
      }
      previousRoot = root
      if (!root) {
        return
      }
      const visible = showCommentIndicators(application.getPreference(COMMENT_INDICATORS_PREF_KEY))
      root.setAttribute('data-comment-indicators', visible ? 'shown' : 'hidden')
      if (!visible) {
        return
      }
      const current = application.items.findItem<SNNote>(noteUuid)
      if (!current || !application.isAuthorizedToRenderItem(current)) {
        return
      }
      clearMarkers = markCommentAnchors(editor, anchors)
    }
    const readComments = () => {
      const current = application.items.findItem<SNNote>(noteUuid)
      if (!current || !application.isAuthorizedToRenderItem(current)) {
        anchors = []
        refresh()
        return
      }
      const comments = [
        ...readPrivateNoteComments(application, noteUuid),
        ...readDisplayNoteComments(application, current).comments.filter(
          (comment) => comment.authorshipStatus === 'verified',
        ),
      ]
      anchors = comments
        .filter((comment) => !comment.resolved)
        .flatMap((comment) => (comment.anchor ? [comment.anchor] : []))
      refresh()
    }
    readComments()
    const stopRoot = editor.registerRootListener(refresh)
    const stopEditor = editor.registerUpdateListener(refresh)
    const stopItems = application.items.streamItems(
      [ContentType.TYPES.Note, ContentType.TYPES.UserPrefs, ContentType.TYPES.TrustedContact],
      readComments,
    )
    const stopPrefs = application.addEventObserver(async () => readComments(), ApplicationEvent.PreferencesChanged)
    return () => {
      stopRoot()
      stopEditor()
      stopItems()
      stopPrefs()
      clearMarkers()
      previousRoot?.removeAttribute('data-comment-indicators')
    }
  }, [application, editor, noteUuid])

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
          let current = anchorNode
          while (current.getParent()) {
            if ($isListItemNode(current) && $isChecklistItemNode(current)) {
              const todoId =
                $getChecklistTodoId(current) ?? (editor.isEditable() ? $ensureChecklistTodoId(current) : undefined)
              if (todoId) {
                report({
                  kind: 'checklist',
                  todoId,
                  snippet: current.getTextContent().trim().slice(0, SNIPPET_MAX) || undefined,
                })
                return true
              }
            }
            current = current.getParent()!
          }
          const block = anchorNode.getTopLevelElementOrThrow()
          const text = (selection.isCollapsed() ? block.getTextContent() : selection.getTextContent()).trim()
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
