// A compact, dependency-free Markdown -> HTML renderer for the plain editor's
// preview mode. Output is always passed through sanitizeHtmlString before it is
// inserted into the DOM, so this only needs to produce structurally reasonable
// HTML, not security-hardened HTML.

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
  out = out.replace(/`([^`]+)`/g, (_m, code) => stash(`<code>${code}</code>`))
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

export function markdownToHtml(source: string): string {
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
