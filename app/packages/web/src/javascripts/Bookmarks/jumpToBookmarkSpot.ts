import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '@/Components/SuperEditor/Constants'
import { bookmarkAnchorDomId } from '@/Components/SuperEditor/Lexical/Nodes/BookmarkAnchorNode'
import { PRINT_NOTE_VIEW_ATTRIBUTE } from '@/Components/NoteView/Print/PrintNote'
import { BookmarkAnchor, relocateBySnippet } from './bookmarks'

/** ~40 animation frames (<1s) for the note's editor to mount after the pane is shown. */
export const MAX_JUMP_ATTEMPTS = 40

/**
 * Scroll/caret a note's editor to a bookmarked spot, once that note's editor is mounted.
 *
 * Standard Red Notes (t112): this used to resolve `#super-editor-content` /
 * `#note-text-editor` with `document.getElementById`. Both ids are rendered once per open
 * note — from the second open tab onward the tiled editor mounts one NoteView per note and
 * merely hides the inactive ones — so going to a bookmark scrolled, and in the plaintext
 * case moved the caret and stole focus into, the FIRST open note instead of the bookmarked
 * one. Everything is therefore resolved inside the one tile showing `noteUuid`.
 *
 * Nothing is resolved document-wide as a fallback: "the bookmarked note's tile is not
 * mounted yet" and "some other note's tile is mounted" are indistinguishable to an id
 * lookup, and answering the second is exactly the bug. An absent tile simply means "not
 * yet" — the editor mounts asynchronously after the pane is presented — so it is retried
 * over a few frames and then abandoned quietly.
 *
 *  - `super`: find the inline anchor element by its stable DOM id and scroll it into view.
 *    If it can't be found (the note was edited to remove the anchor), fall back to the
 *    coarse scroll position and then give up without throwing.
 *  - `plain`: re-locate the offset via the stored snippet (offsets DRIFT on edit; the
 *    snippet mitigates), then set the textarea selection + scroll.
 */
export function jumpToBookmarkSpot(
  noteUuid: string,
  anchor: BookmarkAnchor,
  persistedNoteText: string,
  scheduleFrame: (callback: () => void) => void = (callback) => {
    requestAnimationFrame(callback)
  },
): void {
  let attempts = 0

  const tryJump = () => {
    attempts += 1

    const tile = document.querySelector<HTMLElement>(`[${PRINT_NOTE_VIEW_ATTRIBUTE}="${noteUuid}"]`)
    if (!tile) {
      if (attempts < MAX_JUMP_ATTEMPTS) {
        scheduleFrame(tryJump)
      }
      return
    }

    if (anchor.kind === 'super') {
      const element = tile.querySelector<HTMLElement>(`[id="${bookmarkAnchorDomId(anchor.bookmarkId)}"]`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      // Fall back to the coarse scroll position once we give up finding the anchor.
      if (attempts >= MAX_JUMP_ATTEMPTS) {
        if (anchor.scrollTop !== undefined) {
          const content = tile.querySelector<HTMLElement>(`#${SuperEditorContentId}`)
          if (content) {
            content.scrollTop = anchor.scrollTop
          }
        }
        return
      }
    } else {
      const textarea = tile.querySelector<HTMLTextAreaElement>(`#${ElementIds.NoteTextEditor}`)
      if (textarea) {
        const text = textarea.value ?? persistedNoteText
        const offset = relocateBySnippet(text, anchor.offset, anchor.snippet)
        textarea.focus()
        try {
          textarea.setSelectionRange(offset, offset)
        } catch {
          /* ignore selection errors on unusual inputs */
        }
        if (anchor.scrollTop !== undefined) {
          textarea.scrollTop = anchor.scrollTop
        }
        return
      }
      if (attempts >= MAX_JUMP_ATTEMPTS) {
        return
      }
    }

    scheduleFrame(tryJump)
  }

  scheduleFrame(tryJump)
}
