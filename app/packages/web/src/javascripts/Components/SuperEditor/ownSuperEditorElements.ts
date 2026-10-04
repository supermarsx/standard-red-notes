import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from './Constants'

/**
 * Standard Red Notes (t112): `#super-editor` and `#super-editor-content` are NOT unique.
 * The tiled editor mounts one NoteView per open note (NoteGroupView keeps every open tab
 * mounted and merely hides the inactive ones), and each mounts its own Super editor, so
 * from the second open tab onward `document.getElementById` answers "the Super editor of
 * whichever note is first in the document".
 *
 * For a popover that is positioned relative to its container, or portalled into it, that
 * is worse than it sounds: the first tile may be the HIDDEN one (single-tile layout gives
 * every inactive tile the `hidden` class), so a link editor portalled there renders into
 * `display: none` and the user sees nothing at all.
 *
 * Anything rendered inside a Super editor already knows which editor it belongs to — its
 * own DOM position. These helpers walk UP from a node that is inside the editor, so the
 * answer is the asking tile's editor by construction and cannot be another note's.
 */

/** The `#super-editor` that contains `descendant`, if any. */
export function ownSuperEditorElement(descendant: Element | null | undefined): HTMLElement | null {
  return descendant?.closest<HTMLElement>(`#${ElementIds.SuperEditor}`) ?? null
}

/** The `#super-editor-content` (the Lexical contenteditable) that contains `descendant`. */
export function ownSuperEditorContentElement(descendant: Element | null | undefined): HTMLElement | null {
  return descendant?.closest<HTMLElement>(`#${SuperEditorContentId}`) ?? null
}

/**
 * Where a Super editor popover should be portalled: its own editor, or `document.body`.
 *
 * `document.body` — rather than "some mounted `#super-editor`" — is the fallback on
 * purpose. When the asking node's editor cannot be found, another note's editor is not an
 * approximation of it: it may be hidden (nothing renders) and it is positioned somewhere
 * else entirely. The body was already the last resort here; it is now the only one.
 */
export function superEditorPortalTarget(descendant: Element | null | undefined): HTMLElement {
  return ownSuperEditorElement(descendant) ?? document.body
}
