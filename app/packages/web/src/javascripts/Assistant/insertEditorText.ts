// Insert transcript / dictation text into whichever note editor is focused, at the
// caret. Works for both note editors:
//
//  - Plain editor: a <textarea id="note-text-editor">. We focus it and use
//    document.execCommand('insertText', ...) which mirrors the plain editor's own Tab
//    handler (gives native undo + fires the textarea 'input'/onChange so the note
//    saves).
//  - Super editor: a Lexical contenteditable (#super-editor-content). Lexical listens
//    for the browser 'beforeinput'/'input' events, so execCommand('insertText') on the
//    focused contenteditable is applied and persisted by Lexical's own pipeline.
//
// Using execCommand keeps this editor-agnostic and avoids importing Lexical here.
//
// Standard Red Notes (t112): both of those ids are duplicated once per open note. From
// the second open tab onward the tiled editor mounts one NoteView per open note and
// merely hides the inactive ones, so `document.getElementById` answers "the note that
// happens to be first in the document". For a function that WRITES into a document that
// is the worst form of the bug: dictating with nothing focused typed the user's speech
// into a note they were not editing. Callers therefore say which note they mean — by
// uuid, or by handing over an element inside their own tile — and the lookups are
// scoped to that tile.

import { ElementIds } from '@/Constants/ElementIDs'
import { PRINT_NOTE_VIEW_ATTRIBUTE } from '@/Components/NoteView/Print/PrintNote'

/**
 * Which note's editor an insertion belongs to, when nothing is focused.
 *
 * Either form resolves to exactly one mounted NoteView. `within` exists for callers that
 * are themselves rendered inside the tile (a toolbar button holding its own ref) and so
 * know their tile without knowing its uuid.
 */
export type EditorInsertionScope = {
  /** Uuid of the note that should receive the text. */
  noteUuid?: string
  /** Any element inside the asking tile. */
  within?: Element | null
}

/** The one mounted NoteView `scope` names, or the whole document when it names none. */
function tileFor(scope?: EditorInsertionScope): ParentNode {
  if (scope?.noteUuid) {
    const byUuid = document.querySelector<HTMLElement>(`[${PRINT_NOTE_VIEW_ATTRIBUTE}="${scope.noteUuid}"]`)
    if (byUuid) {
      return byUuid
    }
  }
  const byElement = scope?.within?.closest<HTMLElement>(`[${PRINT_NOTE_VIEW_ATTRIBUTE}]`)
  if (byElement) {
    return byElement
  }
  // No scope, or a scope whose tile is not mounted: there is nothing better to answer
  // than the pre-tiling behaviour. With a single note open the two are the same.
  return document
}

/** The currently-focused editable element we should insert into, if any. */
function getFocusedEditable(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null
  if (!active) {
    return null
  }
  if (active.id === ElementIds.NoteTextEditor) {
    return active
  }
  if (active.isContentEditable) {
    return active
  }
  // Active element may be inside the Super editor content wrapper. Resolved by walking
  // UP from the focused element, so it is the wrapper of the tile the user is actually
  // in rather than the first wrapper in the document.
  const superContent = active.closest<HTMLElement>(`#${ElementIds.SuperEditorContent}`)
  if (superContent && superContent.isContentEditable) {
    return superContent
  }
  return null
}

/**
 * Try to focus a note editor (plain textarea first, then Super contenteditable) and
 * return it. Returns null when neither is mounted in the scoped tile.
 */
function focusAnEditor(scope?: EditorInsertionScope): HTMLElement | null {
  const tile = tileFor(scope)
  const textarea = tile.querySelector<HTMLElement>(`#${ElementIds.NoteTextEditor}`)
  if (textarea) {
    textarea.focus()
    return textarea
  }
  const superContent = tile.querySelector<HTMLElement>(`#${ElementIds.SuperEditorContent}`)
  if (superContent && superContent.isContentEditable) {
    superContent.focus()
    return superContent
  }
  return null
}

/**
 * Insert `text` at the caret of the active note editor. If no editor is focused, focus
 * the one belonging to `scope` first. Returns true when the insertion target was found.
 * Falls back to a manual textarea splice if execCommand reports failure (some Firefox
 * versions).
 *
 * `scope` is REQUIRED, deliberately: it is the only thing standing between "insert into
 * the note I mean" and "insert into whichever note happens to be first in the document",
 * and a caller that quietly stops passing it would reintroduce exactly the bug this
 * parameter exists to fix. Spelling `{}` is still possible, but only on purpose.
 */
export function insertTextIntoActiveEditor(text: string, scope: EditorInsertionScope): boolean {
  if (!text) {
    return false
  }
  let target = getFocusedEditable()
  if (!target) {
    target = focusAnEditor(scope)
  }
  if (!target) {
    return false
  }

  const inserted = document.execCommand('insertText', false, text)
  if (inserted) {
    return true
  }

  // Manual fallback for a <textarea> when execCommand is unsupported.
  if (target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    target.value = target.value.slice(0, start) + text + target.value.slice(end)
    target.selectionStart = target.selectionEnd = start + text.length
    // Dispatch input so React's onChange (which persists the note) runs.
    target.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  return false
}
