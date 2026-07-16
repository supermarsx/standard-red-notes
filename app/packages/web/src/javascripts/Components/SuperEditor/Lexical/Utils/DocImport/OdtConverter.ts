/**
 * ODT (OpenDocument Text) → Super import converter (web-only).
 *
 * Like `DocxConverter`, this reuses the existing HTML→Super seam: it unzips the
 * .odt with `@zip.js/zip.js` (already a web dependency), walks `content.xml`
 * with the DOM `DOMParser`, and emits plain HTML — resolving the automatic text
 * styles into `<strong>/<em>/…` and inlining `Pictures/*` as base64 `<img>` —
 * then hands that HTML to the injected `convertHTMLToSuper(html)`.
 *
 * ODF-only constructs (footnotes, comments, text boxes, exact fonts/spacing) are
 * flattened to their text or dropped; the note's readable content and structure
 * survive. This mirrors the export fidelity boundary in `.orchestration/plans/t46.md`.
 */
import { parseFileName } from '@standardnotes/utils'
import { Converter } from '@standardnotes/ui-services'

export const ODT_IMPORT_MIME_TYPE = 'application/vnd.oasis.opendocument.text'

// Decompression-bomb guards. The import pipeline caps the COMPRESSED .odt at
// `MaxImportFileSizeBytes` (50MB), but deflate can expand ~1000x, so a small archive
// can still decompress to gigabytes and exhaust memory. We reject past these
// DECOMPRESSED ceilings using each entry's central-directory `uncompressedSize`,
// checked BEFORE `getData` ever materializes the bytes. The ceilings are far above
// any legitimate note (a real content.xml is a few MB; images a few MB each) yet
// well under an OOM.
const MAX_ENTRY_DECOMPRESSED_BYTES = 100 * 1_000_000
const MAX_TOTAL_DECOMPRESSED_BYTES = 300 * 1_000_000
const MAX_ZIP_ENTRY_COUNT = 4096

const PICTURE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

interface TextStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  sub?: boolean
  sup?: boolean
  color?: string
  bgColor?: string
}

const escapeHtml = (text: string): string =>
  text.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))

