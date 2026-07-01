import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import { $isListItemNode, $isListNode, ListItemNode } from '@lexical/list'
import { $isHeadingNode, HeadingNode } from '@lexical/rich-text'
import { $getNodeByKey, $getRoot, LexicalNode, setDOMUnmanaged } from 'lexical'
import { useEffect } from 'react'

import { computeHiddenBlockKeys, computeHiddenListItemKeys, FoldBlock, FoldListItem } from './foldRange'

/**
 * Folding / collapsing for the Super editor.
 *
 * Two kinds of folds are supported:
 *   - Heading folds: collapsing a heading hides every following top-level block
 *     until the next heading of the same-or-higher level (or end of document).
 *   - List-item folds: collapsing a list item that contains a nested list hides
 *     that nested list.
 *
 * Folding is purely visual — nodes are never removed from the model. We track
 * collapsed node keys in a per-editor Set (session-local) and, on every editor
 * update, recompute the set of node keys whose DOM must be hidden and toggle a
 * CSS class (`Lexical__folded`) on those elements via `getElementByKey`.
 *
 * PERSISTENCE: collapsed state is SESSION-LOCAL. It is not serialized into the
 * note content (that would require subclassing the 3rd-party HeadingNode /
 * ListItemNode, which other plugins rely on via `$isHeadingNode` /
 * `$isListItemNode`). Folds therefore reset when the note is reloaded. The
 * document content is always fully preserved.
 */

const FOLDED_CLASS = 'Lexical__folded'
const COLLAPSED_CLASS = 'Lexical__foldCollapsed'
const FOLDABLE_CLASS = 'Lexical__foldable'
const TOGGLE_CLASS = 'Lexical__foldToggle'
const TOGGLE_ATTR = 'data-fold-toggle'
const KEY_ATTR = 'data-fold-key'

/**
 * Build the fold-toggle button element, marked Lexical-UNMANAGED.
 *
 * Exported so the regression test can assert the unmanaged flag is present
 * WITHOUT a full editor mount. The unmanaged flag is the load-bearing part of
 * the no-hang fix (see `ensureToggle`): the toggle is injected into a
 * Lexical-owned `<li>`/heading, so Lexical's DOM MutationObserver would
 * otherwise `removeChild` it and revert the selection, scheduling an update that
 * re-inserts it — an unbounded insert/observe/remove/update loop that froze the
 * app the instant a list item became foldable (e.g. Tab-nesting a list item).
 */
export function createFoldToggle(): HTMLElement {
  const toggle = document.createElement('span')
  toggle.setAttribute(TOGGLE_ATTR, 'true')
  toggle.setAttribute('contenteditable', 'false')
  toggle.setAttribute('role', 'button')
  toggle.setAttribute('aria-label', 'Toggle fold')
  toggle.className = TOGGLE_CLASS
  // CRITICAL (no-hang fix): mark this externally-injected span as
  // Lexical-UNMANAGED before it is inserted so Lexical's MutationObserver skips
  // it instead of removing it and reverting selection (which re-triggers the
  // update listener -> infinite re-insert loop). Headless Lexical has no
  // MutationObserver, so the loop is invisible to jest — only a real browser
  // (the super-tab-no-hang e2e) reproduces it.
  setDOMUnmanaged(toggle)
  return toggle
}

/** Heading tag (h1..h6) -> numeric level. */
function headingLevel(node: HeadingNode): number {
  return parseInt(node.getTag().slice(1), 10)
}

/** Read the ordered top-level blocks as plain FoldBlocks (no DOM/Lexical leak). */
function $readBlocks(): FoldBlock[] {
  return $getRoot()
    .getChildren()
    .map((child) => ({
      key: child.getKey(),
      headingLevel: $isHeadingNode(child) ? headingLevel(child) : null,
    }))
}

/** Collect the nested-subtree keys of a single list item (the keys to hide). */
function collectNestedKeys(item: ListItemNode): string[] {
  const nestedList = item.getChildren().find($isListNode)
  if (!nestedList) {
    return []
  }
  const keys: string[] = [nestedList.getKey()]
  const walk = (node: LexicalNode) => {
    keys.push(node.getKey())
    if ($isListItemNode(node) || $isListNode(node)) {
      for (const child of node.getChildren()) {
        walk(child)
      }
    }
  }
  for (const child of nestedList.getChildren()) {
    walk(child)
  }
  return keys
}

/** Read every foldable list item (one that contains a nested list) as FoldListItems. */
function $readFoldableListItems(): FoldListItem[] {
  const items: FoldListItem[] = []
  const walk = (node: LexicalNode) => {
    if ($isListItemNode(node)) {
      const childKeys = collectNestedKeys(node)
      if (childKeys.length > 0) {
        items.push({ key: node.getKey(), childKeys })
      }
    }
    if ($isListItemNode(node) || $isListNode(node)) {
      for (const child of node.getChildren()) {
        walk(child)
      }
    }
  }
  for (const child of $getRoot().getChildren()) {
    walk(child)
  }
  return items
}

