import {
  $isRangeSelection,
  $isTextNode,
  IS_BOLD,
  IS_CODE,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_UNDERLINE,
  RangeSelection,
  TextFormatType,
} from 'lexical'
import { $getSelectionStyleValueForProperty } from '@lexical/selection'
import { CapturedFormat } from './formatPainterStore'

/**
 * The inline TextFormatTypes the painter copies, paired with their IS_* bitmask
 * flags. `selection.hasFormat(type)` reflects the actual underlying node state
 * (the toolbar uses the same API), so the captured bitmask is robust regardless
 * of how the RangeSelection's cached `format` happens to be populated.
 */
const FORMAT_FLAGS: ReadonlyArray<[TextFormatType, number]> = [
  ['bold', IS_BOLD],
  ['italic', IS_ITALIC],
  ['underline', IS_UNDERLINE],
  ['strikethrough', IS_STRIKETHROUGH],
  ['subscript', IS_SUBSCRIPT],
  ['superscript', IS_SUPERSCRIPT],
  ['code', IS_CODE],
  ['highlight', IS_HIGHLIGHT],
]

/**
 * The inline CSS style properties the painter copies (font + colors). These
 * mirror the properties the toolbar exposes via $patchStyleText /
 * $getSelectionStyleValueForProperty.
 */
const STYLE_PROPERTIES = [
  'font-family',
  'font-size',
  'color',
  'background-color',
  'text-decoration',
  'text-transform',
] as const

/**
 * Whether a format is active across the selection. Prefers Lexical's
 * `selection.hasFormat` (which reflects the live DOM-synced selection during a
 * real SELECTION_CHANGE), but falls back to inspecting the selected TextNodes
 * directly: a format counts as active only if every selected TextNode carries
 * it. The fallback makes capture robust for programmatic/headless selections
 * whose cached `format` field hasn't been populated by the browser.
 */
function $selectionHasFormat(selection: RangeSelection, type: TextFormatType, flag: number): boolean {
  if (selection.hasFormat(type)) {
    return true
  }
  const textNodes = selection.getNodes().filter($isTextNode)
  if (textNodes.length === 0) {
    return false
  }
  return textNodes.every((node) => (node.getFormat() & flag) !== 0)
}

/**
 * Capture the inline formatting (TextNode format bitmask + inline CSS style
 * string) of the given range selection. Must run inside an editor read/update.
 *
 * The bitmask is derived from `selection.hasFormat()` and the style string from
 * `$getSelectionStyleValueForProperty` so the result reflects the real node
 * state rather than only the selection's cached values.
 */
export function $captureFormatFromSelection(selection: RangeSelection): CapturedFormat {
  let format = 0
  for (const [type, flag] of FORMAT_FLAGS) {
    if ($selectionHasFormat(selection, type, flag)) {
      format |= flag
    }
  }

  const styleParts: string[] = []
  for (const property of STYLE_PROPERTIES) {
    const value = $getSelectionStyleValueForProperty(selection, property, '')
    if (value) {
      styleParts.push(`${property}: ${value};`)
    }
  }

  return { format, style: styleParts.join(' ') }
}

/**
 * Apply a previously-captured inline format to the current range selection.
 * Must run inside an editor `update()`.
 *
 * Mirrors the node-splitting approach used by the toolbar's clearFormatting so
 * that only the selected portion of the first/last partially-selected TextNodes
 * is restyled (not the surrounding unselected text).
 *
 * For a collapsed selection there is no text to paint, so the format/style is
 * staged onto the selection itself; the next typed characters inherit it,
 * matching Word's "paint then type" behavior.
 */
export function $applyCapturedFormatToSelection(selection: RangeSelection, captured: CapturedFormat): void {
  if (!$isRangeSelection(selection)) {
    return
  }

  if (selection.isCollapsed()) {
    selection.format = captured.format
    selection.style = captured.style
    return
  }

  const anchor = selection.anchor
  const focus = selection.focus
  const nodes = selection.getNodes()

  // Normalize so the earlier point in document order is used for splitting the
  // first node and the later point for the last node.
  const isBackward = selection.isBackward()
  const firstPoint = isBackward ? focus : anchor
  const lastPoint = isBackward ? anchor : focus

  nodes.forEach((node, idx) => {
    if (!$isTextNode(node)) {
      return
    }
    let textNode = node
    if (idx === 0 && firstPoint.offset !== 0) {
      textNode = textNode.splitText(firstPoint.offset)[1] || textNode
    }
    if (idx === nodes.length - 1) {
      textNode = textNode.splitText(lastPoint.offset)[0] || textNode
    }
    textNode.setFormat(captured.format)
    textNode.setStyle(captured.style)
  })
}