const escapeAttr = (text: string): string =>
  text.replace(/[<>&"]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'))

/**
 * Resolve `office:automatic-styles` (+ any `<style:style>` in styles.xml, which
 * shares the same shape) into a name → TextStyle map for `text:span` resolution.
 */
const buildTextStyleMap = (docs: Document[]): Map<string, TextStyle> => {
  const map = new Map<string, TextStyle>()
  for (const doc of docs) {
    const styles = Array.from(doc.getElementsByTagName('style:style'))
    for (const style of styles) {
      if (style.getAttribute('style:family') !== 'text') {
        continue
      }
      const name = style.getAttribute('style:name')
      if (!name) {
        continue
      }
      const props = style.getElementsByTagName('style:text-properties')[0]
      if (!props) {
        continue
      }
      const ts: TextStyle = {}
      if (props.getAttribute('fo:font-weight') === 'bold') {
        ts.bold = true
      }
      const fontStyle = props.getAttribute('fo:font-style')
      if (fontStyle === 'italic' || fontStyle === 'oblique') {
        ts.italic = true
      }
      const underline = props.getAttribute('style:text-underline-style')
      if (underline && underline !== 'none') {
        ts.underline = true
      }
      const lineThrough = props.getAttribute('style:text-line-through-style')
      if (lineThrough && lineThrough !== 'none') {
        ts.strike = true
      }
      const fontName = props.getAttribute('style:font-name') || props.getAttribute('fo:font-family') || ''
      if (/courier|mono|consolas/i.test(fontName)) {
        ts.code = true
      }
      const position = props.getAttribute('style:text-position') || ''
      if (position.startsWith('sub')) {
        ts.sub = true
      } else if (position.startsWith('super')) {
        ts.sup = true
      }
      const color = props.getAttribute('fo:color')
      if (color) {
        ts.color = color
      }
      const bg = props.getAttribute('fo:background-color')
      if (bg && bg !== 'transparent') {
        ts.bgColor = bg
      }
      map.set(name, ts)
    }
  }
  return map
}

/** name → whether the list style is ordered (numbered). */
const buildListStyleMap = (docs: Document[]): Map<string, boolean> => {
  const map = new Map<string, boolean>()
  for (const doc of docs) {
    const lists = Array.from(doc.getElementsByTagName('text:list-style'))
    for (const list of lists) {
      const name = list.getAttribute('style:name')
      if (!name) {
        continue
      }
      map.set(name, list.getElementsByTagName('text:list-level-style-number').length > 0)
    }
  }
  return map
}

/**
 * Maximum element-nesting depth the walker will recurse through. ODF content is
 * self-nesting (`text:list` → `text:list-item` → `text:list`, and the `default`
 * branch recurses unknown containers), so a hostile or broken `.odt` with tens of
 * thousands of nested elements would otherwise overflow the JS stack. Because
 * `odfContentToHtml` runs OUTSIDE the zip `try/finally`, that `RangeError` would
 * abort the whole import — so past this depth we stop descending (emitting only the
 * element's immediate text) instead of throwing. Far deeper than any real document.
 */
const MAX_WALK_DEPTH = 200

class OdtHtmlWalker {
  constructor(
    private readonly textStyles: Map<string, TextStyle>,
    private readonly listStyles: Map<string, boolean>,
    private readonly pictures: Map<string, string>,
  ) {}

  private wrapSpan(inner: string, style: TextStyle): string {
    let html = inner
    if (style.code) {
      html = `<code>${html}</code>`
    }
    if (style.bold) {
      html = `<strong>${html}</strong>`
    }
    if (style.italic) {
      html = `<em>${html}</em>`
    }
    if (style.underline) {
      html = `<u>${html}</u>`
    }
    if (style.strike) {
      html = `<s>${html}</s>`
    }
    if (style.sub) {
      html = `<sub>${html}</sub>`
    }
    if (style.sup) {
      html = `<sup>${html}</sup>`
    }
    const css: string[] = []
    if (style.color) {
      css.push(`color: ${style.color}`)
    }
    if (style.bgColor) {
      css.push(`background-color: ${style.bgColor}`)
    }
    if (css.length > 0) {
      html = `<span style="${escapeAttr(css.join('; '))}">${html}</span>`
    }
    return html
  }

  /** Serialize an element's children (mixed text + element nodes) to HTML. */
  private children(el: Element, depth: number): string {
    let html = ''
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        html += escapeHtml(node.nodeValue || '')
      } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
        html += this.element(node as Element, depth)
      }
    })
    return html
  }

  /** Emit only an element's immediate text, without recursing (depth-cap fallback). */
  private immediateText(el: Element): string {
    let text = ''
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        text += escapeHtml(node.nodeValue || '')
      }
    })
    return text
  }

  private listItem(el: Element, depth: number): string {
    // A list-item holds the item's paragraph(s) plus any nested list. Emit the
    // paragraph content inline (no nested <p> inside <li>) and recurse lists.
    let html = ''
    el.childNodes.forEach((node) => {
      if (node.nodeType !== 1) {
        return
      }
      const child = node as Element
      const tag = child.tagName
      if (tag === 'text:p' || tag === 'text:h') {
        html += this.children(child, depth)
      } else if (tag === 'text:list') {
        html += this.element(child, depth)
      } else {
        html += this.element(child, depth)
      }
    })
    return `<li>${html}</li>`
  }

  element(el: Element, depth = 0): string {
    if (depth >= MAX_WALK_DEPTH) {
      // Depth guard: stop descending into pathologically nested content so a hostile
      // or broken .odt cannot overflow the stack and abort the whole import. Emit
      // the truncated immediate text rather than recursing (or throwing).
      return this.immediateText(el)
    }
    const nextDepth = depth + 1
    const tag = el.tagName
    switch (tag) {
      case 'text:h': {
        const rawLevel = parseInt(el.getAttribute('text:outline-level') || '1', 10)
        const level = Math.min(6, Math.max(1, isNaN(rawLevel) ? 1 : rawLevel))
        return `<h${level}>${this.children(el, nextDepth)}</h${level}>`
      }
      case 'text:p': {
        const styleName = el.getAttribute('text:style-name') || ''
        const inner = this.children(el, nextDepth)
        if (styleName === 'Preformatted_20_Text') {
          return `<pre>${inner}</pre>`
        }
        if (styleName === 'Quotation') {
          return `<blockquote>${inner}</blockquote>`
        }
        if (styleName === 'Horizontal_20_Line') {
          return '<hr />'
        }
        return `<p>${inner}</p>`
      }
      case 'text:span': {
        const styleName = el.getAttribute('text:style-name') || ''
        const inner = this.children(el, nextDepth)
        const style = this.textStyles.get(styleName)
        return style ? this.wrapSpan(inner, style) : inner
      }
      case 'text:a': {
        const href = el.getAttribute('xlink:href') || ''
        return `<a href="${escapeAttr(href)}">${this.children(el, nextDepth)}</a>`
      }
      case 'text:list': {
        const styleName = el.getAttribute('text:style-name') || ''
        const ordered = this.listStyles.get(styleName) === true
        const listTag = ordered ? 'ol' : 'ul'
        let items = ''
        el.childNodes.forEach((node) => {
          if (node.nodeType === 1 && (node as Element).tagName === 'text:list-item') {
            items += this.listItem(node as Element, nextDepth)
          }
        })
        return `<${listTag}>${items}</${listTag}>`
      }
      case 'table:table': {
        let rows = ''
        el.childNodes.forEach((node) => {
          if (node.nodeType === 1 && (node as Element).tagName === 'table:table-row') {
            rows += this.element(node as Element, nextDepth)
          }
        })
        return `<table><tbody>${rows}</tbody></table>`
      }
      case 'table:table-row': {
        let cells = ''
        el.childNodes.forEach((node) => {
          if (node.nodeType === 1 && (node as Element).tagName === 'table:table-cell') {
            cells += this.element(node as Element, nextDepth)
          }
        })
        return `<tr>${cells}</tr>`
      }
      case 'table:table-cell':
        return `<td>${this.children(el, nextDepth)}</td>`
      case 'table:table-column':
        return ''
      case 'draw:image': {
        const href = el.getAttribute('xlink:href') || ''
        const dataUri = this.pictures.get(href) || this.pictures.get(href.replace(/^\.?\//, ''))
        return dataUri ? `<img src="${escapeAttr(dataUri)}" />` : ''
      }
      case 'text:line-break':
        return '<br />'
      case 'text:tab':
        return ' '
      case 'text:s': {
        const count = parseInt(el.getAttribute('text:c') || '1', 10)
        return ' '.repeat(isNaN(count) ? 1 : Math.max(1, count))
      }
      default:
        // Never drop content — recurse unknown containers (draw:frame, etc.).
        return this.children(el, nextDepth)
    }
  }
}

/**
 * Walk an ODF `content.xml` document into an HTML string. Exported for tests: the
 * depth guard in {@link OdtHtmlWalker} can only be exercised against a DOM whose
 * nesting exceeds what jsdom's `DOMParser` will build (real browsers build far
 * deeper trees), so specs construct the deep document directly and call this.
 */
export const odfContentToHtml = (
  contentDoc: Document,
  stylesDoc: Document | null,
  pictures: Map<string, string>,
): string => {
  const docs = stylesDoc ? [contentDoc, stylesDoc] : [contentDoc]
  const textStyles = buildTextStyleMap(docs)
  const listStyles = buildListStyleMap(docs)
  const walker = new OdtHtmlWalker(textStyles, listStyles, pictures)

  const body = contentDoc.getElementsByTagName('office:text')[0]
  if (!body) {
    return ''
  }
  let html = ''
  body.childNodes.forEach((node) => {
    if (node.nodeType === 1) {
      html += walker.element(node as Element)
    }
  })
  return html
}

export class OdtConverter implements Converter {
  getImportType(): string {
    return 'odt'
  }

  getFileExtension(): string {
    return 'odt'
  }

  getSupportedFileTypes(): string[] {
    return [ODT_IMPORT_MIME_TYPE]
  }

  /** A .odt is a zip; read as text it still begins with the "PK" magic. */
  isContentValid(content: string): boolean {
    return content.startsWith('PK')
  }

  convert: Converter['convert'] = async (file, { insertNote, convertHTMLToSuper, canUseSuper }) => {
    if (!canUseSuper) {
      throw new Error('Importing an OpenDocument (.odt) requires the Super editor')
    }

    const arrayBuffer = await file.arrayBuffer()

    const zip = await import('@zip.js/zip.js')
    const { ZipReader, Uint8ArrayReader, TextWriter, Data64URIWriter } = zip
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(arrayBuffer)))

    let contentXml = ''
    let stylesXml = ''
    const pictures = new Map<string, string>()

    try {
      const entries = await reader.getEntries()
      if (entries.length > MAX_ZIP_ENTRY_COUNT) {
        throw new Error('The .odt file has too many entries to import safely — it may be malformed or too large')
      }
      let totalDecompressedBytes = 0
      for (const entry of entries) {
        if (entry.directory || !entry.getData) {
          continue
        }
        const isContent = entry.filename === 'content.xml'
        const isStyles = entry.filename === 'styles.xml'
        const isPicture = entry.filename.startsWith('Pictures/')
        if (!isContent && !isStyles && !isPicture) {
          continue
        }
        // Bound decompressed size BEFORE materializing the entry, per-entry and in
        // total, so a decompression bomb is rejected rather than buffered into memory.
        const uncompressedSize = entry.uncompressedSize ?? 0
        if (uncompressedSize > MAX_ENTRY_DECOMPRESSED_BYTES) {
          throw new Error('The .odt file is too large to import — an entry exceeds the maximum size')
        }
        totalDecompressedBytes += uncompressedSize
        if (totalDecompressedBytes > MAX_TOTAL_DECOMPRESSED_BYTES) {
          throw new Error('The .odt file is too large to import — its total content exceeds the maximum size')
        }
        if (isContent) {
          contentXml = await entry.getData(new TextWriter())
        } else if (isStyles) {
          stylesXml = await entry.getData(new TextWriter())
        } else {
          const ext = (entry.filename.split('.').pop() || '').toLowerCase()
          const mime = PICTURE_MIME_BY_EXT[ext] || 'application/octet-stream'
          pictures.set(entry.filename, await entry.getData(new Data64URIWriter(mime)))
        }
      }
    } finally {
      await reader.close()
    }

    if (!contentXml) {
      throw new Error('The .odt file has no content.xml — it may be corrupt')
    }

    const parser = new DOMParser()
    const contentDoc = parser.parseFromString(contentXml, 'application/xml')
    const stylesDoc = stylesXml ? parser.parseFromString(stylesXml, 'application/xml') : null

    const html = odfContentToHtml(contentDoc, stylesDoc, pictures)
    const text = convertHTMLToSuper(html)

    const { name } = parseFileName(file.name)
    const createdAtDate = file.lastModified ? new Date(file.lastModified) : new Date()
    const updatedAtDate = file.lastModified ? new Date(file.lastModified) : new Date()

    const note = await insertNote({
      createdAt: createdAtDate,
      updatedAt: updatedAtDate,
      title: name,
      text,
      useSuperIfPossible: true,
    })

    return {
      successful: [note],
      errored: [],
    }
  }
}