export default function FoldablePlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    // Session-local collapsed-key sets, scoped to this editor instance.
    const collapsedHeadings = new Set<string>()
    const collapsedItems = new Set<string>()

    /** Inject (or remove) the click-target toggle button for a foldable element. */
    const ensureToggle = (el: HTMLElement, key: string, foldable: boolean) => {
      const existing = el.querySelector<HTMLElement>(`:scope > [${TOGGLE_ATTR}]`)
      if (!foldable) {
        existing?.remove()
        el.removeAttribute(KEY_ATTR)
        return
      }
      el.setAttribute(KEY_ATTR, key)
      if (existing) {
        return
      }
      // `createFoldToggle` marks the span Lexical-UNMANAGED — see its doc and the
      // module-level note: without it, inserting into the Lexical-owned `<li>`
      // triggers the MutationObserver to remove the span + revert selection,
      // re-firing this update listener in an unbounded re-insert loop (the freeze).
      const toggle = createFoldToggle()
      // APPEND the toggle (rather than inserting it as the first child). The
      // toggle is absolutely positioned in the left gutter via CSS
      // (`.Lexical__foldToggle`), so its position in the DOM child order does not
      // affect its rendered location. But being the element's FIRST inline child
      // meant clicking column 0 of a foldable heading (or pressing Home) could
      // seat the caret on/around this non-editable span. Appending it keeps the
      // caret at the real text start unaffected while preserving the click target.
      el.appendChild(toggle)
    }

    /**
     * Recompute which DOM elements should be hidden / marked-foldable and apply
     * classes. Runs inside an editorState.read().
     */
    const applyFolds = () => {
      editor.getEditorState().read(() => {
        const blocks = $readBlocks()
        const listItems = $readFoldableListItems()

        // Prune collapsed keys that no longer point at a foldable node (deleted
        // or converted) so stale keys can't hide unrelated content.
        const validHeadingKeys = new Set(blocks.filter((b) => b.headingLevel !== null).map((b) => b.key))
        for (const key of collapsedHeadings) {
          if (!validHeadingKeys.has(key)) {
            collapsedHeadings.delete(key)
          }
        }
        const validItemKeys = new Set(listItems.map((i) => i.key))
        for (const key of collapsedItems) {
          if (!validItemKeys.has(key)) {
            collapsedItems.delete(key)
          }
        }

        const hidden = computeHiddenBlockKeys(blocks, collapsedHeadings)
        const hiddenNested = computeHiddenListItemKeys(listItems, collapsedItems)
        for (const key of hiddenNested) {
          hidden.add(key)
        }

        const foldableKeys = new Set<string>([...validHeadingKeys, ...validItemKeys])

        const allKeys = new Set<string>([...foldableKeys, ...hidden])
        for (const key of allKeys) {
          const el = editor.getElementByKey(key)
          if (!el) {
            continue
          }
          const isFoldable = foldableKeys.has(key)
          el.classList.toggle(FOLDABLE_CLASS, isFoldable)
          el.classList.toggle(FOLDED_CLASS, hidden.has(key))
          el.classList.toggle(COLLAPSED_CLASS, collapsedHeadings.has(key) || collapsedItems.has(key))
          ensureToggle(el, key, isFoldable)
        }
      })
    }

    /** Toggle the fold for the foldable element owning the given DOM node. */
    const toggleFoldForElement = (toggle: HTMLElement) => {
      const foldableEl = toggle.closest<HTMLElement>(`.${FOLDABLE_CLASS}`)
      const key = foldableEl?.getAttribute(KEY_ATTR)
      if (!key) {
        return
      }
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(key)
        if ($isHeadingNode(node)) {
          if (collapsedHeadings.has(key)) {
            collapsedHeadings.delete(key)
          } else {
            collapsedHeadings.add(key)
          }
        } else if ($isListItemNode(node)) {
          if (collapsedItems.has(key)) {
            collapsedItems.delete(key)
          } else {
            collapsedItems.add(key)
          }
        }
      })
      applyFolds()
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const toggle = target?.closest<HTMLElement>(`[${TOGGLE_ATTR}]`)
      if (!toggle) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      toggleFoldForElement(toggle)
    }

    const cleanup = mergeRegister(
      // Recompute on every change so edits keep folds consistent.
      editor.registerUpdateListener(() => {
        applyFolds()
      }),
      // (Re)bind the click handler whenever the root element changes.
      editor.registerRootListener((nextRoot, prevRoot) => {
        prevRoot?.removeEventListener('click', onClick)
        nextRoot?.addEventListener('click', onClick)
      }),
    )

    // Initial pass.
    applyFolds()

    return cleanup
  }, [editor])

  return null
}
