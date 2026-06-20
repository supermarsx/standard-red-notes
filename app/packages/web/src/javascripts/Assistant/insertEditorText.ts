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

import { ElementIds } from '@/Constants/ElementIDs'

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
  // Active element may be inside the Super editor content wrapper.
  const superContent = document.getElementById(ElementIds.SuperEditorContent)
  if (superContent && superContent.contains(active) && superContent.isContentEditable) {
    return superContent
  }
  return null
}

/**
 * Try to focus a note editor (plain textarea first, then Super contenteditable) and
 * return it. Returns null when neither is mounted.
 */
function focusAnEditor(): HTMLElement | null {
  const textarea = document.getElementById(ElementIds.NoteTextEditor)
  if (textarea) {
    textarea.focus()
    return textarea
  }
  const superContent = document.getElementById(ElementIds.SuperEditorContent)
  if (superContent && (superContent as HTMLElement).isContentEditable) {
    ;(superContent as HTMLElement).focus()
    return superContent as HTMLElement
  }
  return null
}

/**
 * Insert `text` at the caret of the active note editor. If no editor is focused, focus
 * one first. Returns true when the insertion target was found. Falls back to a manual
 * textarea splice if execCommand reports failure (some Firefox versions).
 */
export function insertTextIntoActiveEditor(text: string): boolean {
  if (!text) {
    return false
  }
  let target = getFocusedEditable()
  if (!target) {
    target = focusAnEditor()
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
