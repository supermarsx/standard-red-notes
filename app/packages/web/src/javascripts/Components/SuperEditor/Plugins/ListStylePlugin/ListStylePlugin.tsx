import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'

import { applyPersistedListStyles } from '../ToolbarPlugin/listStyle'

/**
 * Standard Red Notes: re-applies persisted list-marker styling to the DOM after
 * every editor render.
 *
 * Custom list markers (and the multilevel per-level map) are persisted on each
 * `ListNode`'s inline `__style`, which round-trips through `exportJSON` /
 * `importJSON`. But in this Lexical build the reconciler never copies an
 * ElementNode's `__style` onto the rendered `<ul>`/`<ol>`, so after a note is
 * loaded (or list DOM is rebuilt) the markers would not render. This plugin
 * walks the tree on each update and stamps the persisted `list-style-type` /
 * marker class back onto the live list elements, making the styling survive
 * note save → reload.
 *
 * The walk only touches list elements and is cheap; it short-circuits in the
 * common case where lists carry no custom style.
 */
export default function ListStylePlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    // Apply once immediately for the initial deserialized state, then on every
    // subsequent render (re-applying is idempotent).
    editor.getEditorState().read(() => {
      applyPersistedListStyles()
    })
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        applyPersistedListStyles()
      })
    })
  }, [editor])

  return null
}
