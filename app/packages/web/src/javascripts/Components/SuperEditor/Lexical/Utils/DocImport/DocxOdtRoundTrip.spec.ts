/**
 * DOCX + ODT ROUND-TRIP spec — the strongest correctness gate for import.
 *
 * A representative Super/Lexical fixture is walked into the shared DocModel and
 * EXPORTED with e1's `buildDocxBlob` / `buildOdtBlob` (default output, no page
 * layout options), then the resulting blob is wrapped as a File and IMPORTED via
 * e2's `DocxConverter` / `OdtConverter` (through the real `HeadlessSuperConverter`
 * HTML→Super engine). We assert the re-imported Super tree is STRUCTURALLY
 * equivalent for the supported set — NOT byte-identical: mammoth and the ODF walk
 * normalize styling, so the lossy deltas are documented inline.
 *
 * Documented lossy deltas (asserted-around, not asserted-for):
 *  - DOCX: mammoth drops text colour and underline by default; check-list state
 *    becomes a ☐/☑ glyph; code-block language is lost.
 *  - ODT: colour survives as an inline style; code blocks import as text.
 */
import { installExportTestEnv } from '../DocExport/testEnvPolyfill'

installExportTestEnv()

// mammoth ships separate Node and browser builds. Webpack picks the browser
// build via the package's `browser` field (it reads `arrayBuffer` input, which
// is what the converter passes); jest resolves the Node build by default, which
// cannot consume browser-style ArrayBuffer input. Route the import to the same
// browser build the app actually ships so the spec exercises the real path.
jest.mock('mammoth', () => require('mammoth/mammoth.browser.js'))

import { createHeadlessEditor } from '@lexical/headless'
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'
import { $createListNode, $createListItemNode } from '@lexical/list'
import { $createLinkNode } from '@lexical/link'
import { $createTableNode, $createTableRowNode, $createTableCellNode, TableCellHeaderStates } from '@lexical/table'
import BlocksEditorTheme from '../../Theme/Theme'
import { SuperExportNodes } from '../../Nodes/AllNodes'
import { $createInlineFileNode } from '../../../Plugins/InlineFilePlugin/InlineFileNode'
import { superStringToDocModel } from '../DocExport/DocModel'
import { buildDocxBlob } from '../DocExport/DocxGenerator'
import { buildOdtBlob } from '../DocExport/OdtGenerator'
import { DocxConverter, DOCX_IMPORT_MIME_TYPE } from './DocxConverter'
import { OdtConverter, ODT_IMPORT_MIME_TYPE } from './OdtConverter'
import { HeadlessSuperConverter } from '../../../Tools/HeadlessSuperConverter'
import {
  makeConvertDeps,
  fileFromBlob,
  collectByType,
  allText,
  hasImageNode,
  textNodeWithFormat,
  FORMAT,
  SUPER_TYPE,
} from './roundTripTestUtils'

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URI = `data:image/png;base64,${PNG_1x1}`

/** Build a representative Super note string (the export source of truth). */
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

      const h1 = $createHeadingNode('h1')
      h1.append($createTextNode('RoundTripHeading'))
      root.append(h1)

      const h3 = $createHeadingNode('h3')
      h3.append($createTextNode('SubHeading'))
      root.append(h3)

      const p = $createParagraphNode()
      const bold = $createTextNode('RtBold')
      bold.toggleFormat('bold')
      const italic = $createTextNode('RtItalic')
      italic.toggleFormat('italic')
      const link = $createLinkNode('https://roundtrip.test/')
      link.append($createTextNode('RtLink'))
      p.append(bold, italic, link)
      root.append(p)

      const bullet = $createListNode('bullet')
      const b1 = $createListItemNode()
      b1.append($createTextNode('RtBulletOne'))
      const b2 = $createListItemNode()
      b2.append($createTextNode('RtBulletTwo'))
      bullet.append(b1, b2)
      root.append(bullet)

      const quote = $createQuoteNode()
      quote.append($createTextNode('RtQuote'))
      root.append(quote)

      const table = $createTableNode()
      const row = $createTableRowNode()
      const cellA = $createTableCellNode(TableCellHeaderStates.NO_STATUS)
      const cap = $createParagraphNode()
      cap.append($createTextNode('RtCellA'))
      cellA.append(cap)
      const cellB = $createTableCellNode(TableCellHeaderStates.NO_STATUS)
      const cbp = $createParagraphNode()
      cbp.append($createTextNode('RtCellB'))
      cellB.append(cbp)
      row.append(cellA, cellB)
      table.append(row)
      root.append(table)

      root.append($createInlineFileNode(PNG_DATA_URI, 'image/png', 'pixel.png'))
    },
    { discrete: true },
  )

  return JSON.stringify(editor.getEditorState())
}

