/**
 * OpenDocument Text (.odt) generator. Consumes the shared `DocBlock[]` DocModel
 * and hand-builds a valid ODF package: `mimetype` (STORED/uncompressed and FIRST,
 * per the ODF spec), `content.xml`, `styles.xml`, `meta.xml`,
 * `META-INF/manifest.xml`, and any embedded `Pictures/*`. Opens in
 * LibreOffice/OpenOffice, Word and Google Docs.
 *
 * There is no small, maintained ODT lib worth a dependency — ODT is a
 * well-specified zip of XML — so this is hand-rolled and zipped with the
 * already-present `@zip.js/zip.js` (dynamic import; the mimetype-first/stored
 * requirement is met via the low-level `ZipWriter` with `{ level: 0 }`).
 */
import { DocBlock, Inline, ListModel } from './DocModel'

export const ODT_MIME_TYPE = 'application/vnd.oasis.opendocument.text'

const xmlEscape = (text: string): string =>
  text.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))

const attrEscape = (text: string): string =>
  text.replace(/[<>&"]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;'))

const base64ToBytes = (b64: string): Uint8Array => {
  const clean = b64.trim()
  if (typeof atob === 'function') {
    const binary = atob(clean)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

const PICTURE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

interface Picture {
  path: string
  bytes: Uint8Array
  mime: string
}

/** Accumulates automatic styles + pictures while producing the body XML. */
class OdtBuilder {
  // Map from a style signature to its generated style name (dedup).
  private readonly textStyles = new Map<string, string>()
  private readonly paraStyles = new Map<string, string>()
  private textStyleXml: string[] = []
  private paraStyleXml: string[] = []
  pictures: Picture[] = []
  private textCounter = 0
  private paraCounter = 0
  private pictureCounter = 0
  private needsLists = false

  private registerTextStyle(inline: Extract<Inline, { kind: 'text' }>): string {
    const props: string[] = []
    if (inline.bold) {
      props.push('fo:font-weight="bold"')
    }
    if (inline.italic) {
      props.push('fo:font-style="italic"')
    }
    if (inline.underline) {
      props.push(
        'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"',
      )
    }
    if (inline.strike) {
      props.push('style:text-line-through-style="solid"')
    }
    if (inline.code) {
      props.push('style:font-name="Courier New" fo:font-family="&apos;Courier New&apos;"')
    }
    if (inline.sub) {
      props.push('style:text-position="sub 58%"')
    }
    if (inline.sup) {
      props.push('style:text-position="super 58%"')
    }
    if (inline.color) {
      props.push(`fo:color="#${inline.color}"`)
    }
    if (inline.bgColor) {
      props.push(`fo:background-color="#${inline.bgColor}"`)
    }
    if (props.length === 0) {
      return ''
    }
    const signature = props.join(' ')
    const existing = this.textStyles.get(signature)
    if (existing) {
      return existing
    }
    const name = `T${++this.textCounter}`
    this.textStyles.set(signature, name)
    this.textStyleXml.push(
      `<style:style style:name="${name}" style:family="text"><style:text-properties ${signature}/></style:style>`,
    )
    return name
  }

  private registerParagraphStyle(block: Extract<DocBlock, { kind: 'paragraph' }>): string {
    const paraProps: string[] = []
    const textProps: string[] = []
    if (block.align) {
      paraProps.push(`fo:text-align="${block.align === 'justify' ? 'justify' : block.align}"`)
    }
    if (block.indent) {
      paraProps.push(`fo:margin-left="${(block.indent * 0.6).toFixed(2)}cm"`)
    }
    if (block.style?.spaceBeforeTwips != null) {
      paraProps.push(`fo:margin-top="${(block.style.spaceBeforeTwips / 20).toFixed(1)}pt"`)
    }
    if (block.style?.spaceAfterTwips != null) {
      paraProps.push(`fo:margin-bottom="${(block.style.spaceAfterTwips / 20).toFixed(1)}pt"`)
    }
    if (block.style?.fontSizePt != null) {
      textProps.push(`fo:font-size="${block.style.fontSizePt.toFixed(1)}pt"`)
    }
    if (block.style?.bold) {
      textProps.push('fo:font-weight="bold"')
    }
    if (block.style?.italic) {
      textProps.push('fo:font-style="italic"')
    }
    if (block.style?.color) {
      textProps.push(`fo:color="#${block.style.color}"`)
    }
    if (paraProps.length === 0 && textProps.length === 0) {
      return ''
    }
    const signature = `p:${paraProps.join(' ')}|t:${textProps.join(' ')}`
    const existing = this.paraStyles.get(signature)
    if (existing) {
      return existing
    }
    const name = `P${++this.paraCounter}`
    this.paraStyles.set(signature, name)
    const paraPart = paraProps.length > 0 ? `<style:paragraph-properties ${paraProps.join(' ')}/>` : ''
    const textPart = textProps.length > 0 ? `<style:text-properties ${textProps.join(' ')}/>` : ''
    this.paraStyleXml.push(
      `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard">${paraPart}${textPart}</style:style>`,
    )
    return name
  }

  private registerPicture(dataB64: string, mime: string): string {
    const ext = PICTURE_EXT_BY_MIME[mime.toLowerCase()] || 'bin'
    const path = `Pictures/image${++this.pictureCounter}.${ext}`
    this.pictures.push({ path, bytes: base64ToBytes(dataB64), mime })
    return path
  }

  private imageXml(image: Extract<Inline, { kind: 'image' }>): string {
    if (image.dataB64 && image.mime) {
      const path = this.registerPicture(image.dataB64, image.mime)
      const name = `Image${this.pictureCounter}`
      return (
        `<draw:frame draw:name="${name}" text:anchor-type="as-char" svg:width="12cm" svg:height="9cm" draw:z-index="0">` +
        `<draw:image xlink:href="${attrEscape(path)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
        '</draw:frame>'
      )
    }
    if (image.src) {
      return `<text:a xlink:type="simple" xlink:href="${attrEscape(image.src)}">${xmlEscape(image.alt || image.src)}</text:a>`
    }
    return xmlEscape(image.alt ? `[${image.alt}]` : '[image]')
  }

  private inlineToXml(inline: Inline): string {
    switch (inline.kind) {
      case 'text': {
        const name = this.registerTextStyle(inline)
        const escaped = xmlEscape(inline.text)
        return name ? `<text:span text:style-name="${name}">${escaped}</text:span>` : escaped
      }
      case 'link': {
        const inner = inline.children.map((c) => this.inlineToXml(c)).join('')
        return `<text:a xlink:type="simple" xlink:href="${attrEscape(inline.url)}">${inner}</text:a>`
      }
      case 'image':
        return this.imageXml(inline)
      case 'lineBreak':
        return '<text:line-break/>'
    }
  }

  private inlinesToXml(inlines: Inline[]): string {
    return inlines.map((i) => this.inlineToXml(i)).join('')
  }

  private listToXml(list: ListModel): string {
    this.needsLists = true
    const styleName = list.ordered ? 'Ln' : 'Lb'
    const items = list.items
      .map((item) => {
        const box = list.check ? (item.checked ? '☑ ' : '☐ ') : ''
        const para = `<text:p>${xmlEscape(box)}${this.inlinesToXml(item.inlines)}</text:p>`
        const sub = item.children ? this.listToXml(item.children) : ''
        return `<text:list-item>${para}${sub}</text:list-item>`
      })
      .join('')
    return `<text:list text:style-name="${styleName}">${items}</text:list>`
  }

  blockToXml(block: DocBlock): string {
    switch (block.kind) {
      case 'paragraph': {
        const style = this.registerParagraphStyle(block)
        const attr = style ? ` text:style-name="${style}"` : ''
        return `<text:p${attr}>${this.inlinesToXml(block.inlines)}</text:p>`
      }
      case 'heading':
        return `<text:h text:style-name="Heading_20_${block.level}" text:outline-level="${block.level}">${this.inlinesToXml(block.inlines)}</text:h>`
      case 'quote':
        return `<text:p text:style-name="Quotation">${this.inlinesToXml(block.inlines)}</text:p>`
      case 'list':
        return this.listToXml(block.list)
      case 'code':
        return block.text
          .split(/\r?\n/)
          .map((line) => `<text:p text:style-name="Preformatted_20_Text">${xmlEscape(line)}</text:p>`)
          .join('')
      case 'table':
        return this.tableToXml(block.rows)
      case 'image':
        return `<text:p>${this.imageXml(block)}</text:p>`
      case 'hr':
        return '<text:p text:style-name="Horizontal_20_Line"/>'
      case 'pageBreak':
        return '<text:p text:style-name="PageBreak"/>'
      default:
        return ''
    }
  }

  private tableToXml(rows: DocBlock[][][]): string {
    const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
    const columns = `<table:table-column table:number-columns-repeated="${Math.max(1, colCount)}"/>`
    const rowsXml = rows
      .map((cells) => {
        const cellsXml = cells
          .map((cellBlocks) => {
            const inner = cellBlocks.map((b) => this.blockToXml(b)).join('') || '<text:p/>'
            return `<table:table-cell office:value-type="string">${inner}</table:table-cell>`
          })
          .join('')
        return `<table:table-row>${cellsXml}</table:table-row>`
      })
      .join('')
    return `<table:table table:style-name="Tbl">${columns}${rowsXml}</table:table>`
  }

  /** Automatic styles block for content.xml (text/paragraph styles + list styles). */
  automaticStylesXml(): string {
    const listStyles = this.needsLists ? this.listStyleDefinitions() : ''
    const tableStyle =
      '<style:style style:name="Tbl" style:family="table"><style:table-properties table:border-model="collapsing" style:width="17cm" fo:margin-top="0.1cm" fo:margin-bottom="0.1cm"/></style:style>'
    return `<office:automatic-styles>${this.textStyleXml.join('')}${this.paraStyleXml.join('')}${tableStyle}${listStyles}</office:automatic-styles>`
  }

  private listStyleDefinitions(): string {
    const bulletLevels: string[] = []
    const numberLevels: string[] = []
    for (let level = 1; level <= 9; level++) {
      const indent = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" fo:margin-left="${(level * 0.6).toFixed(1)}cm" fo:text-indent="-0.6cm"/></style:list-level-properties>`
      bulletLevels.push(
        `<text:list-level-style-bullet text:level="${level}" text:bullet-char="•">${indent}</text:list-level-style-bullet>`,
      )
      numberLevels.push(
        `<text:list-level-style-number text:level="${level}" style:num-format="1" style:num-suffix=".">${indent}</text:list-level-style-number>`,
      )
    }
    return (
      `<text:list-style style:name="Lb">${bulletLevels.join('')}</text:list-style>` +
      `<text:list-style style:name="Ln">${numberLevels.join('')}</text:list-style>`
    )
  }
}

const CONTENT_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ')

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${CONTENT_NS} office:version="1.2">
<office:styles>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="28pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="22pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_3" style:display-name="Heading 3" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_4" style:display-name="Heading 4" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="15pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_5" style:display-name="Heading 5" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="13pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_6" style:display-name="Heading 6" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="12pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Quotation" style:display-name="Quotation" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-left="1cm" fo:margin-right="1cm"/><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties style:font-name="Courier New" fo:font-family="&apos;Courier New&apos;"/></style:style>
<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:border-bottom="0.5pt solid #999999" fo:padding-bottom="0.05cm" fo:margin-top="0.1cm" fo:margin-bottom="0.1cm"/></style:style>
<style:style style:name="PageBreak" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:break-before="page"/></style:style>
</office:styles>
</office:document-styles>`

const META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${CONTENT_NS} xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
<office:meta><meta:generator>Standard Red Notes</meta:generator></office:meta>
</office:document-meta>`

const buildContentXml = (builder: OdtBuilder, bodyXml: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${CONTENT_NS} office:version="1.2">
${builder.automaticStylesXml()}
<office:body><office:text>${bodyXml}</office:text></office:body>
</office:document-content>`

const buildManifestXml = (pictures: Picture[]): string => {
  const pictureEntries = pictures
    .map((p) => `<manifest:file-entry manifest:full-path="${attrEscape(p.path)}" manifest:media-type="${p.mime}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${ODT_MIME_TYPE}"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
${pictureEntries}
</manifest:manifest>`
}

/** Build a valid .odt Blob from the shared DocModel. */
export const buildOdtBlob = async (blocks: DocBlock[]): Promise<Blob> => {
  const builder = new OdtBuilder()
  const bodyXml = blocks.map((block) => builder.blockToXml(block)).join('')
  const contentXml = buildContentXml(builder, bodyXml)
  const manifestXml = buildManifestXml(builder.pictures)

  const zip = await import('@zip.js/zip.js')
  const { ZipWriter, BlobWriter, TextReader, Uint8ArrayReader } = zip
  const writer = new ZipWriter(new BlobWriter(ODT_MIME_TYPE))

  // ODF spec: mimetype MUST be the first entry and STORED (uncompressed).
  await writer.add('mimetype', new TextReader(ODT_MIME_TYPE), { level: 0, dataDescriptor: false })
  await writer.add('content.xml', new TextReader(contentXml))
  await writer.add('styles.xml', new TextReader(STYLES_XML))
  await writer.add('meta.xml', new TextReader(META_XML))
  for (const picture of builder.pictures) {
    await writer.add(picture.path, new Uint8ArrayReader(picture.bytes))
  }
  await writer.add('META-INF/manifest.xml', new TextReader(manifestXml))

  const blob = (await writer.close()) as Blob
  return new Blob([blob], { type: ODT_MIME_TYPE })
}
