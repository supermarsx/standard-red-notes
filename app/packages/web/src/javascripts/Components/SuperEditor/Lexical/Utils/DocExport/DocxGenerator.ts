/**
 * Structured DOCX (real OOXML) generator. Consumes the shared `DocBlock[]`
 * DocModel and emits a Word document via the installed `docx` v9 library
 * (`Packer.toBlob`). Unlike the removed altChunk hack, the output is genuine
 * WordprocessingML, so it opens faithfully in Word, LibreOffice, Google Docs and
 * Pages — not Word only.
 *
 * `docx` is loaded with a dynamic `import()` so it stays code-split (matching the
 * spreadsheet / PDF / zip.js precedent — heavy export libs load on demand).
 */
import { DocBlock, Inline, ListModel } from './DocModel'
import type { HeaderFooterAlign, PageNumberFormat } from '../../../Layout/layoutSettings'
import {
  PAGE_TOKEN,
  TOTAL_TOKEN,
  resolveFont,
  type HeaderFooterStyle,
  type PageLayoutOptions,
} from './PageLayoutOptions'

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Formatting inherited from an enclosing block style / hyperlink onto text runs. */
interface InheritedRunStyle {
  bold?: boolean
  italic?: boolean
  color?: string
  fontSizePt?: number
  hyperlink?: boolean
}

type Docx = typeof import('docx')
type DocxParagraph = InstanceType<Docx['Paragraph']>
type DocxTable = InstanceType<Docx['Table']>
type DocxRunChild =
  InstanceType<Docx['TextRun']> | InstanceType<Docx['ExternalHyperlink']> | InstanceType<Docx['ImageRun']>

interface NumberingLevel {
  level: number
  format: string
  text: string
  alignment: string
  style: { paragraph: { indent: { left: number; hanging: number } } }
}

interface Ctx {
  docx: Docx
  numberingConfigs: { reference: string; levels: NumberingLevel[] }[]
  orderedRefCount: number
}

const IMAGE_TYPE_BY_MIME: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

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

const createOrderedNumbering = (ctx: Ctx): string => {
  const { LevelFormat, AlignmentType } = ctx.docx
  const reference = `ord-${ctx.orderedRefCount++}`
  const levels: NumberingLevel[] = []
  for (let level = 0; level < 9; level++) {
    levels.push({
      level,
      format: LevelFormat.DECIMAL,
      text: `%${level + 1}.`,
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: (level + 1) * 720, hanging: 360 } } },
    })
  }
  ctx.numberingConfigs.push({ reference, levels })
  return reference
}

const makeTextRun = (
  ctx: Ctx,
  inline: Extract<Inline, { kind: 'text' }>,
  inherited?: InheritedRunStyle,
): DocxRunChild => {
  const { TextRun, ShadingType } = ctx.docx
  const opts: Record<string, unknown> = { text: inline.text }
  if (inline.bold || inherited?.bold) {
    opts.bold = true
  }
  if (inline.italic || inherited?.italic) {
    opts.italics = true
  }
  if (inline.underline) {
    opts.underline = {}
  }
  if (inline.strike) {
    opts.strike = true
  }
  if (inline.sub) {
    opts.subScript = true
  }
  if (inline.sup) {
    opts.superScript = true
  }
  const color = inline.color || inherited?.color
  if (color) {
    opts.color = color
  }
  if (inline.bgColor) {
    opts.shading = { type: ShadingType.CLEAR, color: 'auto', fill: inline.bgColor }
  }
  if (inline.code) {
    opts.font = 'Courier New'
  }
  if (inherited?.fontSizePt) {
    opts.size = Math.round(inherited.fontSizePt * 2)
  }
  if (inherited?.hyperlink) {
    opts.style = 'Hyperlink'
  }
  return new TextRun(opts)
}

