import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
} from 'lexical'
import { useEffect } from 'react'
import {
  $createBookmarkAnchorNode,
  BookmarkAnchorNode,
  bookmarkAnchorDomId,
  createBookmarkAnchorId,
} from '../../Lexical/Nodes/BookmarkAnchorNode'

/**
 * Insert an inline bookmark anchor at the current selection.
 *
 * The payload carries the `bookmarkId` to stamp on the anchor so the caller can
 * pre-generate it, dispatch the command, and then persist a bookmark record (in
 * the note's appData) that references the SAME id — keeping the document anchor
 * and the stored bookmark in lockstep. When omitted, a fresh id is minted (and
 * surfaced via the DOM after render for callers that read it back).
 */
export type InsertBookmarkAnchorPayload = { bookmarkId?: string } | undefined

export const INSERT_BOOKMARK_ANCHOR_COMMAND: LexicalCommand<InsertBookmarkAnchorPayload> = createCommand(
  'INSERT_BOOKMARK_ANCHOR_COMMAND',
)

/**
 * DOM CustomEvent name used to drive an anchor insertion from OUTSIDE the Lexical
 * tree (e.g. the note-view Ctrl/Cmd+M handler, which has no editor instance). The
 * event's `detail.bookmarkId` is the pre-generated id to stamp on the anchor so
 * the caller can persist a matching bookmark record. Dispatch it on the editor
 * root element (or any ancestor that contains it).
 */
export const BOOKMARK_INSERT_DOM_EVENT = 'srn:insert-bookmark-anchor'

/**
 * Standard Red Notes: owns inserting inline bookmark anchors into a Super note.
 * Mirrors DateTimePlugin/FootnotePlugin: registers a single insert command that
 * drops a {@link BookmarkAnchorNode} at the cursor. The anchor is part of the
 * document, so it moves with edits (robust position capture).
 */
export default function BookmarkPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    if (!editor.hasNodes([BookmarkAnchorNode])) {
      throw new Error('BookmarkPlugin: BookmarkAnchorNode must be registered on the editor')
    }

    // Bridge an external DOM CustomEvent (from the note-view shortcut/menu, which
    // has no editor instance) into the Lexical insert command.
    const rootElement = editor.getRootElement()
    const onDomInsert = (event: Event) => {
      const detail = (event as CustomEvent<{ bookmarkId?: string }>).detail
      editor.dispatchCommand(INSERT_BOOKMARK_ANCHOR_COMMAND, { bookmarkId: detail?.bookmarkId })
    }
    rootElement?.addEventListener(BOOKMARK_INSERT_DOM_EVENT, onDomInsert)

    return mergeRegister(
      editor.registerCommand(
        INSERT_BOOKMARK_ANCHOR_COMMAND,
        (payload) => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) {
            return false
          }
          const bookmarkId = payload?.bookmarkId ?? createBookmarkAnchorId()
          const anchor = $createBookmarkAnchorNode(bookmarkId)
          $insertNodes([anchor])
          // Reveal the freshly inserted anchor after it renders.
          requestAnimationFrame(() => {
            editor
              .getRootElement()
              ?.ownerDocument.getElementById(bookmarkAnchorDomId(bookmarkId))
              ?.scrollIntoView({ block: 'center' })
          })
          return true
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      () => rootElement?.removeEventListener(BOOKMARK_INSERT_DOM_EVENT, onDomInsert),
    )
  }, [editor])

  return null
}
