/**
 * Injects (once) the CSS that styles search match highlights.
 *
 * The base theme (Lexical/Theme/base.scss) already ships a subtle highlight where the
 * active and non-active matches differ only by opacity. To make the "find" experience
 * easier to scan, this stylesheet strengthens the distinction:
 *
 * - every match gets a clearly visible warm highlight,
 * - the *active* match gets a stronger, accented background plus an outline so the
 *   currently-focused result stands out from the rest at a glance.
 *
 * These rules are appended after the theme stylesheet (they are injected at runtime when
 * the search UI mounts), so they win on equal specificity and override the base look
 * without us having to edit the shared theme file.
 *
 * For the CSS Custom Highlight API path we also bump the active highlight's `priority`
 * (see SearchHighlightRenderer) so the active range always paints on top of the
 * all-matches highlight even though a range can belong to both highlight registries.
 */

export const SEARCH_HIGHLIGHT_STYLE_ELEMENT_ID = 'super-search-highlight-styles'

const STYLES = `
/* All matches (CSS Custom Highlight API) */
::highlight(search-results) {
  background-color: color-mix(in srgb, var(--sn-stylekit-warning-color, #f5a623), transparent 55%);
}

/* Active match (CSS Custom Highlight API) */
::highlight(active-search-result) {
  background-color: color-mix(in srgb, var(--sn-stylekit-info-color), transparent 15%);
  color: var(--sn-stylekit-info-contrast-color);
}

/* Fallback (overlay rectangles) for browsers without the Custom Highlight API */
.search-highlight {
  background-color: color-mix(in srgb, var(--sn-stylekit-warning-color, #f5a623), transparent 55%);
  border-radius: 2px;
}
.active-search-highlight {
  background-color: color-mix(in srgb, var(--sn-stylekit-info-color), transparent 15%);
  outline: 2px solid var(--sn-stylekit-info-color);
  outline-offset: 0;
  border-radius: 2px;
}
`

/**
 * Ensures the highlight stylesheet is present in the document head exactly once.
 * Safe to call repeatedly; subsequent calls are no-ops.
 */
export function ensureSearchHighlightStyles(): void {
  if (typeof document === 'undefined') {
    return
  }
  if (document.getElementById(SEARCH_HIGHLIGHT_STYLE_ELEMENT_ID)) {
    return
  }
  const style = document.createElement('style')
  style.id = SEARCH_HIGHLIGHT_STYLE_ELEMENT_ID
  style.textContent = STYLES
  document.head.appendChild(style)
}
