// Native KaTeX math support for the dependency-free Markdown -> HTML renderer
// (see markdownToHtml.ts). Math works out of the box: no plugin or extension has
// to be installed. KaTeX is heavy, so it is *lazy-loaded* (mirroring the Super
// editor's katexLoader): markdownToHtml() emits lightweight, synchronous
// placeholder <span> elements that carry the raw LaTeX, and once those land in
// the DOM a self-installing hydrator fetches KaTeX (library + offline fonts/CSS)
// and swaps the placeholders for rendered math.
//
// Detection rules (kept deliberately conservative, matching common
// markdown-math conventions):
//   - Block math:  $$ ... $$   and  \[ ... \]   (may span lines; rendered in
//     display mode as its own block).
//   - Inline math: $ ... $     and  \( ... \)   (rendered inline).
//   - For the `$`/`$$` form the delimiter must be adjacent to a NON-space
//     character (e.g. `$x$` is math, `$ 5` / `5 $` is not). This keeps prose
//     prices like "it costs $5 and $7" from being treated as a math span.
//   - Inline `$...$` must not contain a newline.
//   - Math inside fenced code blocks or inline code spans is never rendered —
//     markdownToHtml stashes code BEFORE scanning for math, so code is opaque to
//     the math scanner.

export const MATH_PLACEHOLDER_CLASS = 'md-katex'
export const MATH_PENDING_ATTR = 'data-md-katex-tex'
export const MATH_DISPLAY_ATTR = 'data-md-katex-display'

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Builds the synchronous placeholder markup for a math span. The raw LaTeX is
 * carried on a data attribute (so the async hydrator can render it) and is also
 * shown as escaped fallback text, so that even if KaTeX never loads the user
 * still sees the original `$...$` source rather than nothing.
 */
export function mathPlaceholder(tex: string, displayMode: boolean): string {
  const tag = displayMode ? 'div' : 'span'
  const fallback = displayMode ? `$$${tex}$$` : `$${tex}$`
  return (
    `<${tag} class="${MATH_PLACEHOLDER_CLASS}"` +
    ` ${MATH_PENDING_ATTR}="${escapeHtmlAttr(tex)}"` +
    ` ${MATH_DISPLAY_ATTR}="${displayMode ? '1' : '0'}">` +
    `${escapeHtmlText(fallback)}</${tag}>`
  )
}

/**
 * Replaces every inline math span in a line of *already-escaped* text with a
 * placeholder. Returns the line unchanged if it contains no math.
 *
 * Operates on escaped text, so the `$` / `\(` `\)` delimiters are intact while
 * HTML-significant characters are already neutralised. The captured LaTeX is
 * un-escaped back to its source form before being placed on the data attribute
 * (KaTeX needs the real `<`, `>`, `&`).
 */
export function replaceInlineMath(escapedText: string): string {
  const unescape = (s: string): string =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

  let out = escapedText

  // \( ... \)  — no newline, non-empty.
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => mathPlaceholder(unescape(tex.trim()), false))

  // $ ... $  — single line, delimiters hug non-space, not empty, and the inner
  // text must not itself start/end with `$` (that is a `$$` block, handled
  // elsewhere). The negative lookbehind/lookahead on `$` avoids matching `$$`.
  // The inner group `[^$\n]*?[^\s$]` allows a single character (`$x$`) up to a
  // multi-character span, always ending in a non-space so `5 $` isn't matched.
  out = out.replace(/(?<![$\\])\$(?!\s)([^$\n]*?[^\s$])\$(?!\$)/g, (_m, tex) =>
    mathPlaceholder(unescape(tex), false),
  )

  return out
}

/**
 * Lazily loads KaTeX (library + bundled offline stylesheet/fonts) and renders a
 * LaTeX string to an HTML string. With `throwOnError: false` KaTeX never throws;
 * invalid input renders as red error markup instead.
 */
let katexPromise: Promise<typeof import('katex').default> | undefined
function loadKatex(): Promise<typeof import('katex').default> {
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default)
  }
  return katexPromise
}

async function renderPlaceholder(el: Element): Promise<void> {
  const tex = el.getAttribute(MATH_PENDING_ATTR)
  if (tex == null) {
    return
  }
  const displayMode = el.getAttribute(MATH_DISPLAY_ATTR) === '1'
  try {
    const katex = await loadKatex()
    // SECURITY: this is the one place that writes innerHTML *after* the markdown
    // output has already passed through sanitizeHtmlString, so KaTeX's own output
    // must be safe by construction. We pin `trust: false` and `strict: 'ignore'`
    // so the HTML/URL extensions (`\href`, `\url`, `\htmlData`, `\htmlClass`,
    // `\includegraphics`) stay DISABLED — they are the only KaTeX features that
    // can emit raw href/HTML. With these off, KaTeX HTML-escapes all user text
    // (e.g. `\text{<img onerror=...>}` becomes inert `&lt;img...`), so no markup
    // injected via `data-md-katex-tex` can execute. Do NOT set `trust: true`.
    el.innerHTML = katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
      output: 'html',
      trust: false,
      strict: 'ignore',
    })
  } catch {
    // Leave the escaped `$...$` fallback text in place on unexpected failure.
  }
  // Mark as done so the hydrator never reprocesses it.
  el.removeAttribute(MATH_PENDING_ATTR)
}

/**
 * Renders every not-yet-rendered math placeholder found within `root`.
 * Idempotent: a placeholder is only rendered once (the pending attribute is
 * removed after rendering).
 */
export function hydrateMathIn(root: ParentNode): void {
  const pending = root.querySelectorAll(`.${MATH_PLACEHOLDER_CLASS}[${MATH_PENDING_ATTR}]`)
  pending.forEach((el) => {
    void renderPlaceholder(el)
  })
}

/**
 * Installs (once) a document-wide MutationObserver that hydrates math
 * placeholders as soon as they are inserted into the DOM. This is what makes
 * native math "just work" for every consumer of markdownToHtml (the plain
 * editor preview, the shared-note viewer, etc.) without any of them having to
 * call into KaTeX themselves.
 */
let observerInstalled = false
export function ensureMathHydrator(): void {
  if (observerInstalled || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return
  }
  observerInstalled = true

  const scan = () => {
    if (document.querySelector(`.${MATH_PLACEHOLDER_CLASS}[${MATH_PENDING_ATTR}]`)) {
      hydrateMathIn(document)
    }
  }

  const observer = new MutationObserver(() => {
    scan()
  })

  const start = () => {
    observer.observe(document.body, { childList: true, subtree: true })
    scan()
  }

  if (document.body) {
    start()
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  }
}
