/**
 * Configurable list-marker styling for the Super editor toolbar.
 *
 * `$setListStyle` finds the nearest @lexical/list `ListNode` ancestor of the
 * given selection and changes its CSS `list-style-type` (e.g. `disc`,
 * `lower-alpha`, ...). `$`-prefixed functions MUST be called inside
 * `editor.update()`.
 *
 * MARKER MODEL: every preset carries a stable `value` key plus the CSS needed to
 * render it. Native CSS `list-style-type` keywords (disc, circle, square,
 * decimal, lower-alpha, ...) are applied directly as `list-style-type`. Glyph
 * markers that CSS has no keyword for (dash, arrow, triangle, tickbox, star, ...)
 * are rendered via a `::marker`/`content` rule keyed by a `Lexical__listStyle--*`
 * class (see lists.scss). Both the `list-style-type` and the class are written to
 * the live DOM and persisted on the node so they round-trip + re-render.
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
 *
 * MULTILEVEL: a top-level list can additionally store a per-nesting-level style
 * map under the custom `--sn-list-levels` declaration in its inline style (a
 * compact `1=disc,2=circle,3=square` string). `applyListStyleToDOM` reads it and
 * stamps the matching marker onto each descendant list keyed by its visual depth,
 * so "Define new multilevel list" choices survive reload.
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
  /** Stable style key persisted on the node + used to build the CSS class. */
  value: string
  /**
   * Native CSS `list-style-type` keyword to set, or `null` for a custom glyph
   * marker (rendered purely via the `Lexical__listStyle--<value>` class).
   */
  listStyleType: string | null
  /** Short glyph shown in the picker UI as a preview. */
  preview: string
}

/**
 * Bullet (`<ul>`) marker presets. Native keywords use their `list-style-type`;
 * everything else is a custom glyph drawn by the matching CSS class.
 */
export const BULLET_STYLES: ReadonlyArray<ListStylePreset> = [
  { label: 'Disc', value: 'disc', listStyleType: 'disc', preview: '•' },
  { label: 'Circle', value: 'circle', listStyleType: 'circle', preview: '◦' },
  { label: 'Square', value: 'square', listStyleType: 'square', preview: '▪' },
  { label: 'Dash', value: 'dash', listStyleType: null, preview: '–' },
  { label: 'Arrow', value: 'arrow', listStyleType: null, preview: '▸' },
  { label: 'Alt arrow', value: 'arrow-alt', listStyleType: null, preview: '→' },
  { label: 'Triangle', value: 'triangle', listStyleType: null, preview: '‣' },
  { label: 'Diamond', value: 'diamond', listStyleType: null, preview: '◆' },
  { label: 'Star', value: 'star', listStyleType: null, preview: '★' },
  { label: 'Chevron', value: 'chevron', listStyleType: null, preview: '»' },
  { label: 'Tickbox', value: 'tickbox', listStyleType: null, preview: '☐' },
  { label: 'Cross', value: 'cross', listStyleType: null, preview: '✗' },
  { label: 'None', value: 'none', listStyleType: 'none', preview: '—' },
]

/**
 * Numbered (`<ol>`) marker presets. `decimal`/alpha/roman map to their native
 * `list-style-type`; the parenthesized + legal styles are custom (CSS counters).
 */
export const NUMBER_STYLES: ReadonlyArray<ListStylePreset> = [
  { label: '1, 2, 3', value: 'decimal', listStyleType: 'decimal', preview: '1.' },
  { label: 'a, b, c', value: 'lower-alpha', listStyleType: 'lower-alpha', preview: 'a.' },
  { label: 'A, B, C', value: 'upper-alpha', listStyleType: 'upper-alpha', preview: 'A.' },
  { label: 'i, ii, iii', value: 'lower-roman', listStyleType: 'lower-roman', preview: 'i.' },
  { label: 'I, II, III', value: 'upper-roman', listStyleType: 'upper-roman', preview: 'I.' },
  { label: 'a) b) c)', value: 'lower-alpha-paren', listStyleType: null, preview: 'a)' },
  { label: '1) 2) 3)', value: 'decimal-paren', listStyleType: null, preview: '1)' },
  { label: '1.1.1 (legal)', value: 'legal', listStyleType: null, preview: '1.1' },
]

/** Every preset keyed by its stable `value`, for fast lookups when applying. */
const PRESET_BY_VALUE: ReadonlyMap<string, ListStylePreset> = new Map(
  [...BULLET_STYLES, ...NUMBER_STYLES].map((preset) => [preset.value, preset]),
)