const makeImageRun = (ctx: Ctx, image: Extract<Inline, { kind: 'image' }>): DocxRunChild => {
  const { ImageRun, TextRun, ExternalHyperlink } = ctx.docx
  if (image.dataB64 && image.mime) {
    const type = IMAGE_TYPE_BY_MIME[image.mime.toLowerCase()]
    if (type) {
      try {
        return new ImageRun({
          type,
          data: base64ToBytes(image.dataB64),
          transformation: { width: 400, height: 300 },
        } as ConstructorParameters<Docx['ImageRun']>[0])
      } catch {
        // fall through to the text/hyperlink representation
      }
    }
  }
  // Remote (URL-only) or unsupported image: link to it with alt text so nothing is lost.
  if (image.src) {
    return new ExternalHyperlink({
      link: image.src,
      children: [new TextRun({ text: image.alt || image.src, style: 'Hyperlink' })],
    })
  }
  return new TextRun({ text: image.alt ? `[${image.alt}]` : '[image]' })
}

const inlinesToRuns = (ctx: Ctx, inlines: Inline[], inherited?: InheritedRunStyle): DocxRunChild[] => {
  const { TextRun, ExternalHyperlink } = ctx.docx
  const runs: DocxRunChild[] = []
  for (const inline of inlines) {
    switch (inline.kind) {
      case 'text':
        runs.push(makeTextRun(ctx, inline, inherited))
        break
      case 'link':
        runs.push(
          new ExternalHyperlink({
            link: inline.url,
            children: inlinesToRuns(ctx, inline.children, { ...inherited, hyperlink: true }) as InstanceType<
              Docx['TextRun']
            >[],
          }),
        )
        break
      case 'image':
        runs.push(makeImageRun(ctx, inline))
        break
      case 'lineBreak':
        runs.push(new TextRun({ break: 1 }))
        break
    }
  }
  return runs
}

const emitList = (ctx: Ctx, list: ListModel, level: number, inheritedOrderedRef?: string): DocxParagraph[] => {
  const { Paragraph, TextRun } = ctx.docx
  let ref = inheritedOrderedRef
  if (list.ordered && !ref) {
    ref = createOrderedNumbering(ctx)
  }
  const paragraphs: DocxParagraph[] = []
  for (const item of list.items) {
    const runs = inlinesToRuns(ctx, item.inlines)
    if (list.check) {
      const box = item.checked ? '☑ ' : '☐ '
      paragraphs.push(
        new Paragraph({ children: [new TextRun({ text: box }), ...runs], indent: { left: (level + 1) * 360 } }),
      )
    } else if (list.ordered && ref) {
      paragraphs.push(new Paragraph({ children: runs, numbering: { reference: ref, level } }))
    } else {
      paragraphs.push(new Paragraph({ children: runs, bullet: { level } }))
    }
    if (item.children) {
      paragraphs.push(...emitList(ctx, item.children, level + 1, list.ordered ? ref : undefined))
    }
  }
  return paragraphs
}

