/**
 * Structural specs for the t48 page-layout options threaded into the DOCX + ODT
 * generators: page numbering + running header/footer.
 *
 * Two axes per format:
 *  - options ON  → the package gains the expected OOXML/ODF parts (header/footer
 *    parts, page-number fields, section start / page-adjust);
 *  - options ABSENT → output is unchanged vs the t46 baseline (no header/footer
 *    parts, no master-styles) — proving the additive param is back-compatible and
 *    keeps t46-e2's no-options round-trip green.
 *
 * NOTE: real Word / LibreOffice RENDERING is unverifiable in this env. The bar is
 * structural XML assertions + well-formedness (DOMParser, no <parsererror>).
 */
import { installExportTestEnv } from './testEnvPolyfill'

installExportTestEnv()

import { buildDocxBlob } from './DocxGenerator'
import { buildOdtBlob } from './OdtGenerator'
import { DocBlock } from './DocModel'
import { PageLayoutOptions } from './PageLayoutOptions'

const model = (): DocBlock[] => [
  { kind: 'heading', level: 1, inlines: [{ kind: 'text', text: 'Body Heading' }] },
  { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Body paragraph.' }] },
]

const OPTIONS: PageLayoutOptions = {
  pageNumber: { format: 'n-of-total', align: 'center', location: 'footer', startAt: 3 },
  header: { text: 'Doc Title {page}', align: 'left' },
  footer: { text: 'Confidential', align: 'right' },
}

/** Unzip helper: filename → text reader. */
const unzip = async (blob: Blob): Promise<Record<string, () => Promise<string>>> => {
  const zip = await import('@zip.js/zip.js')
  const { ZipReader, BlobReader, TextWriter } = zip
  const reader = new ZipReader(new BlobReader(blob))
  const entries = await reader.getEntries()
  const out: Record<string, () => Promise<string>> = {}
  for (const entry of entries) {
    const e = entry as unknown as { filename: string; getData?: (w: unknown) => Promise<string> }
    out[e.filename] = async () => (e.getData ? e.getData(new TextWriter()) : '')
  }
  await reader.close()
  return out
}

const assertWellFormedXml = (xml: string): void => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.querySelector('parsererror')).toBeNull()
}

describe('buildDocxBlob with page-layout options', () => {
  it('adds header1.xml / footer1.xml with page-number fields and a section start', async () => {
    const files = await unzip(await buildDocxBlob(model(), OPTIONS))

    expect(files['word/header1.xml']).toBeDefined()
    expect(files['word/footer1.xml']).toBeDefined()

    const headerXml = await files['word/header1.xml']()
    const footerXml = await files['word/footer1.xml']()
    const documentXml = await files['word/document.xml']()

    assertWellFormedXml(headerXml)
    assertWellFormedXml(footerXml)

    // Header carries the literal text and a live PAGE field (from the {page} token).
    expect(headerXml).toContain('Doc Title')
    expect(headerXml).toContain('PAGE')

    // Footer carries the static text AND the numbering band (n-of-total → PAGE + NUMPAGES).
    expect(footerXml).toContain('Confidential')
    expect(footerXml).toContain('PAGE')
    expect(footerXml).toContain('NUMPAGES')

    // Section references the header/footer and starts numbering at 3.
    expect(documentXml).toContain('headerReference')
    expect(documentXml).toContain('footerReference')
    expect(documentXml).toContain('w:pgNumType')
    expect(documentXml).toContain('w:start="3"')
  })

  it('is unchanged vs the t46 baseline when no options are passed (no header/footer parts)', async () => {
    const files = await unzip(await buildDocxBlob(model()))
    expect(files['word/header1.xml']).toBeUndefined()
    expect(files['word/footer1.xml']).toBeUndefined()

    const documentXml = await files['word/document.xml']()
    assertWellFormedXml(documentXml)
    expect(documentXml).not.toContain('headerReference')
    expect(documentXml).not.toContain('footerReference')
    // docx always emits an empty <w:pgNumType/>; the baseline just carries no
    // start override (that only appears when numbering opts in).
    expect(documentXml).not.toContain('w:start=')
    // Body content still present.
    expect(documentXml).toContain('Body Heading')
  })
})

describe('buildOdtBlob with page-layout options', () => {
  it('adds a Standard master-page + page-layout carrying header/footer and page-number fields', async () => {
    const files = await unzip(await buildOdtBlob(model(), OPTIONS))
    const stylesXml = await files['styles.xml']()

    assertWellFormedXml(stylesXml)
    expect(stylesXml).toContain('<office:master-styles>')
    expect(stylesXml).toContain('<style:master-page style:name="Standard"')
    expect(stylesXml).toContain('style:page-layout-name="SRNpm1"')
    expect(stylesXml).toContain('<style:page-layout style:name="SRNpm1">')
    expect(stylesXml).toContain('<style:header>')
    expect(stylesXml).toContain('<style:footer>')
    // Header literal + token → page-number field; footer numbering band → page-number + page-count.
    expect(stylesXml).toContain('Doc Title')
    expect(stylesXml).toContain('Confidential')
    expect(stylesXml).toContain('<text:page-number')
    expect(stylesXml).toContain('<text:page-count/>')
    // startAt 3 → page-adjust of 2 on the numbering field.
    expect(stylesXml).toContain('text:page-adjust="2"')
  })

  it('is unchanged vs the t46 baseline when no options are passed (no master-styles)', async () => {
    const files = await unzip(await buildOdtBlob(model()))
    const stylesXml = await files['styles.xml']()

    assertWellFormedXml(stylesXml)
    expect(stylesXml).not.toContain('<office:master-styles')
    expect(stylesXml).not.toContain('<style:master-page')
    expect(stylesXml).not.toContain('<style:header>')
    // The baseline styles.xml still has its named paragraph styles.
    expect(stylesXml).toContain('Heading_20_1')
  })
})
