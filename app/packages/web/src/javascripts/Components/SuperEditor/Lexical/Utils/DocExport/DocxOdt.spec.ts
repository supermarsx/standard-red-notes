/**
 * Structured DOCX + ODT export specs.
 *
 * Two layers:
 *  1. `superStringToDocModel` — a representative Super/Lexical fixture (built with
 *     a real headless editor) is walked into the shared DocModel; we assert the
 *     structure survives, incl. an exotic (Mermaid) node's text-fallback.
 *  2. `buildDocxBlob` / `buildOdtBlob` — a comprehensive DocModel is emitted, the
 *     package unzipped, and the XML asserted structurally + well-formed.
 *
 * NOTE: real Word / LibreOffice RENDERING cannot be validated in this env. The bar
 * here is structural XML assertions + XML well-formedness (parsed via DOMParser,
 * asserting no <parsererror>), plus the ODF mimetype-first/stored byte check.
 */
import { installExportTestEnv } from './testEnvPolyfill'

installExportTestEnv()

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $createListNode, $createListItemNode } from '@lexical/list'
import { $createCodeNode } from '@lexical/code'
import { $createLinkNode } from '@lexical/link'
import { $createTableNode, $createTableRowNode, $createTableCellNode, TableCellHeaderStates } from '@lexical/table'
import { $createHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import BlocksEditorTheme from '../../Theme/Theme'
import { SuperExportNodes } from '../../Nodes/AllNodes'
import { $createInlineFileNode } from '../../../Plugins/InlineFilePlugin/InlineFileNode'
import { $createMermaidNode } from '../../Nodes/MermaidNode'
import { superStringToDocModel, DocBlock, ListModel, buildPlainTextDocModel } from './DocModel'
import { buildDocxBlob } from './DocxGenerator'
import { buildOdtBlob } from './OdtGenerator'
import { $setChecklistDueAt, $setChecklistRecurrence } from '../../Nodes/ChecklistItemNode'
import { createChecklistRecurrence } from '../../../Checklist/checklistRecurrence'

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URI = `data:image/png;base64,${PNG_1x1}`
const MERMAID_CODE = 'graph TD; A-->B;'

/** Build a representative Super note string via a real headless editor. */
const buildFixtureSuperString = (): string => {
  const editor = createHeadlessEditor({
    namespace: 'BlocksEditor',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (e: Error) => {
      throw e
    },
    nodes: SuperExportNodes,
  })

  editor.update(
    () => {
      const root = $getRoot()
      root.clear()

      for (let level = 1; level <= 5; level++) {
        const h = $createHeadingNode(`h${level}` as 'h1')
        h.append($createTextNode(`Heading ${level}`))
        root.append(h)
      }

      // Styled "Title" paragraph (t40): big/bold via element style.
      const title = $createParagraphNode()
      title.setStyle('font-size: 28px; font-weight: bold')
      title.append($createTextNode('Styled Title'))
      root.append(title)

      // Inline formats + colour + link.
      const p = $createParagraphNode()
      const bold = $createTextNode('boldtext')
      bold.toggleFormat('bold')
      const italic = $createTextNode('italictext')
      italic.toggleFormat('italic')
      const under = $createTextNode('underlinetext')
      under.toggleFormat('underline')
      const strike = $createTextNode('striketext')
      strike.toggleFormat('strikethrough')
      const code = $createTextNode('codetext')
      code.toggleFormat('code')
      const colored = $createTextNode('redtext')
      colored.setStyle('color: #ff0000')
      const link = $createLinkNode('https://example.com/')
      link.append($createTextNode('linktext'))
      p.append(bold, italic, under, strike, code, colored, link)
      root.append(p)

      // Bullet list with a NESTED numbered list.
      const bullet = $createListNode('bullet')
      const b1 = $createListItemNode()
      b1.append($createTextNode('Bullet one'))
      const bNest = $createListItemNode()
      const numbered = $createListNode('number')
      const n1 = $createListItemNode()
      n1.append($createTextNode('Numbered one'))
      const n2 = $createListItemNode()
      n2.append($createTextNode('Numbered two'))
      numbered.append(n1, n2)
      bNest.append(numbered)
      bullet.append(b1, bNest)
      root.append(bullet)

      // Check list.
      const check = $createListNode('check')
      const c1 = $createListItemNode()
      c1.setChecked(true)
      c1.append($createTextNode('Done item'))
      const c2 = $createListItemNode()
      c2.setChecked(false)
      $setChecklistDueAt(c2, '2099-08-12T12:00:00.000Z')
      $setChecklistRecurrence(c2, createChecklistRecurrence('weekly', '2099-08-12T12:00:00.000Z', 'UTC'))
      c2.append($createTextNode('Todo item'))
      check.append(c1, c2)
      root.append(check)

      // Quote.
      const quote = $createQuoteNode()
      quote.append($createTextNode('A quoted line'))
      root.append(quote)

      // Code block.
      const codeBlock = $createCodeNode('javascript')
      codeBlock.append($createTextNode('const answer = 42'))
      root.append(codeBlock)

      // Table 1x2.
      const table = $createTableNode()
      const row = $createTableRowNode()
      const cellA = $createTableCellNode(TableCellHeaderStates.NO_STATUS)
      const cellAP = $createParagraphNode()
      cellAP.append($createTextNode('CellAlpha'))
      cellA.append(cellAP)
      const cellB = $createTableCellNode(TableCellHeaderStates.NO_STATUS)
      const cellBP = $createParagraphNode()
      cellBP.append($createTextNode('CellBeta'))
      cellB.append(cellBP)
      row.append(cellA, cellB)
      table.append(row)
      root.append(table)

      // Horizontal rule.
      root.append($createHorizontalRuleNode())

      // Inline base64 image.
      root.append($createInlineFileNode(PNG_DATA_URI, 'image/png', 'pixel.png'))

      // Exotic node — Mermaid — must fall back, never drop.
      root.append($createMermaidNode(MERMAID_CODE))
    },
    { discrete: true },
  )

  return JSON.stringify(editor.getEditorState())
}

/** Unzip helper: returns a map filename → { text?, bytes } for all entries. */
const unzip = async (blob: Blob): Promise<Record<string, { text: () => Promise<string>; isDir: boolean }>> => {
  const zip = await import('@zip.js/zip.js')
  const { ZipReader, BlobReader, TextWriter } = zip
  const reader = new ZipReader(new BlobReader(blob))
  const entries = await reader.getEntries()
  const out: Record<string, { text: () => Promise<string>; isDir: boolean }> = {}
  for (const entry of entries) {
    const e = entry as unknown as {
      filename: string
      directory: boolean
      getData?: (w: unknown) => Promise<string>
    }
    out[e.filename] = {
      isDir: e.directory,
      text: async () => (e.getData ? e.getData(new TextWriter()) : ''),
    }
  }
  await reader.close()
  return out
}

const assertWellFormedXml = (xml: string): Document => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.querySelector('parsererror')).toBeNull()
  return doc
}