const blockToDocx = (ctx: Ctx, block: DocBlock): (DocxParagraph | DocxTable)[] => {
  const {
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    PageBreak,
  } = ctx.docx

  const alignmentOf = (align?: string) => {
    switch (align) {
      case 'center':
        return AlignmentType.CENTER
      case 'right':
        return AlignmentType.RIGHT
      case 'justify':
        return AlignmentType.JUSTIFIED
      case 'left':
        return AlignmentType.LEFT
      default:
        return undefined
    }
  }

  switch (block.kind) {
    case 'paragraph': {
      const inherited: InheritedRunStyle = {
        bold: block.style?.bold,
        italic: block.style?.italic,
        color: block.style?.color,
        fontSizePt: block.style?.fontSizePt,
      }
      const opts: Record<string, unknown> = { children: inlinesToRuns(ctx, block.inlines, inherited) }
      const alignment = alignmentOf(block.align)
      if (alignment) {
        opts.alignment = alignment
      }
      if (block.indent) {
        opts.indent = { left: block.indent * 720 }
      }
      if (block.style?.spaceBeforeTwips != null || block.style?.spaceAfterTwips != null) {
        opts.spacing = { before: block.style?.spaceBeforeTwips ?? 0, after: block.style?.spaceAfterTwips ?? 0 }
      }
      return [new Paragraph(opts)]
    }
    case 'heading': {
      const level = block.level
      const headingMap = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ]
      const inherited: InheritedRunStyle = { color: block.style?.color }
      const opts: Record<string, unknown> = {
        heading: headingMap[level - 1],
        children: inlinesToRuns(ctx, block.inlines, inherited),
      }
      const alignment = alignmentOf(block.align)
      if (alignment) {
        opts.alignment = alignment
      }
      return [new Paragraph(opts)]
    }
    case 'quote': {
      return [
        new Paragraph({
          children: inlinesToRuns(ctx, block.inlines, { italic: true }),
          indent: { left: 720 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, space: 12, color: 'CCCCCC' } },
        }),
      ]
    }
    case 'list':
      return emitList(ctx, block.list, 0)
    case 'code': {
      const lines = block.text.split(/\r?\n/)
      return lines.map(
        (line) =>
          new Paragraph({
            children: [new TextRun({ text: line, font: 'Courier New' })],
            shading: { type: ctx.docx.ShadingType.CLEAR, color: 'auto', fill: 'F5F5F5' },
          }),
      )
    }
    case 'table': {
      const singleBorder = { style: BorderStyle.SINGLE, size: 1, color: '999999' }
      const rows = block.rows.map(
        (cells) =>
          new TableRow({
            children: cells.map(
              (cellBlocks) =>
                new TableCell({
                  children: (() => {
                    const cellChildren = cellBlocks.flatMap((b) => blockToDocx(ctx, b))
                    return cellChildren.length > 0 ? cellChildren : [new Paragraph({ children: [] })]
                  })(),
                }),
            ),
          }),
      )
      if (rows.length === 0) {
        return [new Paragraph({ children: [] })]
      }
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: singleBorder,
            bottom: singleBorder,
            left: singleBorder,
            right: singleBorder,
            insideHorizontal: singleBorder,
            insideVertical: singleBorder,
          },
          rows,
        }),
      ]
    }
    case 'image': {
      return [new Paragraph({ children: [makeImageRun(ctx, block)] })]
    }
    case 'hr': {
      return [
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: '999999' } },
        }),
      ]
    }
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })]
    default:
      return []
  }
}

const docxAlignment = (docx: Docx, align: HeaderFooterAlign) => {
  switch (align) {
    case 'left':
      return docx.AlignmentType.LEFT
    case 'right':
      return docx.AlignmentType.RIGHT
    default:
      return docx.AlignmentType.CENTER
  }
}

/**
 * The `TextRun` options a band's style contributes. Absent fields ⇒ empty opts ⇒
 * the run is byte-identical to the un-styled baseline. `color` drops its leading
 * `#` (docx wants a bare `rrggbb`); size is in half-points (pt × 2).
 */
