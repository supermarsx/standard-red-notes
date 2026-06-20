// A compact, dependency-free Markdown -> HTML renderer for the plain editor's
// preview mode. Output is always passed through sanitizeHtmlString before it is
// inserted into the DOM, so this only needs to produce structurally reasonable
// HTML, not security-hardened HTML.
//
// Native math: inline `$...$` / `\(...\)` and block `$$...$$` / `\[...\]` are
// rendered with KaTeX out of the box (no plugin required). markdownToHtml emits
// lightweight placeholder elements synchronously; ensureMathHydrator() installs
// a DOM observer that lazy-loads KaTeX (with its offline fonts/CSS) and fills
// them in once they are inserted. See markdownMath.ts for the detection rules.

import { ensureMathHydrator, mathPlaceholder, replaceInlineMath } from './markdownMath'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderInline(text: string): string {
  // Stash code spans, images, and links into opaque placeholders BEFORE running
  // emphasis, so emphasis regexes can never mangle code contents or URL/alt text
  // that contain `*` or `_` (e.g. http://x_y.com or snake_case identifiers).
  // The @@MD<n>@@ sentinel cannot collide with normal note text.
  const tokens: string[] = []
  const stash = (html: string): string => `@@MD${tokens.push(html) - 1}@@`

  let out = escapeHtml(text)
  // Code spans first: their contents (which may contain `$`) must be opaque to
  // the math scanner so math is never rendered inside inline code.
  out = out.replace(/`([^`]+)`/g, (_m, code) => stash(`<code>${code}</code>`))
  // Inline math ($...$, \(...\)). Stash the resulting placeholders so the
  // emphasis regexes below can't mangle a fallback span that contains * or _.
  out = replaceInlineMath(out).replace(
    /<span class="md-katex"[^>]*>[\s\S]*?<\/span>/g,
    (m) => stash(m),
  )
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => stash(`<img alt="${alt}" src="${url}" />`))
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
    stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`),
  )

  // Emphasis. Asterisks may be intraword (CommonMark); underscores only at word
  // boundaries so snake_case identifiers are not turned into <em>.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^\w_])__([^_]+)__(?![\w_])/g, '$1<strong>$2</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/(^|[^\w_])_([^_]+)_(?![\w_])/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  // Restore stashed tokens.
  out = out.replace(/@@MD(\d+)@@/g, (_m, index) => tokens[Number(index)] ?? '')
  return out
}

/**
 * Detects a block-math construct ($$...$$ or \[...\]) that begins on line
 * `start`. The opening delimiter must be the first non-whitespace on the line.
 * Supports both single-line (`$$x$$`) and multi-line blocks. Returns the inner
 * LaTeX and the index of the line holding the closing delimiter, or null.
 */
function matchBlockMath(lines: string[], start: number): { tex: string; endIndex: number } | null {
  const line = lines[start]

  const variants: { open: RegExp; closeToken: string; openToken: string }[] = [
    { open: /^\s*\$\$/, closeToken: '$$', openToken: '$$' },
    { open: /^\s*\\\[/, closeToken: '\\]', openToken: '\\[' },
  ]

  for (const { open, closeToken, openToken } of variants) {
    if (!open.test(line)) {
      continue
    }
    const afterOpen = line.slice(line.indexOf(openToken) + openToken.length)

    // Single-line block: closing delimiter on the same line.
    const sameLineClose = afterOpen.indexOf(closeToken)
    if (sameLineClose !== -1) {
      const tex = afterOpen.slice(0, sameLineClose).trim()
      if (tex.length > 0) {
        return { tex, endIndex: start }
      }
      // `$$` / `\[` followed immediately by close with nothing inside: not math.
      return null
    }

    // Multi-line block: collect until a line containing the closing delimiter.
    const buffer: string[] = [afterOpen]
    for (let j = start + 1; j < lines.length; j++) {
      const closeAt = lines[j].indexOf(closeToken)
      if (closeAt !== -1) {
        buffer.push(lines[j].slice(0, closeAt))
        const tex = buffer.join('\n').trim()
        return tex.length > 0 ? { tex, endIndex: j } : null
      }
      buffer.push(lines[j])
    }
    // Unterminated: do not treat as math, fall through to normal rendering.
    return null
  }

  return null
}

export function markdownToHtml(source: string): string {
  // Native math works out of the box: make sure the lazy KaTeX hydrator is
  // installed so any math placeholders this render produces get rendered once
  // they are inserted into the DOM. No-op outside the browser / after first call.
  ensureMathHydrator()

  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeBuffer: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = line.match(/^```/)
    if (fence) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`)
        codeBuffer = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuffer.push(line)
      continue
    }

    // Block math: $$ ... $$ or \[ ... \], either on a single line or spanning
    // several lines. Only treated as a block when the delimiter starts the line
    // (after optional indentation), so prose containing `$$` mid-sentence is
    // left to the inline path. Rendered in KaTeX display mode.
    const blockMath = matchBlockMath(lines, i)
    if (blockMath) {
      closeList()
      out.push(mathPlaceholder(blockMath.tex, true))
      i = blockMath.endIndex
      continue
    }

    if (/^\s*$/.test(line)) {
      closeList()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList()
      out.push('<hr />')
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      closeList()
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`)
      continue
    }

    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : ''
      out.push(`<li><input type="checkbox" disabled${checked} /> ${renderInline(task[2])}</li>`)
      continue
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/)
    if (unordered) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${renderInline(unordered[1])}</li>`)
      continue
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ordered) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${renderInline(ordered[1])}</li>`)
      continue
    }

    closeList()
    out.push(`<p>${renderInline(line)}</p>`)
  }

  closeList()
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`)
  }
  return out.join('\n')
}