const LIST_STYLE_PROPERTY = 'list-style-type'
/**
 * Custom declaration storing the stable preset `value` (e.g. `arrow`, `dash`).
 * This is the source of truth for the marker: custom-glyph presets have
 * `listStyleType: null` and are persisted as `list-style-type: none`, so without
 * this the glyph identity would be lost on reload (the bug where custom markers
 * silently rendered as nothing). Native presets store their value here too.
 */
const MARKER_PROPERTY = '--sn-list-marker'
/** Custom declaration storing the compact per-level multilevel style map. */
const LEVELS_PROPERTY = '--sn-list-levels'
/** All marker classes we may add, so we can clear stale ones before re-stamping. */
const ALL_MARKER_CLASSES = [...BULLET_STYLES, ...NUMBER_STYLES].map((p) => `Lexical__listStyle--${p.value}`)

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
const withProperty = (existingCSS: string, property: string, value: string): string => {
  const map = parseCSS(existingCSS)
  map.set(property, value)
  return serializeCSS(map)
}

/** Per-level style map: nesting level (1-based) -> preset `value`. */
export type MultilevelStyleMap = Record<number, string>

/** Serialize a per-level map to the compact `1=disc,2=circle` form. */
const serializeLevels = (levels: MultilevelStyleMap): string =>
  Object.entries(levels)
    .filter(([, value]) => Boolean(value))
    .map(([level, value]) => `${level}=${value}`)
    .join(',')

