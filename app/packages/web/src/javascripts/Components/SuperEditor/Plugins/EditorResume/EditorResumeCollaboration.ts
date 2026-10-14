import { $getAnchorAndFocusForUserState, type Provider, type SyncCursorPositionsFn } from '@lexical/yjs'
import type { LexicalEditor, RangeSelection } from 'lexical'
import * as Y from 'yjs'

type Binding = Parameters<SyncCursorPositionsFn>[0]
const bindings = new WeakMap<LexicalEditor, { binding?: Binding; provider: Provider }>()

export type RelativeResumeSelection = { anchor: string; focus: string }

export function trackEditorResumeCollaboration(binding: Binding, provider: Provider): void {
  bindings.set(binding.editor, { binding, provider })
}

export function trackEditorResumeProvider(editor: LexicalEditor, provider: Provider): void {
  bindings.set(editor, { provider })
}

export function clearEditorResumeCollaboration(editor: LexicalEditor): void {
  bindings.delete(editor)
}

function encode(position: Y.RelativePosition): string {
  return btoa(String.fromCharCode(...Y.encodeRelativePosition(position)))
}

function decode(position: string): Y.RelativePosition {
  if (position.length > 2048) {
    throw new Error('Oversized resume position')
  }
  return Y.decodeRelativePosition(Uint8Array.from(atob(position), (character) => character.charCodeAt(0)))
}

/** Called inside an editor read/update. Only keep presence matching this selection. */
export function readRelativeResumeSelection(
  editor: LexicalEditor,
  selection: RangeSelection,
): RelativeResumeSelection | undefined {
  const context = bindings.get(editor)
  const local = context?.provider.awareness.getLocalState()
  if (!context || !local?.anchorPos || !local.focusPos) {
    return
  }
  try {
    // The first bootstrap may not call Lexical's remote cursor callback. Its
    // own awareness still supplies committed relative positions after our RAF.
    if (!context.binding) {
      return { anchor: encode(local.anchorPos), focus: encode(local.focusPos) }
    }
    const points = $getAnchorAndFocusForUserState(context.binding, local)
    if (
      points.anchorKey === selection.anchor.key &&
      points.anchorOffset === selection.anchor.offset &&
      points.focusKey === selection.focus.key &&
      points.focusOffset === selection.focus.offset
    ) {
      return { anchor: encode(local.anchorPos), focus: encode(local.focusPos) }
    }
  } catch {
    // A freshly bootstrapped room may not have a usable binding yet.
  }
}

/** Relative endpoints follow peer insertions; a new room can fall back to numeric paths. */
export function resolveRelativeResumeSelection(editor: LexicalEditor, saved: RelativeResumeSelection) {
  const context = bindings.get(editor)
  if (!context?.binding) {
    return
  }
  try {
    const points = $getAnchorAndFocusForUserState(context.binding, {
      anchorPos: decode(saved.anchor),
      focusPos: decode(saved.focus),
      name: '',
      color: '',
      focusing: false,
      awarenessData: {},
    })
    return points.anchorKey && points.focusKey ? points : undefined
  } catch {
    return
  }
}
