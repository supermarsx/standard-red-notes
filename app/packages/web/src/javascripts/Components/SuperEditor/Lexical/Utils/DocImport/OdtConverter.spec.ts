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

import * as zip from '@zip.js/zip.js'
import { buildOdtBlob } from '../DocExport/OdtGenerator'
import { DocBlock } from '../DocExport/DocModel'
import { OdtConverter, ODT_IMPORT_MIME_TYPE, odfContentToHtml } from './OdtConverter'
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

/**
 * Build a raw .odt zip from arbitrary entries (mirrors OdtGenerator's writer API).
 * Lets us craft hostile inputs — a decompression bomb and pathologically deep
 * nesting — that the well-formed `buildOdtBlob` fixture can't produce.
 */
const buildRawOdt = async (files: Record<string, string | Uint8Array>): Promise<Blob> => {
  const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'))
  for (const [name, content] of Object.entries(files)) {
    const reader = typeof content === 'string' ? new zip.TextReader(content) : new zip.Uint8ArrayReader(content)
    await writer.add(name, reader)
  }
  return (await writer.close()) as Blob
}

describe('OdtConverter resource-exhaustion guards', () => {
  const converter = new OdtConverter()

  // F1 — decompression-bomb OOM. A `content.xml` that compresses to almost nothing
  // but reports a decompressed `uncompressedSize` far past the per-entry cap. The
  // guard must REJECT (from the reported size) before `getData` materializes it.
  it('rejects an ODT whose content.xml decompresses past the size cap, before materializing it', async () => {
    // 101MB of a single byte: > the 100MB per-entry cap, deflates to a few KB.
    const bombBytes = new Uint8Array(101 * 1_000_000)
    bombBytes.fill(0x41 /* 'A' */)
    const blob = await buildRawOdt({ 'content.xml': bombBytes })
    const file = await fileFromBlob(blob, 'bomb.odt', ODT_IMPORT_MIME_TYPE)
    const { deps } = makeConvertDeps((html) => html)

    // FALSE-GREEN: pre-fix there is no size check — getData buffers the whole 101MB,
    // DOMParser sees a non-XML "AAAA…" blob (no <office:text>), the walk returns ''
    // and convert() RESOLVES successfully, so this rejection assertion would FAIL.
    await expect(converter.convert(file, deps)).rejects.toThrow(/too large/i)
  }, 120000)

  // F2 — walker unbounded recursion → stack overflow. `odfContentToHtml` runs OUTSIDE
  // the zip try/finally, so a thrown RangeError aborts the whole import. The depth
  // guard caps recursion at MAX_WALK_DEPTH (200), which is exactly the mechanism that
  // makes a stack overflow impossible regardless of input depth.
  //
  // NOTE on the test env: jsdom cannot even HOLD a ~20k-deep DOM — both its DOMParser
  // (<parsererror>) and its `appendChild` (`_descendantAdded` recurses over ancestors)
  // overflow long before the walker would. Real browsers build such trees fine, so the
  // production vuln is real. We therefore assert the guard's OBSERVABLE effect on a
  // tree that jsdom CAN build but that is deeper than the cap: content nested past
  // MAX_WALK_DEPTH is truncated (the walk stops descending) instead of being walked to
  // the bottom. A walker with no cap descends all the way and emits the deep leaf.
  it('caps recursion depth so nesting past the limit is truncated, not walked to the bottom', () => {
    const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
    const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
    const doc = document.implementation.createDocument(OFFICE_NS, 'office:document-content', null)
    const officeText = doc.createElementNS(OFFICE_NS, 'office:text')
    doc.documentElement.appendChild(officeText)

    // 500 nested text:list > text:list-item (comfortably above the 200 cap, well below
    // jsdom's build limit), with a marker paragraph at the very bottom. Building the
    // tree is iterative (appendChild); only the WALK recurses.
    const depth = 500
    let cursor: Element = officeText
    for (let i = 0; i < depth; i++) {
      const list = doc.createElementNS(TEXT_NS, 'text:list')
      const item = doc.createElementNS(TEXT_NS, 'text:list-item')
      list.appendChild(item)
      cursor.appendChild(list)
      cursor = item
    }
    const deepPara = doc.createElementNS(TEXT_NS, 'text:p')
    deepPara.textContent = 'DeepLeafMarker'
    cursor.appendChild(deepPara)

    // Sanity: the deep tree was actually built (guards against a vacuous test).
    expect(doc.getElementsByTagName('office:text')).toHaveLength(1)

    const html = odfContentToHtml(doc, null, new Map())

    // The walk returns a bounded string (never throws / overflows) ...
    expect(typeof html).toBe('string')
    // ... and FALSE-GREEN: an uncapped walker descends all 500 levels and emits the
    // bottom paragraph, so this assertion FAILS pre-fix. The cap stops at depth 200,
    // truncating everything below it, so the marker never appears.
    expect(html).not.toContain('DeepLeafMarker')
  })
})