/** A comprehensive DocModel that exercises every generator branch. */
const comprehensiveModel = (): DocBlock[] => [
  { kind: 'heading', level: 1, inlines: [{ kind: 'text', text: 'DocHeading' }] },
  {
    kind: 'paragraph',
    inlines: [
      { kind: 'text', text: 'bold', bold: true },
      { kind: 'text', text: 'colored', color: 'FF0000', bgColor: '00FF00' },
      { kind: 'link', url: 'https://example.com/', children: [{ kind: 'text', text: 'ClickHere' }] },
    ],
  },
  {
    kind: 'list',
    list: {
      ordered: false,
      check: false,
      items: [
        // The nested branch hangs off the row above it, which is both what the
        // Lexical walk now produces and what DOCX/ODT express natively. The
        // text-less wrapper Lexical uses internally is covered, with its
        // `wrapper` flag, by the nested-checklist fidelity suite below.
        {
          inlines: [{ kind: 'text', text: 'BulletItem' }],
          children: {
            ordered: true,
            check: false,
            items: [{ inlines: [{ kind: 'text', text: 'NumberedNested' }] }],
          },
        },
      ],
    },
  },
  {
    kind: 'list',
    list: {
      ordered: false,
      check: true,
      items: [{ inlines: [{ kind: 'text', text: 'CheckedItem' }], checked: true }],
    },
  },
  { kind: 'quote', inlines: [{ kind: 'text', text: 'QuotedText' }] },
  { kind: 'code', language: 'js', text: 'const x = 1\nconst y = 2' },
  {
    kind: 'table',
    rows: [
      [
        [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'TableCellOne' }] }],
        [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'TableCellTwo' }] }],
      ],
    ],
  },
  { kind: 'hr' },
  { kind: 'image', dataB64: PNG_1x1, mime: 'image/png', alt: 'pixel' },
  { kind: 'paragraph', inlines: [{ kind: 'text', text: 'MermaidFallbackMarker' }] },
]

