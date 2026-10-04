/**
 * Standard Red Notes — the persisted size of a Mermaid diagram block.
 *
 * A stored width is a SYNCED value: another client (or an older/newer build, or
 * a hand-edited note) may have written it, so every value is re-parsed and
 * re-clamped on read and a value that cannot be understood falls back to the
 * fitting default rather than being rendered back out. Nothing here throws, and
 * nothing here ever returns a string it did not itself construct — so a
 * malformed stored width can never reach a `style` attribute.
 *
 * Accepted spellings (case- and whitespace-insensitive):
 *   "50%"   -> 50 percent of the editor content column
 *   "420px" -> 420 CSS pixels
 *   "420"   -> a BARE NUMBER IS TREATED AS PIXELS. This matches the HTML
 *              `width` attribute and the `width` already persisted on Lexical
 *              table cells (a plain number of pixels), and is what a user
 *              typing into a width box means by "420". A bare number is NOT
 *              treated as a percentage: silently turning "420" into 420% would
 *              invent a size the user never asked for.
 *
 * Anything else — "auto", "50 px", "half", "", "-20%", "1e3px", NaN, a number,
 * an object, null — is unparseable and yields `null`, i.e. "fit the container".
 */

export const MERMAID_WIDTH_UNITS = ['%', 'px'] as const
export type MermaidWidthUnit = (typeof MERMAID_WIDTH_UNITS)[number]

export type MermaidWidth = {
  value: number
  unit: MermaidWidthUnit
}

/** A percentage below this is not a diagram any more, just a sliver. */
export const MIN_MERMAID_WIDTH_PERCENT = 10
export const MAX_MERMAID_WIDTH_PERCENT = 100

/** Mirrors MinImageWidth in ImageTools: the smallest resizable block width. */
export const MIN_MERMAID_WIDTH_PX = 80
/** Far beyond any real editor column; only there to bound absurd stored data. */
export const MAX_MERMAID_WIDTH_PX = 4000

/** Bounds for the persisted preview-box height (px). */
export const MIN_MERMAID_HEIGHT_PX = 80
export const MAX_MERMAID_HEIGHT_PX = 2000

/**
 * `<digits>[.<digits>]` followed by an optional unit. Deliberately strict:
 * no sign, no exponent, no internal space, no leading `.`, nothing trailing.
 */
const WIDTH_PATTERN = /^(\d+(?:\.\d+)?)(%|px)?$/

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Round to at most 2 decimals so "33.333333%" round-trips as "33.33%". */
const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * Parse a stored/typed width into a clamped {value, unit}, or `null` for
 * "no width — fit the container". Never throws for any input.
 */
export function parseMermaidWidth(raw: unknown): MermaidWidth | null {
  if (typeof raw !== 'string') {
    return null
  }
  const match = WIDTH_PATTERN.exec(raw.trim().toLowerCase())
  if (!match) {
    return null
  }
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed)) {
    return null
  }
  // No unit means pixels — see the module comment for why not percent.
  const unit: MermaidWidthUnit = match[2] === '%' ? '%' : 'px'
  const value =
    unit === '%'
      ? clamp(round2(parsed), MIN_MERMAID_WIDTH_PERCENT, MAX_MERMAID_WIDTH_PERCENT)
      : clamp(Math.round(parsed), MIN_MERMAID_WIDTH_PX, MAX_MERMAID_WIDTH_PX)
  return { value, unit }
}

/**
 * The canonical string form stored on the node and handed to CSS. Built here
 * from a number and a known unit, never passed through from input, which is
 * what makes "a malformed stored value is never rendered back out" true by
 * construction.
 */
export function formatMermaidWidth(width: MermaidWidth | null | undefined): string | undefined {
  if (!width) {
    return undefined
  }
  return `${width.value}${width.unit}`
}

/**
 * Parse-then-format in one step: the normalizer used on import and before
 * persisting. Returns `undefined` for "fit the container".
 */
export function normalizeMermaidWidth(raw: unknown): string | undefined {
  return formatMermaidWidth(parseMermaidWidth(raw))
}

/**
 * Clamp a persisted preview-box height. `undefined`/unparseable means
 * "auto-fit the height to the diagram".
 */
export function normalizeMermaidHeight(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return undefined
  }
  return clamp(Math.round(raw), MIN_MERMAID_HEIGHT_PX, MAX_MERMAID_HEIGHT_PX)
}

/**
 * Convert a dragged pixel width into the stored form, keeping the unit the
 * block is already using: dragging a block sized in `%` keeps it in `%` (so it
 * stays responsive) instead of silently converting it to pixels.
 */
export function widthFromDrag(pixels: number, container: number, currentUnit: MermaidWidthUnit): string | undefined {
  if (currentUnit === '%' && container > 0) {
    return normalizeMermaidWidth(`${round2((pixels / container) * 100)}%`)
  }
  return normalizeMermaidWidth(`${Math.round(pixels)}px`)
}
