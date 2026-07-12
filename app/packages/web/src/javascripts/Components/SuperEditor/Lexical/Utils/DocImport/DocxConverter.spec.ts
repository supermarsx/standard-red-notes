/**
 * DOCX import spec.
 *
 * A representative DocModel is exported to a real .docx via e1's `buildDocxBlob`,
 * wrapped as a File-like, and imported through `DocxConverter` — whose `mammoth`
 * → HTML → `convertHTMLToSuper` seam is exercised with the REAL
 * `HeadlessSuperConverter` (the same engine the app injects). We then parse the
 * produced Super/Lexical JSON and assert the structure survived.
 *
 * jsdom lacks the WHATWG globals docx/zip.js need, so `installExportTestEnv()`
 * runs first (reused from e1's DocExport test env).
 */
import { installExportTestEnv } from '../DocExport/testEnvPolyfill'

installExportTestEnv()

// mammoth ships separate Node and browser builds. Webpack picks the browser
// build via the package's `browser` field (it reads `arrayBuffer` input, which
// is what the converter passes); jest resolves the Node build by default, which
// cannot consume browser-style ArrayBuffer input. Route the import to the same
// browser build the app actually ships so the spec exercises the real path.
jest.mock('mammoth', () => require('mammoth/mammoth.browser.js'))

import { buildDocxBlob } from '../DocExport/DocxGenerator'
import { DocBlock } from '../DocExport/DocModel'
import { DocxConverter, DOCX_IMPORT_MIME_TYPE } from './DocxConverter'
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

const fixtureModel = (): DocBlock[] => [
  { kind: 'heading', level: 1, inlines: [{ kind: 'text', text: 'ImportedHeading' }] },
  {
    kind: 'paragraph',
    inlines: [
      { kind: 'text', text: 'BoldRun', bold: true },
      { kind: 'text', text: 'ItalicRun', italic: true },
      { kind: 'link', url: 'https://example.com/', children: [{ kind: 'text', text: 'LinkText' }] },
    ],
  },
  {
    kind: 'list',
    list: {
      ordered: false,
      check: false,
      items: [{ inlines: [{ kind: 'text', text: 'BulletAlpha' }] }, { inlines: [{ kind: 'text', text: 'BulletBeta' }] }],
    },
  },
  {
    kind: 'table',
    rows: [
      [
        [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'CellOne' }] }],
        [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'CellTwo' }] }],
      ],
    ],
  },
  { kind: 'image', dataB64: PNG_1x1, mime: 'image/png', alt: 'pixel' },
]

describe('DocxConverter', () => {
  const converter = new DocxConverter()

  it('reports docx import type, extension and MIME', () => {
    expect(converter.getImportType()).toBe('docx')
    expect(converter.getFileExtension?.()).toBe('docx')
    expect(converter.getSupportedFileTypes?.()).toContain(DOCX_IMPORT_MIME_TYPE)
  })

  it('validates on the zip "PK" magic and rejects non-zip text', () => {
    expect(converter.isContentValid('PKrest')).toBe(true)
    expect(converter.isContentValid('not a zip')).toBe(false)
  })

  it('throws a clear error when Super is unavailable', async () => {
    const blob = await buildDocxBlob(fixtureModel())
    const file = await fileFromBlob(blob, 'note.docx', DOCX_IMPORT_MIME_TYPE)
    const { deps } = makeConvertDeps(() => '')
    await expect(converter.convert(file, { ...deps, canUseSuper: false })).rejects.toThrow(/Super/)
  })

  describe('round-trips a real .docx into Super', () => {
    let tree: Record<string, unknown>

    beforeAll(async () => {
      const superConverter = new HeadlessSuperConverter()
      const convertHTMLToSuper = (html: string) => superConverter.convertOtherFormatToSuperString(html, 'html', {})
      const { deps, getInserted } = makeConvertDeps(convertHTMLToSuper)

      const blob = await buildDocxBlob(fixtureModel())
      const file = await fileFromBlob(blob, 'note.docx', DOCX_IMPORT_MIME_TYPE)
      const result = await converter.convert(file, deps)

      expect(result.successful).toHaveLength(1)
      tree = JSON.parse(getInserted().text)
    })

    it('preserves the heading with its text', () => {
      const headings = collectByType(tree, SUPER_TYPE.heading)
      expect(headings.length).toBeGreaterThan(0)
      expect(allText(tree)).toContain('ImportedHeading')
    })

    it('preserves bold and italic runs', () => {
      expect(textNodeWithFormat(tree, 'BoldRun', FORMAT.BOLD)).toBe(true)
      expect(textNodeWithFormat(tree, 'ItalicRun', FORMAT.ITALIC)).toBe(true)
    })

    it('preserves the hyperlink with its href', () => {
      const links = collectByType(tree, 'link')
      expect(links.some((l) => (l as { url?: string }).url === 'https://example.com/')).toBe(true)
      expect(allText(tree)).toContain('LinkText')
    })

    it('preserves list items', () => {
      expect(collectByType(tree, 'list').length).toBeGreaterThan(0)
      const text = allText(tree)
      expect(text).toContain('BulletAlpha')
      expect(text).toContain('BulletBeta')
    })

    it('preserves the table cell text', () => {
      expect(collectByType(tree, 'table').length).toBeGreaterThan(0)
      const text = allText(tree)
      expect(text).toContain('CellOne')
      expect(text).toContain('CellTwo')
    })

    it('preserves the embedded image as an image/file node', () => {
      expect(hasImageNode(tree)).toBe(true)
    })
  })
})
