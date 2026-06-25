/**
 * Block-level paragraph formatting for the Super editor toolbar: line height,
 * paragraph spacing (space before / after), left / right / first-line
 * indentation, block margins, and inline text shading.
 *
 * The block-style helpers write CSS declarations onto each leaf block element's
 * inline `style` (ElementNode.getStyle/setStyle), merging with any properties
 * already present so independent controls don't clobber one another. Passing an
 * empty string for a value removes that property (a "clear" / "none").
 *
 * Text shading is an *inline* property, so it goes through $patchStyleText like
 * font-size does.
 *
 * Functions prefixed with `$` must run inside editor.update(). The leaf-block
 * collection mirrors LineTransform.ts's `isLineBlock` predicate (replicated here
 * intentionally — that file is not edited).
 */
import {
  $isElementNode,
  $isRootOrShadowRoot,
  ElementNode,
  LexicalNode,
  RangeSelection,
} from 'lexical'
import { $findMatchingParent } from '@lexical/utils'
import { $patchStyleText } from '@lexical/selection'

/* ------------------------------------------------------------------ presets */

/** Unit-less line-height multipliers offered in the toolbar menu. */
export const LINE_HEIGHT_PRESETS = ['1', '1.15', '1.5', '2'] as const

/** Paragraph spacing presets (CSS lengths) for space-before / space-after. */
export const SPACING_PRESETS = ['0', '4px', '8px', '12px', '16px', '24px'] as const

/** One indentation "step" — used by the toolbar to increase / decrease indent. */
export const INDENT_STEP = '40px'

/** Text-shading swatches; `null` clears the highlight. */
export const TEXT_SHADING_PRESETS = [
  null,
  '#fff3a3',
  '#c2f5c2',
  '#bfe3ff',
  '#ffd1dc',
  '#e4d4ff',
] as const

/* --------------------------------------------------------------- block leaf */

/**
 * A "line" is a leaf block element holding inline content — a paragraph,
 * heading, quote, or list item — i.e. a non-inline element that does not itself
 * contain other block elements. Replicated from LineTransform.ts's predicate.
 */
const isLineBlock = (node: LexicalNode | null): node is ElementNode =>
  node != null &&
  $isElementNode(node) &&
  !node.isInline() &&
  !$isRootOrShadowRoot(node) &&
  !node.getChildren().some((child) => $isElementNode(child) && !child.isInline())

/** Collect the distinct line blocks intersected by `selection`, in document order. */
export const $collectFormatBlocks = (selection: RangeSelection): ElementNode[] => {
  const blocks: ElementNode[] = []
  const seen = new Set<string>()
  for (const node of selection.getNodes()) {
    const block = isLineBlock(node) ? node : $findMatchingParent(node, isLineBlock)
    if (isLineBlock(block) && !seen.has(block.getKey())) {
      seen.add(block.getKey())
      blocks.push(block)
    }
  }
  return blocks
}

/* ----------------------------------------------------------- style plumbing */

/**
 * Parse an inline `style` string into an ordered property→value map. Empty /
 * malformed declarations are skipped. Property names are lower-cased and
 * trimmed; values keep their original casing (colours etc.).
 */
export const parseStyleString = (style: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) {
      continue
    }
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (prop !== '' && value !== '') {
      map.set(prop, value)
    }
  }
  return map
}

/** Serialise a property→value map back into an inline `style` string. */
export const serializeStyleMap = (map: Map<string, string>): string => {
  const parts: string[] = []
  for (const [prop, value] of map) {
    parts.push(`${prop}: ${value}`)
  }
  return parts.join('; ')
}

/**
 * Merge a single CSS property onto a block's existing inline style. An empty /
 * whitespace-only `value` removes the property. Returns the new style string.
 */
export const mergeBlockStyle = (current: string, property: string, value: string): string => {
  const map = parseStyleString(current)
  const prop = property.trim().toLowerCase()
  const normalized = value.trim()
  if (normalized === '') {
    map.delete(prop)
  } else {
    map.set(prop, normalized)
  }
  return serializeStyleMap(map)
}

/**
 * Apply one CSS property/value to every leaf block the selection spans, merging
 * with whatever is already on each block. Returns the number of blocks touched.
 */
const $patchBlockStyle = (selection: RangeSelection, property: string, value: string): number => {
  const blocks = $collectFormatBlocks(selection)
  for (const block of blocks) {
    block.setStyle(mergeBlockStyle(block.getStyle(), property, value))
  }
  return blocks.length
}

/* --------------------------------------------------------------- public API */

/** Set `line-height` on each spanned block. Empty string clears it. */
export const $setLineHeight = (selection: RangeSelection, value: string): number =>
  $patchBlockStyle(selection, 'line-height', value)

/** Set `margin-top` ("space before" / advance) on each spanned block. */
export const $setSpaceBefore = (selection: RangeSelection, value: string): number =>
  $patchBlockStyle(selection, 'margin-top', value)

/** Set `margin-bottom` ("space after" / paragraph spacing) on each spanned block. */
export const $setSpaceAfter = (selection: RangeSelection, value: string): number =>
  $patchBlockStyle(selection, 'margin-bottom', value)

/** Set left indent (`padding-left`) on each spanned block. */
export const $setIndent = (selection: RangeSelection, value: string): number =>
  $patchBlockStyle(selection, 'padding-left', value)

/** Set right indent (`padding-right`) on each spanned block. */
export const $setIndentRight = (selection: RangeSelection, value: string): number =>
  $patchBlockStyle(selection, 'padding-right', value)

/** Set first-line indent (`text-indent`) on each spanned block. */
export const $setFirstLineIndent = (selection: RangeSelection, value: string): number =>
  $patchBlockStyle(selection, 'text-indent', value)

/**
 * Set block left / right margins on each spanned block. Either field may be
 * omitted to leave that side untouched; an empty string clears that side.
 */
export const $setBlockMargins = (
  selection: RangeSelection,
  margins: { left?: string; right?: string },
): number => {
  const blocks = $collectFormatBlocks(selection)
  for (const block of blocks) {
    let style = block.getStyle()
    if (margins.left !== undefined) {
      style = mergeBlockStyle(style, 'margin-left', margins.left)
    }
    if (margins.right !== undefined) {
      style = mergeBlockStyle(style, 'margin-right', margins.right)
    }
    block.setStyle(style)
  }
  return blocks.length
}

/**
 * Apply text shading (highlight) to the selected inline text via
 * $patchStyleText. Passing `null` removes the shading. Returns true (a style
 * patch is always attempted on a range selection).
 */
export const $setTextShading = (selection: RangeSelection, color: string | null): boolean => {
  $patchStyleText(selection, { 'background-color': color })
  return true
}
