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
const TOGGLE_KIND_ATTR = 'data-fold-kind'
const TOGGLE_RAIL_ATTR = 'data-fold-control-rail'
const PRINT_EXCLUDE_ATTR = 'data-srn-print-exclude'

export type FoldControlKind = 'heading' | 'list' | 'checklist'

const FOLDABLE_KIND_CLASSES: Record<FoldControlKind, string> = {
  heading: `${FOLDABLE_CLASS}--heading`,
  list: `${FOLDABLE_CLASS}--list`,
  checklist: `${FOLDABLE_CLASS}--checklist`,
}

const TOGGLE_KIND_CLASSES: Record<FoldControlKind, string> = {
  heading: `${TOGGLE_CLASS}--heading`,
  list: `${TOGGLE_CLASS}--list`,
  checklist: `${TOGGLE_CLASS}--checklist`,
}

/**
 * Build the fold-toggle button element, marked Lexical-UNMANAGED.
 *
 * Exported so the regression test can assert the unmanaged flag is present
 * WITHOUT a full editor mount. The unmanaged flag is the load-bearing part of
 * the no-hang fix (see `syncFoldControl`): the toggle is injected into a
 * Lexical-owned `<li>`/heading, so Lexical's DOM MutationObserver would
 * otherwise `removeChild` it and revert the selection, scheduling an update that
 * re-inserts it — an unbounded insert/observe/remove/update loop that froze the
 * app the instant a list item became foldable (e.g. Tab-nesting a list item).
 */
export function createFoldToggle(kind: FoldControlKind = 'heading'): HTMLElement {
  const toggle = document.createElement('span')
  toggle.setAttribute(TOGGLE_ATTR, 'true')
  toggle.setAttribute(TOGGLE_KIND_ATTR, kind)
  toggle.setAttribute(TOGGLE_RAIL_ATTR, 'opposite-drag-handle')
  toggle.setAttribute(PRINT_EXCLUDE_ATTR, 'true')
  toggle.setAttribute('contenteditable', 'false')
  toggle.setAttribute('role', 'button')
  toggle.setAttribute('aria-label', 'Toggle fold')
  toggle.setAttribute('aria-expanded', 'true')
  // Keep the injected control out of the editor's keyboard/caret order. It is
  // deliberately click-only so Home/End/arrow selection remains owned by
  // Lexical, just as it was before the action rail was introduced.
  toggle.tabIndex = -1
  toggle.className = `${TOGGLE_CLASS} ${TOGGLE_KIND_CLASSES[kind]}`
  // CRITICAL (no-hang fix): mark this externally-injected span as
  // Lexical-UNMANAGED before it is inserted so Lexical's MutationObserver skips
  // it instead of removing it and reverting selection (which re-triggers the
  // update listener -> infinite re-insert loop). Headless Lexical has no
  // MutationObserver, so the loop is invisible to jest — only a real browser
  // (the super-tab-no-hang e2e) reproduces it.
  setDOMUnmanaged(toggle)
  return toggle
}

/**
 * Synchronize the externally injected control and its host's semantic layout
 * markers. The modifier classes are intentionally explicit: CSS can reserve a
 * checklist's checkbox rail separately from the fold-control rail, including
 * for inherited RTL direction, without inspecting or rearranging Lexical's
 * managed text children.
 */
export function syncFoldControl(
  element: HTMLElement,
  key: string,
  kind: FoldControlKind | null,
  collapsed: boolean,
): HTMLElement | null {
  const existing = element.querySelector<HTMLElement>(`:scope > [${TOGGLE_ATTR}]`)

  element.classList.remove(...Object.values(FOLDABLE_KIND_CLASSES))
  if (!kind) {
    existing?.remove()
    element.removeAttribute(KEY_ATTR)
    return null
  }

  element.setAttribute(KEY_ATTR, key)
  element.classList.add(FOLDABLE_KIND_CLASSES[kind])

  const toggle = existing ?? createFoldToggle(kind)
  toggle.classList.remove(...Object.values(TOGGLE_KIND_CLASSES))
  toggle.classList.add(TOGGLE_CLASS, TOGGLE_KIND_CLASSES[kind])
  toggle.setAttribute(TOGGLE_KIND_ATTR, kind)
  toggle.setAttribute(TOGGLE_RAIL_ATTR, 'opposite-drag-handle')
  toggle.setAttribute(PRINT_EXCLUDE_ATTR, 'true')
  toggle.setAttribute('contenteditable', 'false')
  toggle.setAttribute('role', 'button')
  toggle.setAttribute('aria-label', 'Toggle fold')
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  toggle.tabIndex = -1

  if (!existing) {
    // APPEND the control rather than inserting it before the managed text.
    // Although it is visually placed in its own action rail, keeping it last
    // prevents Home/click-at-column-zero from seating the caret around a
    // non-editable child.
    element.appendChild(toggle)
  }

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
type FoldableListItem = FoldListItem & { kind: Extract<FoldControlKind, 'list' | 'checklist'> }

function $readFoldableListItems(): FoldableListItem[] {
  const items: FoldableListItem[] = []
  const walk = (node: LexicalNode) => {
    if ($isListItemNode(node)) {
      const childKeys = collectNestedKeys(node)
      if (childKeys.length > 0) {
        const parent = node.getParent()
        const kind = $isListNode(parent) && parent.getListType() === 'check' ? 'checklist' : 'list'
        items.push({ key: node.getKey(), childKeys, kind })
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
    // Include the previous pass's keys when applying the next pass. Otherwise a
    // paragraph/list subtree hidden by a fold drops out of `hidden` as soon as
    // it is expanded and never gets visited to remove `Lexical__folded`.
    // Tracking also removes stale controls when a heading/list is converted to
    // a non-foldable node.
    const previouslyManagedKeys = new Set<string>()

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
        const foldableKinds = new Map<string, FoldControlKind>()
        for (const block of blocks) {
          if (block.headingLevel !== null) {
            foldableKinds.set(block.key, 'heading')
          }
        }
        for (const item of listItems) {
          foldableKinds.set(item.key, item.kind)
        }

        const currentlyManagedKeys = new Set<string>([...foldableKeys, ...hidden])
        const allKeys = new Set<string>([...currentlyManagedKeys, ...previouslyManagedKeys])
        for (const key of allKeys) {
          const el = editor.getElementByKey(key)
          if (!el) {
            continue
          }
          const isFoldable = foldableKeys.has(key)
          el.classList.toggle(FOLDABLE_CLASS, isFoldable)
          el.classList.toggle(FOLDED_CLASS, hidden.has(key))
          const isCollapsed = collapsedHeadings.has(key) || collapsedItems.has(key)
          el.classList.toggle(COLLAPSED_CLASS, isCollapsed)
          syncFoldControl(el, key, foldableKinds.get(key) ?? null, isCollapsed)
        }

        previouslyManagedKeys.clear()
        for (const key of currentlyManagedKeys) {
          previouslyManagedKeys.add(key)
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