describe('superStringToDocModel (Lexical walk)', () => {
  let blocks: DocBlock[]
  const exportNow = Date.parse('2099-08-12T11:00:00.000Z')

  beforeAll(async () => {
    blocks = await superStringToDocModel(buildFixtureSuperString(), { now: exportNow })
  })

  it('maps all five heading levels with their text', () => {
    for (let level = 1; level <= 5; level++) {
      const heading = blocks.find(
        (b) =>
          b.kind === 'heading' &&
          b.level === level &&
          b.inlines.some((i) => i.kind === 'text' && i.text === `Heading ${level}`),
      )
      expect(heading).toBeDefined()
    }
  })

  it('captures a styled Title paragraph (bold + font size derived from CSS)', () => {
    const title = blocks.find(
      (b) => b.kind === 'paragraph' && b.inlines.some((i) => i.kind === 'text' && i.text === 'Styled Title'),
    )
    expect(title).toBeDefined()
    expect(title?.kind === 'paragraph' && title.style?.bold).toBe(true)
    expect(title?.kind === 'paragraph' && (title.style?.fontSizePt ?? 0)).toBeGreaterThan(0)
  })

  it('captures inline formats, colour and links', () => {
    const para = blocks.find(
      (b) => b.kind === 'paragraph' && b.inlines.some((i) => i.kind === 'text' && i.text === 'boldtext'),
    )
    expect(para?.kind).toBe('paragraph')
    if (para?.kind !== 'paragraph') {
      return
    }
    expect(para.inlines.find((i) => i.kind === 'text' && i.text === 'boldtext' && i.bold)).toBeDefined()
    expect(para.inlines.find((i) => i.kind === 'text' && i.text === 'italictext' && i.italic)).toBeDefined()
    expect(para.inlines.find((i) => i.kind === 'text' && i.text === 'underlinetext' && i.underline)).toBeDefined()
    expect(para.inlines.find((i) => i.kind === 'text' && i.text === 'striketext' && i.strike)).toBeDefined()
    expect(para.inlines.find((i) => i.kind === 'text' && i.text === 'codetext' && i.code)).toBeDefined()
    expect(para.inlines.find((i) => i.kind === 'text' && i.text === 'redtext' && i.color === 'FF0000')).toBeDefined()
    const link = para.inlines.find((i) => i.kind === 'link')
    expect(link && link.kind === 'link' && link.url).toBe('https://example.com/')
  })

  it('captures nested bullet→numbered list and a check list', () => {
    const bullet = blocks.find((b) => b.kind === 'list' && !b.list.ordered && !b.list.check)
    expect(bullet?.kind).toBe('list')
    if (bullet?.kind !== 'list') {
      return
    }
    const nestedHolder = bullet.list.items.find((i) => i.children)
    expect(nestedHolder?.children?.ordered).toBe(true)
    expect(nestedHolder?.children?.items[0].inlines.some((i) => i.kind === 'text' && i.text === 'Numbered one')).toBe(
      true,
    )

    const check = blocks.find((b) => b.kind === 'list' && b.list.check)
    expect(check?.kind).toBe('list')
    if (check?.kind === 'list') {
      expect(check.list.items[0].checked).toBe(true)
      const dueInline = check.list.items[1].inlines.find(
        (inline) => inline.kind === 'text' && inline.text.includes('Due'),
      )
      expect(dueInline).toBeDefined()
      expect(dueInline?.kind === 'text' && dueInline.text).toContain('[2099-08-12T12:00:00.000Z]')
      expect(dueInline?.kind === 'text' && dueInline.text).toContain('(1h left)')
      expect(dueInline?.kind === 'text' && dueInline.text).toContain('Repeats weekly')
      expect(dueInline?.kind === 'text' && dueInline.text).toContain('UTC wall time')
    }
  })

  it('captures quote, code block and a table', () => {
    expect(
      blocks.find((b) => b.kind === 'quote' && b.inlines.some((i) => i.kind === 'text' && i.text === 'A quoted line')),
    ).toBeDefined()
    expect(blocks.find((b) => b.kind === 'code' && b.text.includes('const answer = 42'))).toBeDefined()
    const table = blocks.find((b) => b.kind === 'table')
    expect(table?.kind).toBe('table')
    if (table?.kind === 'table') {
      const flat = JSON.stringify(table.rows)
      expect(flat).toContain('CellAlpha')
      expect(flat).toContain('CellBeta')
    }
  })

  it('captures HR and an inline base64 image', () => {
    expect(blocks.find((b) => b.kind === 'hr')).toBeDefined()
    const image = blocks.find((b) => b.kind === 'image')
    expect(image?.kind).toBe('image')
    if (image?.kind === 'image') {
      expect(image.mime).toBe('image/png')
      expect(image.dataB64).toBe(PNG_1x1)
    }
  })

  it('never drops an exotic node — Mermaid falls back to a code block with its source', () => {
    const mermaid = blocks.find((b) => b.kind === 'code' && b.text.includes(MERMAID_CODE))
    expect(mermaid).toBeDefined()
  })
})