const importBlob = async (
  blob: Blob,
  converter: DocxConverter | OdtConverter,
  name: string,
  type: string,
): Promise<Record<string, unknown>> => {
  const superConverter = new HeadlessSuperConverter()
  const convertHTMLToSuper = (html: string) => superConverter.convertOtherFormatToSuperString(html, 'html', {})
  const { deps, getInserted } = makeConvertDeps(convertHTMLToSuper)
  const file = await fileFromBlob(blob, name, type)
  const result = await converter.convert(file, deps)
  expect(result.successful).toHaveLength(1)
  return JSON.parse(getInserted().text)
}

describe('DOCX round-trip (Lexical → export → import → Lexical)', () => {
  let tree: Record<string, unknown>

  beforeAll(async () => {
    const model = await superStringToDocModel(buildFixtureSuperString(), {})
    const blob = await buildDocxBlob(model)
    tree = await importBlob(blob, new DocxConverter(), 'roundtrip.docx', DOCX_IMPORT_MIME_TYPE)
  })

  it('preserves headings (text survives; level clamped to h1–h6)', () => {
    expect(collectByType(tree, SUPER_TYPE.heading).length).toBeGreaterThanOrEqual(2)
    const text = allText(tree)
    expect(text).toContain('RoundTripHeading')
    expect(text).toContain('SubHeading')
  })

  it('preserves bold + italic runs', () => {
    expect(textNodeWithFormat(tree, 'RtBold', FORMAT.BOLD)).toBe(true)
    expect(textNodeWithFormat(tree, 'RtItalic', FORMAT.ITALIC)).toBe(true)
  })

  it('preserves the hyperlink href', () => {
    expect(collectByType(tree, 'link').some((l) => (l as { url?: string }).url === 'https://roundtrip.test/')).toBe(true)
  })

  it('preserves the bullet list items', () => {
    expect(collectByType(tree, 'list').length).toBeGreaterThan(0)
    const text = allText(tree)
    expect(text).toContain('RtBulletOne')
    expect(text).toContain('RtBulletTwo')
  })

  it('preserves the table cell text', () => {
    expect(collectByType(tree, 'table').length).toBeGreaterThan(0)
    const text = allText(tree)
    expect(text).toContain('RtCellA')
    expect(text).toContain('RtCellB')
  })

  it('preserves the embedded image', () => {
    expect(hasImageNode(tree)).toBe(true)
  })
})

describe('ODT round-trip (Lexical → export → import → Lexical)', () => {
  let tree: Record<string, unknown>

  beforeAll(async () => {
    const model = await superStringToDocModel(buildFixtureSuperString(), {})
    const blob = await buildOdtBlob(model)
    tree = await importBlob(blob, new OdtConverter(), 'roundtrip.odt', ODT_IMPORT_MIME_TYPE)
  })

  it('preserves headings with their outline level and text', () => {
    const headings = collectByType(tree, SUPER_TYPE.heading)
    expect(headings.length).toBeGreaterThanOrEqual(2)
    expect(headings.some((h) => (h as { tag?: string }).tag === 'h1')).toBe(true)
    const text = allText(tree)
    expect(text).toContain('RoundTripHeading')
    expect(text).toContain('SubHeading')
  })

  it('preserves bold + italic runs', () => {
    expect(textNodeWithFormat(tree, 'RtBold', FORMAT.BOLD)).toBe(true)
    expect(textNodeWithFormat(tree, 'RtItalic', FORMAT.ITALIC)).toBe(true)
  })

  it('preserves the hyperlink href', () => {
    expect(collectByType(tree, 'link').some((l) => (l as { url?: string }).url === 'https://roundtrip.test/')).toBe(true)
  })

  it('preserves the bullet list items', () => {
    expect(collectByType(tree, 'list').length).toBeGreaterThan(0)
    const text = allText(tree)
    expect(text).toContain('RtBulletOne')
    expect(text).toContain('RtBulletTwo')
  })

  it('preserves the quote and table cells', () => {
    expect(collectByType(tree, SUPER_TYPE.quote).length).toBeGreaterThan(0)
    expect(collectByType(tree, SUPER_TYPE.table).length).toBeGreaterThan(0)
    const text = allText(tree)
    expect(text).toContain('RtQuote')
    expect(text).toContain('RtCellA')
    expect(text).toContain('RtCellB')
  })

  it('preserves the embedded picture', () => {
    expect(hasImageNode(tree)).toBe(true)
  })
})