/** Parse the compact `1=disc,2=circle` form back into a per-level map. */
const parseLevels = (raw: string | undefined): MultilevelStyleMap => {
  const result: MultilevelStyleMap = {}
  if (!raw) {
    return result
  }
  for (const pair of raw.split(',')) {
    const [level, value] = pair.split('=')
    const levelNum = Number(level)
    if (Number.isInteger(levelNum) && levelNum > 0 && value && PRESET_BY_VALUE.has(value.trim())) {
      result[levelNum] = value.trim()
    }
  }
  return result
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
 * Walk up to the OUTERMOST `ListNode` ancestor of the selection (the top of a
 * possibly-nested list). Used by the multilevel configurator, whose per-level
 * map is stored on the top list so it governs the whole nesting tree.
 */
export const $getTopListNodeFromSelection = (selection: BaseSelection | null): ListNode | null => {
  let list = $getListNodeFromSelection(selection)
  if (list === null) {
    return null
  }
  let parent = list.getParent()
  while (parent !== null) {
    if ($isListNode(parent)) {
      list = parent
    }
    parent = parent.getParent()
  }
  return list
}

/**
 * Set the marker style of the nearest `ListNode` ancestor of the selection.
 * Persists the value on the node (for serialization) and applies it to the live
 * `<ol>`/`<ul>` DOM element so it renders immediately.
 *
 * Returns the affected `ListNode`, or `null` when the selection is not inside a
 * list. Must be called inside `editor.update()`.
 */
export const $setListStyle = (selection: BaseSelection | null, styleValue: string): ListNode | null => {
  const listNode = $getListNodeFromSelection(selection)
  if (listNode === null) {
    return null
  }
  const writable = listNode.getWritable()
  persistMarker(writable, styleValue)
  applyListStyleToDOM(writable)
  return writable
}

/**
 * Persist a marker style on a writable list node: the native `list-style-type`
 * (or `none` for custom glyphs) AND the stable preset value under
 * {@link MARKER_PROPERTY}, so both native and custom-glyph markers round-trip.
 */
const persistMarker = (writable: ListNode, styleValue: string): void => {
  const preset = PRESET_BY_VALUE.get(styleValue)
  const cssType = preset ? preset.listStyleType ?? 'none' : styleValue
  let css = withProperty(writable.getStyle(), LIST_STYLE_PROPERTY, cssType)
  css = withProperty(css, MARKER_PROPERTY, styleValue)
  writable.setStyle(css)
}

/**
 * Persist a per-nesting-level style map on the OUTERMOST list owning the
 * selection and stamp every nested list with its level's marker. Returns the top
 * list, or `null` when the selection is not inside a list. Must run inside
 * `editor.update()`.
 */
export const $setMultilevelListStyle = (
  selection: BaseSelection | null,
  levels: MultilevelStyleMap,
): ListNode | null => {
  const top = $getTopListNodeFromSelection(selection)
  if (top === null) {
    return null
  }
  const writable = top.getWritable()
  const serialized = serializeLevels(levels)
  if (serialized) {
    writable.setStyle(withProperty(writable.getStyle(), LEVELS_PROPERTY, serialized))
  } else {
    const map = parseCSS(writable.getStyle())
    map.delete(LEVELS_PROPERTY)
    writable.setStyle(serializeCSS(map))
  }
  applyListStyleToDOM(writable)
  return writable
}

/** Read the persisted per-level multilevel style map off a top `ListNode`. */
export const $getMultilevelListStyle = (listNode: ListNode): MultilevelStyleMap =>
  parseLevels(parseCSS(listNode.getStyle()).get(LEVELS_PROPERTY))

/**
 * Read the persisted marker style off a `ListNode`. Prefers an explicit single
 * style; returns `null` when none was set. The returned value is the stable
 * preset `value` when recognisable, else the raw `list-style-type`.
 */
export const $getListStyle = (listNode: ListNode): string | null => {
  const declared = parseCSS(listNode.getStyle())
  return declared.get(MARKER_PROPERTY) ?? declared.get(LIST_STYLE_PROPERTY) ?? null
}

/** Stamp a single list element with one preset's marker (class + native type). */
const stampMarker = (element: HTMLElement, styleValue: string | null): void => {
  for (const cls of ALL_MARKER_CLASSES) {
    element.classList.remove(cls)
  }
  if (styleValue === null) {
    element.style.removeProperty(LIST_STYLE_PROPERTY)
    return
  }
  const preset = PRESET_BY_VALUE.get(styleValue)
  if (preset) {
    element.classList.add(`Lexical__listStyle--${preset.value}`)
    element.style.setProperty(LIST_STYLE_PROPERTY, preset.listStyleType ?? 'none')
  } else {
    // Unknown value: treat as a raw native list-style-type.
    element.style.setProperty(LIST_STYLE_PROPERTY, styleValue)
  }
}

/**
 * Push a `ListNode`'s persisted styling onto its rendered DOM element — both the
 * single marker (`list-style-type`/class) and, when present, the multilevel map
 * stamped onto each descendant list by depth. No-op when the node has no live
 * element yet. Must run where `$getEditor()` is available.
 */
export const applyListStyleToDOM = (listNode: ListNode): void => {
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

  // The stable marker value persisted on the node (custom-glyph identity lives in
  // MARKER_PROPERTY; fall back to a raw native list-style-type for older nodes).
  const declared = parseCSS(listNode.getStyle())
  const markerValue = declared.get(MARKER_PROPERTY) ?? declared.get(LIST_STYLE_PROPERTY) ?? null

  const levels = $getMultilevelListStyle(listNode)
  const hasLevels = Object.keys(levels).length > 0

  // Nothing persisted here — leave the element alone (don't clear a marker a
  // multilevel ancestor may have stamped on this nested list).
  if (markerValue === null && !hasLevels) {
    return
  }

  if (!hasLevels) {
    stampMarker(element, markerValue)
    return
  }

  // Multilevel: stamp each descendant list by its visual nesting level relative
  // to this top. `parentLevel` is the level of the nearest list ANCESTOR; a list
  // found here therefore sits one level deeper, so it must be stamped with
  // `levels[parentLevel + 1]`. (The top list itself is level 1, stamped below.)
  const stampDepth = (node: LexicalNode, parentLevel: number): void => {
    let levelHere = parentLevel
    if ($isListNode(node)) {
      levelHere = parentLevel + 1
      try {
        const el = $getEditor().getElementByKey(node.getKey())
        if (el) {
          // This descendant list is part of THIS multilevel tree being re-applied,
          // so it is always safe to (re)stamp it. When `levels[levelHere]` is
          // absent/falsy (e.g. a multilevel map redefined to drop a level's glyph),
          // clear any stale marker class instead of leaving the previous glyph in
          // place — mirroring the single-level `stampMarker(el, null)` clear path.
          const value = levels[levelHere]
          stampMarker(el, value ?? null)
        }
      } catch {
        /* not rendered */
      }
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        stampDepth(child, levelHere)
      }
    }
  }
  // The top list itself is level 1.
  stampMarker(element, levels[1] ?? markerValue)
  for (const child of listNode.getChildren()) {
    stampDepth(child, 1)
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
export const $setListStyleByKey = (nodeKey: string, styleValue: string): ListNode | null => {
  const node = $getNodeByKey(nodeKey)
  if (node === null || !$isListNode(node)) {
    return null
  }
  const writable = node.getWritable()
  persistMarker(writable, styleValue)
  applyListStyleToDOM(writable)
  return writable
}