describe('buildDocxBlob (structured OOXML)', () => {
  let files: Record<string, { text: () => Promise<string>; isDir: boolean }>
  let documentXml: string

  beforeAll(async () => {
    const blob = await buildDocxBlob(comprehensiveModel())
    files = await unzip(blob)
    documentXml = await files['word/document.xml'].text()
  })

  it('produces a well-formed word/document.xml', () => {
    expect(files['word/document.xml']).toBeDefined()
    assertWellFormedXml(documentXml)
  })

  it('contains heading, list, quote, code, table cell, link and Mermaid-fallback text', () => {
    for (const needle of [
      'DocHeading',
      'BulletItem',
      'NumberedNested',
      'CheckedItem',
      'QuotedText',
      'const x = 1',
      'TableCellOne',
      'TableCellTwo',
      'ClickHere',
      'MermaidFallbackMarker',
    ]) {
      expect(documentXml).toContain(needle)
    }
  })

  it('emits a real table and a numbering definition', () => {
    expect(documentXml).toContain('<w:tbl')
    const numberingXml = files['word/numbering.xml']
    expect(numberingXml).toBeDefined()
  })

  it('embeds the image as a media part', () => {
    const mediaEntry = Object.keys(files).find((name) => name.startsWith('word/media/'))
    expect(mediaEntry).toBeDefined()
  })
})

describe('buildOdtBlob (OpenDocument)', () => {
  let bytes: Uint8Array
  let files: Record<string, { text: () => Promise<string>; isDir: boolean }>
  let contentXml: string

  beforeAll(async () => {
    const blob = await buildOdtBlob(comprehensiveModel())
    bytes = new Uint8Array(await blob.arrayBuffer())
    files = await unzip(blob)
    contentXml = await files['content.xml'].text()
  })

  it('writes the mimetype entry FIRST and STORED (uncompressed) per ODF spec', () => {
    // local file header: sig PK\x03\x04, method@8, name@30
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    const method = bytes[8] | (bytes[9] << 8)
    expect(method).toBe(0)
    const nameLen = bytes[26] | (bytes[27] << 8)
    const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLen))
    expect(name).toBe('mimetype')
  })

  it('produces a well-formed content.xml with headings, lists, table, link and image', () => {
    assertWellFormedXml(contentXml)
    expect(contentXml).toContain('<text:h')
    expect(contentXml).toContain('<text:list')
    expect(contentXml).toContain('<table:table')
    expect(contentXml).toContain('xlink:href="https://example.com/"')
    expect(contentXml).toContain('<draw:image')
    for (const needle of [
      'DocHeading',
      'BulletItem',
      'CheckedItem',
      'QuotedText',
      'TableCellOne',
      'MermaidFallbackMarker',
    ]) {
      expect(contentXml).toContain(needle)
    }
  })

  it('embeds the picture and lists it in the manifest', async () => {
    const picture = Object.keys(files).find((name) => name.startsWith('Pictures/'))
    expect(picture).toBeDefined()
    const manifest = await files['META-INF/manifest.xml'].text()
    assertWellFormedXml(manifest)
    expect(manifest).toContain('Pictures/')
    expect(manifest).toContain('application/vnd.oasis.opendocument.text')
  })
})

describe('buildOdtBlob escaping (t72-e2)', () => {
  // XML-1.0-illegal C0 control chars (U+0000–08, 0B, 0C, 0E–1F); \t \n \r are legal.
  const XML_ILLEGAL_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

  it('F4: strips XML-1.0-illegal control chars from every text sink (no raw byte, re-parses)', async () => {
    // \x0C (form feed), \x0B (vertical tab), \x00 (NUL) are all forbidden in XML 1.0
    // and cannot be represented even as numeric refs. Route them through a paragraph
    // (span/plain-text sink) AND a code block (per-line sink).
    const model: DocBlock[] = [
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'before\x00\x0B\x0Cafter' }] },
      {
        kind: 'paragraph',
        inlines: [{ kind: 'text', text: 'styled\x0Ctext', bold: true }],
      },
      { kind: 'code', language: 'js', text: 'const a = 1\x0C\x00\nconst b = 2\x0B' },
    ]
    const blob = await buildOdtBlob(model)
    const files = await unzip(blob)
    const contentXml = await files['content.xml'].text()

    // The visible text must survive (only the control chars are dropped).
    expect(contentXml).toContain('beforeafter')
    expect(contentXml).toContain('styledtext')
    expect(contentXml).toContain('const a = 1')
    expect(contentXml).toContain('const b = 2')
    // No XML-illegal control char anywhere in content.xml...
    expect(XML_ILLEGAL_CONTROL_CHARS.test(contentXml)).toBe(false)
    // ...and it re-parses with no <parsererror>.
    assertWellFormedXml(contentXml)
  })

  it('F5: escapes an inline image MIME in manifest.xml (no attribute break-out, re-parses)', async () => {
    // A data-URI mime of `image/x"y;base64,QQ==` yields mime === 'image/x"y'; the bare
    // double-quote would close the media-type attribute early and corrupt the package.
    const model: DocBlock[] = [{ kind: 'image', dataB64: 'QQ==', mime: 'image/x"y', alt: 'pixel' }]
    const blob = await buildOdtBlob(model)
    const files = await unzip(blob)
    const manifest = await files['META-INF/manifest.xml'].text()

    // The quote must appear escaped, never raw inside the attribute value.
    expect(manifest).toContain('image/x&quot;y')
    expect(manifest).not.toContain('media-type="image/x"y"')
    // And the manifest re-parses as valid XML (no <parsererror>).
    assertWellFormedXml(manifest)
  })
})

