import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_EDITOR, createCommand } from 'lexical'
import { useEffect } from 'react'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { useApplicationOrNull } from '@/Components/ApplicationProvider'
import { readPrivateNoteComments } from '@/Comments/PrivateNoteComments'
import { readDisplayNoteComments } from '@/Comments/CommentAuthorship'
import { COMMENT_INDICATORS_PREF_KEY, showCommentIndicators } from '@/Comments/CommentPreferences'
import { markCommentAnchors } from './CommentIndicators'
import type { CommentAnchor } from '@/Comments/comments'
import { $isListItemNode } from '@lexical/list'
import { registerCommentTargetBridge } from '@/Comments/CommentTargets'
import { captureLexicalCommentTarget } from './LexicalCommentTargets'
import { $getChecklistTodoId, $isChecklistItemNode } from '../../Lexical/Nodes/ChecklistItemNode'

/**
 * Standard Red Notes: bridge between the Super (Lexical) editor and the comments
 * panel for INLINE comment anchoring.
 *
 * Capture reads committed selection offsets and an exact quote, a heading's
 * section, or an existing persistent task identity without editing the document.
 *
 * Anchored comments receive DOM-only markers. Stored anchors remain unchanged;
 * New range anchors fail closed when text moves; only legacy block anchors use
 * the older unique-snippet relocation behavior.
 */
export const CAPTURE_COMMENT_ANCHOR_COMMAND = createCommand<(anchor: CommentAnchor | null) => void>(
  'CAPTURE_COMMENT_ANCHOR_COMMAND',
)

export function CommentsPlugin({ note }: { note?: SNNote }): null {
  const [editor] = useLexicalComposerContext()
  const application = useApplicationOrNull()
  const noteUuid = note?.uuid

  useEffect(() => {
    if (!application || !noteUuid) {
      return
    }
    return registerCommentTargetBridge(application, noteUuid, {
      capture: (target, todoId) => captureLexicalCommentTarget(editor, target, todoId),
    })
  }, [application, editor, noteUuid])

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
    const stopEditor = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) {
        refresh()
      }
    })
    // The initial read above already covers this note. Avoid streaming every
    // note at registration, and ignore changes to unrelated note payloads.
    const stopItems = application.items.addObserver(
      [ContentType.TYPES.Note, ContentType.TYPES.UserPrefs, ContentType.TYPES.TrustedContact],
      ({ changed, inserted, removed }) => {
        if (
          [...changed, ...inserted, ...removed].some(
            (item) => item.uuid === noteUuid || item.content_type !== ContentType.TYPES.Note,
          )
        ) {
          readComments()
        }
      },
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
          const signature = [
            selection.anchor.key,
            selection.anchor.offset,
            selection.anchor.type,
            selection.focus.key,
            selection.focus.offset,
            selection.focus.type,
          ].join(':')
          let committedSelectionMatches = false
          editor.getEditorState().read(() => {
            const committed = $getSelection()
            committedSelectionMatches =
              $isRangeSelection(committed) &&
              [
                committed.anchor.key,
                committed.anchor.offset,
                committed.anchor.type,
                committed.focus.key,
                committed.focus.offset,
                committed.focus.type,
              ].join(':') === signature
          })
          if (!committedSelectionMatches) {
            report(null)
            return true
          }
          if (!selection.isCollapsed()) {
            report(captureLexicalCommentTarget(editor, 'selection').anchor ?? null)
            return true
          }
          const anchorNode = selection.anchor.getNode()
          let current = anchorNode
          while (current.getParent()) {
            if ($isListItemNode(current) && $isChecklistItemNode(current)) {
              const todoId = $getChecklistTodoId(current)
              if (todoId) {
                report({
                  kind: 'checklist',
                  todoId,
                  snippet: current.getTextContent().trim().slice(0, 80) || undefined,
                })
                return true
              }
            }
            current = current.getParent()!
          }
          report(captureLexicalCommentTarget(editor, 'section').anchor ?? null)
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