const hfRunOpts = (style: HeaderFooterStyle): Record<string, unknown> => {
  const opts: Record<string, unknown> = {}
  const font = resolveFont(style.fontId).docx
  if (font) {
    opts.font = font
  }
  if (style.fontSizePt != null) {
    opts.size = Math.round(style.fontSizePt * 2)
  }
  if (style.bold) {
    opts.bold = true
  }
  if (style.italic) {
    opts.italics = true
  }
  if (style.underline) {
    opts.underline = {}
  }
  if (style.color) {
    opts.color = style.color.replace(/^#/, '')
  }
  return opts
}

/**
 * Turn a header/footer text (which may embed the `{page}`/`{total}` tokens) into
 * docx runs: literal spans become plain TextRuns; the tokens become PageNumber
 * fields (CURRENT / TOTAL_PAGES) so the live page number renders in Word. Every
 * run also carries the band's style opts (empty ⇒ unchanged baseline output).
 */
const headerFooterTextRuns = (
  docx: Docx,
  text: string,
  style: HeaderFooterStyle = {},
): InstanceType<Docx['TextRun']>[] => {
  const { TextRun, PageNumber } = docx
  const opts = hfRunOpts(style)
  const runs: InstanceType<Docx['TextRun']>[] = []
  for (const part of text.split(/(\{page\}|\{total\})/g)) {
    if (part === '') {
      continue
    }
    if (part === PAGE_TOKEN) {
      runs.push(new TextRun({ ...opts, children: [PageNumber.CURRENT] }))
    } else if (part === TOTAL_TOKEN) {
      runs.push(new TextRun({ ...opts, children: [PageNumber.TOTAL_PAGES] }))
    } else {
      runs.push(new TextRun({ ...opts, text: part }))
    }
  }
  return runs
}

/** Runs rendering a formatted page-number field per the configured format. */
const pageNumberRuns = (docx: Docx, format: PageNumberFormat): InstanceType<Docx['TextRun']>[] => {
  const { TextRun, PageNumber } = docx
  const current = new TextRun({ children: [PageNumber.CURRENT] })
  switch (format) {
    case 'n':
      return [current]
    case 'n-of-total':
      return [current, new TextRun(' / '), new TextRun({ children: [PageNumber.TOTAL_PAGES] })]
    case 'page-n':
    default:
      return [new TextRun('Page '), current]
  }
}

/** The paragraphs for a header or footer band (section text line + number line). */
const headerFooterParagraphs = (
  docx: Docx,
  location: 'header' | 'footer',
  options: PageLayoutOptions,
): DocxParagraph[] => {
  const { Paragraph } = docx
  const paragraphs: DocxParagraph[] = []
  const section = location === 'header' ? options.header : options.footer
  if (section) {
    paragraphs.push(
      new Paragraph({
        alignment: docxAlignment(docx, section.align),
        children: headerFooterTextRuns(docx, section.text, section),
      }),
    )
  }
  const pageNumber = options.pageNumber
  if (pageNumber && pageNumber.location === location) {
    paragraphs.push(
      new Paragraph({
        alignment: docxAlignment(docx, pageNumber.align),
        children: pageNumberRuns(docx, pageNumber.format),
      }),
    )
  }
  return paragraphs
}

/**
 * Build a real .docx (OOXML) Blob from the shared DocModel. `options` is additive
 * and optional: when omitted the section is exactly `{ children }` (byte-identical
 * to the pre-t48 baseline); when present it adds a running header/footer and/or a
 * page-number field, plus the section's starting page number.
 */
export const buildDocxBlob = async (blocks: DocBlock[], options?: PageLayoutOptions): Promise<Blob> => {
  const docx = await import('docx')
  const ctx: Ctx = { docx, numberingConfigs: [], orderedRefCount: 0 }

  const children = blocks.flatMap((block) => blockToDocx(ctx, block))
  const docChildren =
    children.length > 0 ? children : [new docx.Paragraph({ children: [new docx.TextRun({ text: '' })] })]

  const section: Record<string, unknown> = { children: docChildren }
  if (options) {
    const headerParagraphs = headerFooterParagraphs(docx, 'header', options)
    const footerParagraphs = headerFooterParagraphs(docx, 'footer', options)
    if (headerParagraphs.length > 0) {
      section.headers = { default: new docx.Header({ children: headerParagraphs }) }
    }
    if (footerParagraphs.length > 0) {
      section.footers = { default: new docx.Footer({ children: footerParagraphs }) }
    }
    if (options.pageNumber) {
      section.properties = { page: { pageNumbers: { start: options.pageNumber.startAt } } }
    }
  }

  const doc = new docx.Document({
    numbering: ctx.numberingConfigs.length > 0 ? { config: ctx.numberingConfigs } : undefined,
    sections: [section],
  } as unknown as ConstructorParameters<Docx['Document']>[0])

  return docx.Packer.toBlob(doc)
}
