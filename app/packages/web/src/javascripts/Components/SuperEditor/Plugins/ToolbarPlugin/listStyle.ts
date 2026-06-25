/**
 * Configurable list-marker styling for the Super editor toolbar.
 *
 * `$setListStyle` finds the nearest @lexical/list `ListNode` ancestor of the
 * given selection and changes its CSS `list-style-type` (e.g. `disc`,
 * `lower-alpha`, ...). `$`-prefixed functions MUST be called inside
 * `editor.update()`.
 *
 * WHY TWO WRITES (node + DOM): In this Lexical build (0.45) the reconciler only
 * applies `text-align`/indent for ElementNodes — it never copies an
 * ElementNode's `__style` onto the rendered `<ol>`/`<ul>`, and `ListNode`'s
 * `createDOM`/`updateDOM` ignore style entirely. So to make the marker actually
 * RENDER we must set the inline style on the live list element directly via
 * `getElementByKey`. We also persist the value onto the node's inherited
 * `__style` (`ElementNode.setStyle`) so it round-trips through
 * `exportJSON`/`importJSON` and is re-applied by `applyPersistedListStyles`
 * after a fresh render where the reconciler rebuilt the DOM from scratch.
 */
import {
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  BaseSelection,
  LexicalNode,
} from 'lexical'
import { $getNearestNodeOfType } from '@lexical/utils'
import { $isListNode, ListNode } from '@lexical/list'

export interface ListStylePreset {
  label: string
  value: string
}

/** Bullet (`<ul>`) marker presets. `value` is a CSS `list-style-type`. */
export const BULLET_STYLES: ReadonlyArray<ListStylePreset> = [
  { label: 'Disc', value: 'disc' },
  { label: 'Circle', value: 'circle' },
  { label: 'Square', value: 'square' },
  { label: 'None', value: 'none' },
]

/** Numbered (`<ol>`) marker presets. `value` is a CSS `list-style-type`. */
export const NUMBER_STYLES: ReadonlyArray<ListStylePreset> = [
  { label: '1, 2, 3', value: 'decimal' },
  { label: 'a, b, c', value: 'lower-alpha' },
  { label: 'A, B, C', value: 'upper-alpha' },
  { label: 'i, ii, iii', value: 'lower-roman' },
  { label: 'I, II, III', value: 'upper-roman' },
]

const LIST_STYLE_PROPERTY = 'list-style-type'

/**
 * Parse a CSS declaration string (`"a: b; c: d"`) into an ordered map. Keys are
 * lowercased/trimmed; values keep their original casing. Mirrors the loose
 * parsing Lexical itself uses for inline styles.
 */
const parseCSS = (css: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const decl of css.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) {
      continue
    }
    const key = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (key && value) {
      map.set(key, value)
    }
  }
  return map
}

const serializeCSS = (map: Map<string, string>): string =>
  Array.from(map.entries())
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ')

/**
 * Return `existingCSS` with `list-style-type` set to `cssListStyleType`,
 * preserving any other declarations already present on the node.
 */
const withListStyleType = (existingCSS: string, cssListStyleType: string): string => {
  const map = parseCSS(existingCSS)
  map.set(LIST_STYLE_PROPERTY, cssListStyleType)
  return serializeCSS(map)
}

/**
 * Resolve the nearest `ListNode` that owns the selection. Walks up from the
 * selection's anchor; returns `null` when the selection is not inside a list.
 */
export const $getListNodeFromSelection = (selection: BaseSelection | null): ListNode | null => {
  if (selection === null) {
    return null
  }
  const nodes = selection.getNodes()
  for (const node of nodes) {
    if ($isListNode(node)) {
      return node
    }
    const ancestor = $getNearestNodeOfType<ListNode>(node, ListNode)
    if (ancestor !== null) {
      return ancestor
    }
  }
  return null
}

/**
 * Set the CSS `list-style-type` of the nearest `ListNode` ancestor of the
 * selection. Persists the value on the node (for serialization) and applies it
 * to the live `<ol>`/`<ul>` DOM element so it renders immediately.
 *
 * Returns the affected `ListNode`, or `null` when the selection is not inside a
 * list. Must be called inside `editor.update()`.
 */
export const $setListStyle = (selection: BaseSelection | null, cssListStyleType: string): ListNode | null => {
  const listNode = $getListNodeFromSelection(selection)
  if (listNode === null) {
    return null
  }
  const writable = listNode.getWritable()
  writable.setStyle(withListStyleType(writable.getStyle(), cssListStyleType))
  applyListStyleToDOM(writable)
  return writable
}

/**
 * Read the persisted `list-style-type` off a `ListNode`'s inline style, or
 * `null` when none has been set.
 */
export const $getListStyle = (listNode: ListNode): string | null => {
  const value = parseCSS(listNode.getStyle()).get(LIST_STYLE_PROPERTY)
  return value === undefined ? null : value
}

/**
 * Push a single `ListNode`'s persisted `list-style-type` onto its rendered DOM
 * element. No-op when the node has no live element yet or carries no list style.
 * Must run inside an editor read/update where `$getEditor()` is available.
 */
export const applyListStyleToDOM = (listNode: ListNode): void => {
  const value = $getListStyle(listNode)
  let element: HTMLElement | null
  try {
    // `getElementByKey` is unavailable in headless mode and returns null before
    // the node has rendered — in both cases there is simply nothing to style.
    element = $getEditor().getElementByKey(listNode.getKey())
  } catch {
    return
  }
  if (element === null) {
    return
  }
  if (value === null) {
    element.style.removeProperty(LIST_STYLE_PROPERTY)
  } else {
    element.style.setProperty(LIST_STYLE_PROPERTY, value)
  }
}

/**
 * Re-apply every persisted list style in the document to the DOM. Call this from
 * an editor update/registerUpdateListener after the editor (re)rendered list
 * DOM from a deserialized state, since the reconciler does not copy ElementNode
 * `__style` onto `<ol>`/`<ul>` in this Lexical build. Must run where
 * `$getEditor()` is available.
 */
export const applyPersistedListStyles = (): void => {
  const visit = (node: LexicalNode): void => {
    if ($isListNode(node)) {
      applyListStyleToDOM(node)
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child)
      }
    }
  }
  visit($getRoot())
}

/**
 * Convenience wrapper used by toolbar UI: apply a list style by the node key the
 * toolbar already resolved, avoiding a re-walk of the selection.
 */
export const $setListStyleByKey = (nodeKey: string, cssListStyleType: string): ListNode | null => {
  const node = $getNodeByKey(nodeKey)
  if (node === null || !$isListNode(node)) {
    return null
  }
  const writable = node.getWritable()
  writable.setStyle(withListStyleType(writable.getStyle(), cssListStyleType))
  applyListStyleToDOM(writable)
  return writable
}
