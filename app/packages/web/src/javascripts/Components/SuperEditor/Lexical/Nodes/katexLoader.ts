/**
 * Lazily loads KaTeX so the (relatively heavy) math renderer is code-split and
 * only fetched when a formula is actually rendered. KaTeX renders entirely
 * offline: it ships its own fonts via the bundled stylesheet and does not call
 * out to any CDN. The stylesheet is imported alongside the library so the glyphs
 * line up correctly.
 */
let katexPromise: Promise<typeof import('katex').default> | undefined

export function loadKatex(): Promise<typeof import('katex').default> {
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
      ([m]) => m.default,
    )
  }
  return katexPromise
}

/**
 * Renders a LaTeX string to an HTML string. With `throwOnError: false`, KaTeX
 * never throws: invalid input is rendered as inline error markup (red text)
 * instead, so the caller never has to guard against an exception crashing the
 * editor.
 */
export async function renderLatexToString(equation: string, displayMode: boolean): Promise<string> {
  const katex = await loadKatex()
  return katex.renderToString(equation, {
    throwOnError: false,
    displayMode,
    output: 'html',
  })
}
