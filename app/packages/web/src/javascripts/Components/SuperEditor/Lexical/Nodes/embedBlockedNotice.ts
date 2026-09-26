/**
 * A no-JS fallback for an embed whose third-party <script> this app's
 * Content-Security-Policy refuses.
 *
 * WHY THIS EXISTS: these widgets live in an iframe built from `srcdoc`, and a
 * document created from a local scheme (`about:srcdoc`) INHERITS the embedding
 * page's CSP. The app shell is served with `script-src 'self' 'wasm-unsafe-eval'
 * 'sha256-<bootstrap>'`, so the framed `<script src="https://s3.tradingview.com/…">`
 * is refused and never even requested. Nothing is drawn, the iframe stays blank,
 * and a blank block is indistinguishable from an empty note — which is exactly why
 * this went unnoticed from 2026-07-03 (the commit that introduced the CSP) onward.
 *
 * WHY CSS-ONLY: the obvious fix — a small script in the framed document that
 * reports failure — is refused by the very same policy. Inline styles are not
 * (`style-src 'self' 'unsafe-inline'`), so the notice is revealed declaratively.
 *
 * HOW IT IS REVEALED: the widget container starts empty and the third-party script
 * fills it, so `#w:empty + #fb` shows the notice only while nothing has been
 * drawn. This deliberately does NOT stack the notice behind the widget: the
 * symbol-overview widget renders with `isTransparent: true`, so anything behind it
 * would show through a perfectly healthy chart. Adjacent-sibling + `:empty` are
 * both universally supported; if the widget injects somewhere other than the
 * container, the notice merely remains beside a working widget instead of hiding.
 */

const NOTICE_ID = 'fb'

/** Id the widget container must carry for the notice's selector to key off it. */
export const EMBED_WIDGET_ID = 'w'

/**
 * Styles for the notice. Appended to each embed document's existing inline
 * <style>; `#c` is the widget container wrapper, which must be a positioned
 * ancestor so the notice can fill it.
 */
export const EMBED_BLOCKED_STYLE =
  `#c{position:relative}` +
  `#${EMBED_WIDGET_ID}{height:100%;width:100%}` +
  `#${NOTICE_ID}{display:none}` +
  `#${EMBED_WIDGET_ID}:empty + #${NOTICE_ID}{` +
  `display:flex;position:absolute;inset:0;box-sizing:border-box;` +
  `align-items:center;justify-content:center;padding:12px;` +
  `font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;` +
  `color:#eadde0;background:#16090f;text-align:center}`

/**
 * Escape text for an HTML text node. Callers pass only their own copy plus an
 * already-sanitized symbol, so this is defence in depth rather than the boundary.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The notice element. Must be rendered as the IMMEDIATE next sibling of the
 * widget container (`#w`) for the adjacent-sibling selector above to match.
 */
export function embedBlockedNotice(message: string): string {
  return `<div id="${NOTICE_ID}">${escapeHtml(message)}</div>`
}
