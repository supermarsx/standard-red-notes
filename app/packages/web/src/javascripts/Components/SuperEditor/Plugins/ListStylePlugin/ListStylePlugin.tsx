import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'
import { $getNodeByKey } from 'lexical'
import { $isListNode, ListNode } from '@lexical/list'

import { applyListStyleToDOM, applyPersistedListStyles } from '../ToolbarPlugin/listStyle'

/**
 * Standard Red Notes: re-applies persisted list-marker styling to the DOM.
 *
 * Custom markers (and the multilevel per-level map) are persisted on each
 * `ListNode`'s inline `__style`, which round-trips through `exportJSON` /
 * `importJSON`. But in this Lexical build the reconciler never copies an
 * ElementNode's `__style` onto the rendered `<ul>`/`<ol>`, so after a fresh
 * render the markers must be stamped back on manually.
 *
 * IMPORTANT: this must NOT run on every editor update — an earlier version walked
 * the entire document tree on each keystroke, which froze large notes ("page is
 * slowing down" in Firefox). Instead we stamp once on mount (for the loaded
 * state) and then use a `ListNode` MUTATION listener so re-stamping happens only
 * when list nodes are actually created/updated. For each touched list we also
 * stamp its outermost list ancestor, so a multilevel parent's per-level markers
 * re-apply to nested lists too.
 */
export default function ListStylePlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    // One-time stamp of the initial deserialized state.
    editor.getEditorState().read(() => {
      applyPersistedListStyles()
    })

    return editor.registerMutationListener(ListNode, (mutations) => {
      editor.getEditorState().read(() => {
        const toStamp = new Set<ListNode>()
        for (const [key, type] of mutations) {
          if (type === 'destroyed') {
            continue
          }
          const node = $getNodeByKey(key)
          if (!$isListNode(node)) {
            continue
          }
          toStamp.add(node)
          // Also stamp the outermost list ancestor so multilevel per-level markers
          // re-apply to this (possibly nested) list.
          let top: ListNode = node
          let parent = top.getParent()
          while (parent !== null) {
            if ($isListNode(parent)) {
              top = parent
            }
            parent = parent.getParent()
          }
          toStamp.add(top)
        }
        for (const list of toStamp) {
          applyListStyleToDOM(list)
        }
      })
    })
  }, [editor])

  return null
}