describe('DocModel export bounds (t74-e1 F6)', () => {
  const MAX_WALK_DEPTH = 200

  /**
   * A Super note string that is a single chain of `depth` nested bullet lists.
   *
   * Built by ITERATIVE string concatenation, NOT via `editor.update()` +
   * `JSON.stringify`. Both of those overflow the JS stack at large `depth` before
   * production is ever exercised: committing the tree makes Lexical compute the
   * whole tree's text content on commit (`triggerTextContentListeners` →
   * `$getRoot().getTextContent()`, unbounded recursion), and `JSON.stringify` of a
   * `depth`-deep object recurses per level too. `String.repeat`/concatenation and
   * (in production) `JSON.parse` are both iterative, so this feeds production a
   * genuine `depth`-deep note without the harness itself blowing the stack. The
   * shape mirrors a real depth-2 `EditorState.toJSON()` (list → listitem → …).
   */
  const buildNestedListSuperString = (depth: number): string => {
    const listPost =
      '],"direction":null,"format":"","indent":0,"type":"list","version":1,"listType":"bullet","start":1,"tag":"ul"}'
    const itemPost = '],"direction":null,"format":"","indent":0,"type":"listitem","version":1,"value":1}'
    const textNode = '{"detail":0,"format":0,"mode":"normal","style":"","text":"deepest","type":"text","version":1}'
    // One nesting level = list([ listitem([ <inner> ]) ]); both open with
    // `{"children":[`, so the opener repeats twice per level.
    const pre = '{"children":[{"children":['.repeat(depth)
    const post = (itemPost + listPost).repeat(depth)
    const chain = pre + textNode + post
    return '{"root":{"children":[' + chain + '],"direction":null,"format":"","indent":0,"type":"root","version":1}}'
  }

  /** Depth of the nested-list chain in a produced DocModel (follows items[0].children). */
  const listChainDepth = (blocks: DocBlock[]): number => {
    const top = blocks.find((b) => b.kind === 'list')
    let cur: ListModel | undefined = top && top.kind === 'list' ? top.list : undefined
    let n = 0
    while (cur) {
      n++
      cur = cur.items[0]?.children
    }
    return n
  }

  it('(a) truncates a deeply nested walk at MAX_WALK_DEPTH instead of walking it whole', async () => {
    const inputDepth = 260 // safely > the 200 cap
    const blocks = await superStringToDocModel(buildNestedListSuperString(inputDepth), {})
    const producedDepth = listChainDepth(blocks)

    // The walk STOPPED descending at the cap: the produced chain is bounded near
    // MAX_WALK_DEPTH and strictly shallower than the 260-deep input. With the guard
    // removed the walk follows the input all the way down (producedDepth === 260),
    // so this upper bound is exactly what fails RED in the false-green direction.
    expect(producedDepth).toBeLessThanOrEqual(MAX_WALK_DEPTH + 1)
    expect(producedDepth).toBeLessThan(inputDepth)
    // And it degraded gracefully — the walk returned a real model, never threw.
    expect(producedDepth).toBeGreaterThan(0)
  })

  it('(a) does NOT throw a RangeError on a pathologically deep (stack-overflow-class) nest', async () => {
    // Deep enough that the UNGUARDED recursive walk overflows the JS stack; the depth
    // guard must truncate before that and resolve normally. (False-green: remove the
    // guard → this rejects with a RangeError.)
    const blocks = await superStringToDocModel(buildNestedListSuperString(20000), {})
    expect(blocks.length).toBeGreaterThan(0)
    expect(listChainDepth(blocks)).toBeLessThanOrEqual(MAX_WALK_DEPTH + 1)
  })

  it('(b) drops an over-cap embedded base64 image, emitting its alt text as a paragraph', async () => {
    // A base64 payload whose decoded size (~3/4 of its length) exceeds the 32MB cap.
    // MAX_EMBEDDED_IMAGE_BYTES = 32*1024*1024 → need length > 44,739,242.
    const hugeB64 = 'A'.repeat(45_000_000)
    const dataUri = `data:image/png;base64,${hugeB64}`

    const editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (e: Error) => {
        throw e
      },
      nodes: SuperExportNodes,
    })
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        root.append($createInlineFileNode(dataUri, 'image/png', 'huge.png'))
      },
      { discrete: true },
    )
    const superString = JSON.stringify(editor.getEditorState())

    const blocks = await superStringToDocModel(superString, {})

    // No image block carrying the oversized dataB64 survives...
    const imageBlock = blocks.find((b) => b.kind === 'image')
    expect(imageBlock).toBeUndefined()
    // ...instead the alt/filename comes through as a plain text paragraph.
    const para = blocks.find(
      (b) => b.kind === 'paragraph' && b.inlines.some((i) => i.kind === 'text' && i.text === '[huge.png]'),
    )
    expect(para).toBeDefined()
  })

  it('(b) keeps a normal (under-cap) embedded base64 image as an image block', async () => {
    const editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (e: Error) => {
        throw e
      },
      nodes: SuperExportNodes,
    })
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        root.append($createInlineFileNode(PNG_DATA_URI, 'image/png', 'pixel.png'))
      },
      { discrete: true },
    )
    const blocks = await superStringToDocModel(JSON.stringify(editor.getEditorState()), {})
    const imageBlock = blocks.find((b) => b.kind === 'image')
    expect(imageBlock?.kind).toBe('image')
    expect(imageBlock?.kind === 'image' && imageBlock.dataB64).toBe(PNG_1x1)
  })
})

