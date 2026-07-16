/**
 * ODT import spec.
 *
 * A representative DocModel is exported to a real .odt via e1's `buildOdtBlob`,
 * wrapped as a File-like, and imported through `OdtConverter` — whose
 * zip.js/DOMParser → HTML → `convertHTMLToSuper` seam is exercised with the REAL
 * `HeadlessSuperConverter`. We then parse the produced Super/Lexical JSON and
 * assert the structure survived.
 */
import { installExportTestEnv } from '../DocExport/testEnvPolyfill'

installExportTestEnv()

import { buildOdtBlob } from '../DocExport/OdtGenerator'
import { DocBlock } from '../DocExport/DocModel'
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

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const fixtureModel = (): DocBlock[] => [
  { kind: 'heading', level: 2, inlines: [{ kind: 'text', text: 'OdtHeading' }] },
  {
    kind: 'paragraph',
    inlines: [
      { kind: 'text', text: 'OdtBold', bold: true },
      { kind: 'text', text: 'OdtItalic', italic: true },
      { kind: 'link', url: 'https://standardnotes.test/', children: [{ kind: 'text', text: 'OdtLink' }] },
    ],
  },
  {
    kind: 'list',
    list: {
      ordered: true,
      check: false,
      items: [{ inlines: [{ kind: 'text', text: 'NumberOne' }] }, { inlines: [{ kind: 'text', text: 'NumberTwo' }] }],
    },
  },
  { kind: 'quote', inlines: [{ kind: 'text', text: 'OdtQuote' }] },
  {
    kind: 'table',
    rows: [
      [
        [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'OdtCellA' }] }],
        [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'OdtCellB' }] }],
      ],
    ],
  },
  { kind: 'image', dataB64: PNG_1x1, mime: 'image/png', alt: 'pixel' },
]

describe('OdtConverter', () => {
  const converter = new OdtConverter()

  it('reports odt import type, extension and MIME', () => {
    expect(converter.getImportType()).toBe('odt')
    expect(converter.getFileExtension?.()).toBe('odt')
    expect(converter.getSupportedFileTypes?.()).toContain(ODT_IMPORT_MIME_TYPE)
  })

  it('validates on the zip "PK" magic and rejects non-zip text', () => {
    expect(converter.isContentValid('PKzipbytes')).toBe(true)
    expect(converter.isContentValid('<xml>')).toBe(false)
  })

  it('throws a clear error when Super is unavailable', async () => {
    const blob = await buildOdtBlob(fixtureModel())
    const file = await fileFromBlob(blob, 'note.odt', ODT_IMPORT_MIME_TYPE)
    const { deps } = makeConvertDeps(() => '')
    await expect(converter.convert(file, { ...deps, canUseSuper: false })).rejects.toThrow(/Super/)
  })

  describe('round-trips a real .odt into Super', () => {
    let tree: Record<string, unknown>

    beforeAll(async () => {
      const superConverter = new HeadlessSuperConverter()
      const convertHTMLToSuper = (html: string) => superConverter.convertOtherFormatToSuperString(html, 'html', {})
      const { deps, getInserted } = makeConvertDeps(convertHTMLToSuper)

      const blob = await buildOdtBlob(fixtureModel())
      const file = await fileFromBlob(blob, 'note.odt', ODT_IMPORT_MIME_TYPE)
      const result = await converter.convert(file, deps)

      expect(result.successful).toHaveLength(1)
      tree = JSON.parse(getInserted().text)
    })

    it('preserves the heading with its text', () => {
      expect(collectByType(tree, SUPER_TYPE.heading).length).toBeGreaterThan(0)
      expect(allText(tree)).toContain('OdtHeading')
    })

    it('preserves bold and italic runs', () => {
      expect(textNodeWithFormat(tree, 'OdtBold', FORMAT.BOLD)).toBe(true)
      expect(textNodeWithFormat(tree, 'OdtItalic', FORMAT.ITALIC)).toBe(true)
    })

    it('preserves the hyperlink with its href', () => {
      const links = collectByType(tree, 'link')
      expect(links.some((l) => (l as { url?: string }).url === 'https://standardnotes.test/')).toBe(true)
      expect(allText(tree)).toContain('OdtLink')
    })

    it('preserves an ordered list and its items', () => {
      expect(collectByType(tree, 'list').length).toBeGreaterThan(0)
      const text = allText(tree)
      expect(text).toContain('NumberOne')
      expect(text).toContain('NumberTwo')
    })

    it('preserves the quote and table cells', () => {
      expect(collectByType(tree, SUPER_TYPE.quote).length).toBeGreaterThan(0)
      expect(collectByType(tree, SUPER_TYPE.table).length).toBeGreaterThan(0)
      const text = allText(tree)
      expect(text).toContain('OdtQuote')
      expect(text).toContain('OdtCellA')
      expect(text).toContain('OdtCellB')
    })

    it('preserves the embedded picture as an image/file node', () => {
      expect(hasImageNode(tree)).toBe(true)
    })
  })
})
