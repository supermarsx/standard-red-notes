import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import {
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
} from 'lexical'
import { useEffect } from 'react'
import { $createFootnoteReferenceNode, FootnoteReferenceNode } from '../../Lexical/Nodes/FootnoteReferenceNode'
import {
  $createFootnotesNode,
  $isFootnotesNode,
  FootnotesNode,
} from '../../Lexical/Nodes/FootnotesNode'
import { $getOrderedFootnoteReferences, footnoteEntryDomId } from '../../Lexical/Nodes/FootnoteShared'

export const INSERT_FOOTNOTE_COMMAND: LexicalCommand<void> = createCommand('INSERT_FOOTNOTE_COMMAND')

/**
 * Owns the footnotes lifecycle:
 *  - inserting a reference at the cursor and creating its paired entry
 *  - keeping a single FootnotesNode at the end of the document
 *  - de-duplicating reference ids that collide after a copy/paste
 *  - pruning orphan entries when references are deleted
 *  - removing the section entirely when no references remain
 *
 * Numbering itself is NOT maintained here: it is derived on render from the
 * document order of references (see FootnoteShared).
 */
export default function FootnotePlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    if (!editor.hasNodes([FootnoteReferenceNode, FootnotesNode])) {
      throw new Error('FootnotePlugin: FootnoteReferenceNode and FootnotesNode must be registered on the editor')
    }

    return mergeRegister(
      editor.registerCommand(
        INSERT_FOOTNOTE_COMMAND,
        () => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) {
            return false
          }
          const reference = $createFootnoteReferenceNode()
          $insertNodes([reference])
          const footnotesNode = $ensureFootnotesNode()
          footnotesNode.addEntry(reference.getFootnoteId())
          // Focus the new entry's textarea after the DOM has rendered.
          const footnoteId = reference.getFootnoteId()
          requestAnimationFrame(() => {
            const entry = editor
              .getRootElement()
              ?.ownerDocument.getElementById(footnoteEntryDomId(footnoteId))
            entry?.querySelector<HTMLElement>('[data-footnote-entry-input="true"]')?.focus()
          })
          return true
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      // Reconcile the footnotes section after every change to the document.
      // We first check (read-only) whether anything is out of sync, and only
      // open a write transaction when it is — otherwise the listener would
      // re-trigger itself in a loop on every keystroke.
      editor.registerUpdateListener(({ editorState }) => {
        const needsReconcile = editorState.read(() => $footnotesNeedReconcile())
        if (needsReconcile) {
          editor.update(() => {
            $reconcileFootnotes()
          })
        }
      }),
    )
  }, [editor])

  return null
}

/**
 * Read-only predicate: returns true when the footnotes section is out of sync
 * with the live references and a write reconcile is warranted. Mirrors exactly
 * the mutations $reconcileFootnotes would perform so we never open an empty
 * (loop-causing) write transaction.
 */
function $footnotesNeedReconcile(): boolean {
  const references = $getOrderedFootnoteReferences()
  const ids: string[] = []
  const seen = new Set<string>()
  let hasDuplicate = false
  for (const reference of references) {
    const id = reference.getFootnoteId()
    if (seen.has(id)) {
      hasDuplicate = true
    }
    seen.add(id)
    ids.push(id)
  }
  if (hasDuplicate) {
    return true
  }

  const liveIds = new Set(ids)
  const footnotesNode = $findFootnotesNode()

  if (liveIds.size === 0) {
    // Section should not exist.
    return footnotesNode != null
  }

  if (footnotesNode == null) {
    // References exist but there is no section yet.
    return true
  }

  // Missing entries?
  for (const id of liveIds) {
    if (!footnotesNode.hasEntry(id)) {
      return true
    }
  }
  // Orphan entries?
  for (const entry of footnotesNode.getEntries()) {
    if (!liveIds.has(entry.footnoteId)) {
      return true
    }
  }
  // Section not last child?
  if ($getRoot().getLastChild() !== footnotesNode) {
    return true
  }
  return false
}

function $findFootnotesNode(): FootnotesNode | null {
  for (const child of $getRoot().getChildren()) {
    if ($isFootnotesNode(child)) {
      return child
    }
  }
  return null
}

/** Get the existing FootnotesNode or append a new empty one at the end. */
function $ensureFootnotesNode(): FootnotesNode {
  const existing = $findFootnotesNode()
  if (existing) {
    return existing
  }
  const node = $createFootnotesNode()
  $getRoot().append(node)
  return node
}

/**
 * Keep the document tree and the footnotes section consistent. Idempotent: safe
 * to run on every update.
 */
function $reconcileFootnotes(): void {
  const references = $getOrderedFootnoteReferences()

  // De-duplicate ids: a paste can clone a reference (same footnoteId). The first
  // occurrence keeps its id; later duplicates get a fresh id so each marker
  // points at its own entry.
  const seen = new Set<string>()
  for (const reference of references) {
    const id = reference.getFootnoteId()
    if (seen.has(id)) {
      reference.setFootnoteId(cryptoFootnoteId())
    }
    seen.add(reference.getFootnoteId())
  }

  const liveIds = new Set(references.map((reference) => reference.getFootnoteId()))
  const footnotesNode = $findFootnotesNode()

  if (liveIds.size === 0) {
    // No references left: remove the whole section.
    footnotesNode?.remove()
    return
  }

  const node = footnotesNode ?? $ensureFootnotesNode()
  // Add a placeholder entry for any reference that lacks one (e.g. pasted refs).
  for (const id of liveIds) {
    if (!node.hasEntry(id)) {
      node.addEntry(id)
    }
  }
  // Drop entries whose reference is gone.
  node.pruneOrphans(liveIds)

  // Keep the section as the last child so it always reads as a trailing section.
  const root = $getRoot()
  if (root.getLastChild() !== node) {
    node.remove()
    root.append(node)
  }
}

let counter = 0
function cryptoFootnoteId(): string {
  counter += 1
  return `fn-${Date.now().toString(36)}-d${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