describe('buildPlainTextDocModel', () => {
  it('turns a plain note into one paragraph per line', async () => {
    const model = buildPlainTextDocModel('line one\nline two')
    expect(model).toHaveLength(2)
    const blob = await buildDocxBlob(model)
    const files = await unzip(blob)
    const xml = await files['word/document.xml'].text()
    expect(xml).toContain('line one')
    expect(xml).toContain('line two')
  })
})

/**
 * Nested-checklist fidelity, asserted on the REAL package contents.
 *
 * Two things make this suite different from the ones above, and both are the
 * reason the defect it covers survived:
 *
 *  1. The input is built through the real `ListItemNode.setIndent`, so the tree
 *     has the shape Lexical actually produces — an indented row lives inside a
 *     TEXT-LESS WRAPPER list item that `$handleIndent` copied from it. A fixture
 *     that appends a nested list to the row itself (`listitem: [text, list]`) is
 *     a shape Lexical never emits, and a generator can pass against it while
 *     printing an empty checkbox per nesting level in every real export.
 *  2. The assertions read the unzipped `word/document.xml` and `content.xml`,
 *     not the intermediate model. The stray checkbox WAS in the XML.
 */
describe('nested checklist fidelity (real Lexical indent → real package XML)', () => {
  /** A single list whose rows sit at `depths`, indented through the real API. */
  const buildIndentedListSuperString = (
    listType: 'check' | 'bullet' | 'number',
    rows: { depth: number; checked?: boolean; text: string }[],
  ): string => {
    const editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (e: Error) => {
        throw e
      },
      nodes: SuperExportNodes,
    })

    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = $createListNode(listType)
        const items = rows.map((row) => {
          const item = $createListItemNode(listType === 'check' ? row.checked === true : undefined)
          item.append($createTextNode(row.text))
          return item
        })
        list.append(...items)
        root.append(list)
        // Indent only once ATTACHED and shallowest-first, exactly as the editor
        // does: `setIndent` reads the live tree and rewrites it.
        items.forEach((item, index) => {
          if (rows[index].depth > 0) {
            item.setIndent(rows[index].depth)
          }
        })
      },
      { discrete: true },
    )

    return JSON.stringify(editor.getEditorState())
  }

  const FOUR_LEVELS = [
    { depth: 0, checked: true, text: 'Level0Done' },
    { depth: 1, checked: false, text: 'Level1Open' },
    { depth: 2, checked: true, text: 'Level2Done' },
    { depth: 3, checked: false, text: 'Level3Open' },
  ]

  /** Every DOCX body paragraph as `{ indent, text }`, in document order. */
  const docxParagraphs = (documentXml: string): { indent: string; text: string }[] => {
    const doc = assertWellFormedXml(documentXml)
    return Array.from(doc.getElementsByTagName('w:p')).map((paragraph) => {
      const ind = paragraph.getElementsByTagName('w:ind')[0]
      return {
        indent: ind?.getAttribute('w:left') ?? '',
        text: Array.from(paragraph.getElementsByTagName('w:t'))
          .map((run) => run.textContent ?? '')
          .join(''),
      }
    })
  }

  /** Every ODT list-item paragraph as `{ depth, text }`, in document order. */
  const odtListRows = (contentXml: string): { depth: number; text: string }[] => {
    const doc = assertWellFormedXml(contentXml)
    const rows: { depth: number; text: string }[] = []
    const walk = (element: Element, depth: number): void => {
      for (const child of Array.from(element.children)) {
        if (child.tagName === 'text:list') {
          walk(child, depth + 1)
        } else if (child.tagName === 'text:list-item') {
          for (const grandChild of Array.from(child.children)) {
            if (grandChild.tagName === 'text:p') {
              rows.push({ depth, text: grandChild.textContent ?? '' })
            } else if (grandChild.tagName === 'text:list') {
              walk(grandChild, depth + 1)
            }
          }
        } else {
          walk(child, depth)
        }
      }
    }
    const body = doc.getElementsByTagName('office:text')[0]
    expect(body).toBeDefined()
    walk(body, -1)
    return rows
  }

  it('DOCX: four levels keep their depth and their state, with no stray checkbox', async () => {
    const blocks = await superStringToDocModel(buildIndentedListSuperString('check', FOUR_LEVELS), {})
    const files = await unzip(await buildDocxBlob(blocks))
    const paragraphs = docxParagraphs(await files['word/document.xml'].text())

    // Exactly four rows — one per task. Five (or seven) means the text-less
    // wrapper got rendered as a task again.
    expect(paragraphs).toEqual([
      { indent: '360', text: '☑ Level0Done' },
      { indent: '720', text: '☐ Level1Open' },
      { indent: '1080', text: '☑ Level2Done' },
      { indent: '1440', text: '☐ Level3Open' },
    ])
    // Said directly, because this is the defect: no paragraph is a checkbox and
    // nothing else.
    expect(paragraphs.filter((paragraph) => paragraph.text.trim() === '☐')).toEqual([])
    expect(paragraphs.filter((paragraph) => paragraph.text.trim() === '☑')).toEqual([])
  })

  it('ODT: four levels keep their depth and their state, with no stray checkbox', async () => {
    const blocks = await superStringToDocModel(buildIndentedListSuperString('check', FOUR_LEVELS), {})
    const files = await unzip(await buildOdtBlob(blocks))
    const contentXml = await files['content.xml'].text()

    expect(odtListRows(contentXml)).toEqual([
      { depth: 0, text: '☑ Level0Done' },
      { depth: 1, text: '☐ Level1Open' },
      { depth: 2, text: '☑ Level2Done' },
      { depth: 3, text: '☐ Level3Open' },
    ])
    // The wrapper's paragraph was literally `<text:p>[box] </text:p>`.
    expect(contentXml).not.toContain('<text:p>☐ </text:p>')
    expect(contentXml).not.toContain('<text:p>☑ </text:p>')
  })

  it('DOCX + ODT: a four-level BULLET nest gets no stray empty bullet either', async () => {
    const rows = [0, 1, 2, 3].map((depth) => ({ depth, text: `Bullet${depth}` }))
    const blocks = await superStringToDocModel(buildIndentedListSuperString('bullet', rows), {})

    const docxFiles = await unzip(await buildDocxBlob(blocks))
    const paragraphs = docxParagraphs(await docxFiles['word/document.xml'].text())
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual(['Bullet0', 'Bullet1', 'Bullet2', 'Bullet3'])

    const odtFiles = await unzip(await buildOdtBlob(blocks))
    expect(odtListRows(await odtFiles['content.xml'].text())).toEqual([
      { depth: 0, text: 'Bullet0' },
      { depth: 1, text: 'Bullet1' },
      { depth: 2, text: 'Bullet2' },
      { depth: 3, text: 'Bullet3' },
    ])
  })

  it('keeps the branch when there is no row to hoist it onto — the FIRST row, indented', async () => {
    // `$handleIndent` has no previous sibling to put the wrapper after here, so
    // the list's only child IS the wrapper. The branch must survive at its real
    // depth, and still without a row of its own.
    const superString = buildIndentedListSuperString('check', [{ depth: 1, checked: false, text: 'OnlyRow' }])
    const blocks = await superStringToDocModel(superString, {})

    const top = blocks.find((block) => block.kind === 'list')
    expect(top?.kind).toBe('list')
    if (top?.kind !== 'list') {
      return
    }
    expect(top.list.items).toHaveLength(1)
    expect(top.list.items[0].wrapper).toBe(true)
    expect(top.list.items[0].inlines).toEqual([])

    const docxFiles = await unzip(await buildDocxBlob(blocks))
    expect(docxParagraphs(await docxFiles['word/document.xml'].text())).toEqual([{ indent: '720', text: '☐ OnlyRow' }])

    const odtFiles = await unzip(await buildOdtBlob(blocks))
    const contentXml = await odtFiles['content.xml'].text()
    expect(odtListRows(contentXml)).toEqual([{ depth: 1, text: '☐ OnlyRow' }])
    expect(contentXml).not.toContain('<text:p>☐ </text:p>')
  })

  it('still prints an EMPTY row the user typed, which is a task and not a wrapper', async () => {
    // The discriminator is structural (every child is a nested list), not "has no
    // text": a list item with no children at all is a real row somebody can tick,
    // and dropping it would lose a line of the document.
    const blocks = await superStringToDocModel(
      buildIndentedListSuperString('check', [
        { depth: 0, checked: false, text: '' },
        { depth: 1, checked: true, text: 'UnderAnEmptyRow' },
      ]),
      {},
    )
    const files = await unzip(await buildDocxBlob(blocks))
    expect(docxParagraphs(await files['word/document.xml'].text())).toEqual([
      { indent: '360', text: '☐ ' },
      { indent: '720', text: '☑ UnderAnEmptyRow' },
    ])
  })

  it('carries a due date on the ROW, never on the wrapper copied from it', async () => {
    // `$copyNode` hands the wrapper the row's NodeState, deadline included, so a
    // wrapper rendered as a task would print a second, text-less deadline.
    const editor = createHeadlessEditor({
      namespace: 'BlocksEditor',
      theme: BlocksEditorTheme,
      editable: false,
      onError: (e: Error) => {
        throw e
      },
      nodes: SuperExportNodes,
    })
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('ParentTask'))
        const child = $createListItemNode(false)
        child.append($createTextNode('ChildTask'))
        list.append(parent, child)
        root.append(list)
        $setChecklistDueAt(child, '2099-08-12T12:00:00.000Z')
        child.setIndent(1)
      },
      { discrete: true },
    )

    const blocks = await superStringToDocModel(JSON.stringify(editor.getEditorState()), {
      now: Date.parse('2099-08-12T11:00:00.000Z'),
    })
    const files = await unzip(await buildDocxBlob(blocks))
    const paragraphs = docxParagraphs(await files['word/document.xml'].text())

    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].text).toBe('☐ ParentTask')
    expect(paragraphs[1].text).toContain('ChildTask')
    expect(paragraphs[1].text).toContain('2099-08-12T12:00:00.000Z')
  })

  it('ODT: hangs the branch INSIDE the row list item, so nothing extra takes a marker', async () => {
    const blocks = await superStringToDocModel(buildIndentedListSuperString('check', FOUR_LEVELS), {})
    const files = await unzip(await buildOdtBlob(blocks))
    const contentXml = await files['content.xml'].text()

    // Canonical ODF nesting: the nested list is a child of the row's OWN list
    // item, not a sibling list item carrying it. A sibling is a list item too,
    // so it takes a bullet of its own and, in an ordered list, a number.
    expect(contentXml).toContain('<text:p>☑ Level0Done</text:p><text:list text:style-name="Lb">')
    // Four rows, four list items. Seven means each branch brought its own.
    expect(contentXml.match(/<text:list-item>/g)).toHaveLength(4)
  })

  it('ODT: a nested NUMBERED list adds no extra numbered item', async () => {
    const blocks = await superStringToDocModel(
      buildIndentedListSuperString('number', [
        { depth: 0, text: 'FirstOrdered' },
        { depth: 1, text: 'NestedOrdered' },
      ]),
      {},
    )
    const files = await unzip(await buildOdtBlob(blocks))
    const contentXml = await files['content.xml'].text()

    expect(contentXml).toContain('<text:p>FirstOrdered</text:p><text:list text:style-name="Ln">')
    expect(contentXml.match(/<text:list-item>/g)).toHaveLength(2)
  })

  it('emits nothing for a wrapper whose branch came back empty, rather than empty ODF', async () => {
    // The shape a truncated walk leaves at `MAX_WALK_DEPTH`: a flagged wrapper
    // whose nested list has no items. A `<text:list-item/>` with no content, or a
    // `<text:list/>` with no items, is not valid ODF — and in DOCX it would be a
    // blank paragraph.
    const model: DocBlock[] = [
      {
        kind: 'list',
        list: {
          ordered: false,
          check: true,
          items: [
            { inlines: [{ kind: 'text', text: 'TruncatedRow' }], checked: false },
            { inlines: [], wrapper: true, children: { ordered: false, check: true, items: [] } },
          ],
        },
      },
    ]

    const odtFiles = await unzip(await buildOdtBlob(model))
    const contentXml = await odtFiles['content.xml'].text()
    expect(contentXml).toContain('TruncatedRow')
    expect(contentXml).not.toContain('<text:list-item></text:list-item>')
    expect(contentXml).not.toContain('<text:list text:style-name="Lb"></text:list>')
    assertWellFormedXml(contentXml)

    const docxFiles = await unzip(await buildDocxBlob(model))
    expect(docxParagraphs(await docxFiles['word/document.xml'].text())).toEqual([
      { indent: '360', text: '☐ TruncatedRow' },
    ])
  })
})
