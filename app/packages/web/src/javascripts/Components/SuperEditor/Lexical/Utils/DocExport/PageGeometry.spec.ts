import { installExportTestEnv } from './testEnvPolyfill'
installExportTestEnv()
import type { ReactElement } from 'react'
import { buildDocxBlob } from './DocxGenerator'
import { buildOdtBlob } from './OdtGenerator'
import {
  marginLengthToMm,
  millimetersToPoints,
  noteLayoutToPageLayoutOptions,
  validatedPageGeometry,
} from './PageLayoutOptions'
import { normalizeNoteLayout } from '../../../Layout/layoutSettings'
import { renderPDFWithRuntime, PDFRendererRuntime } from '../PDFExport/PDFRendererCore'
import { PDF_PAGE_PADDING } from '../PDFExport/PDFLayoutConstants'

const geometry = { widthMm: 240, heightMm: 180, marginMm: 12.7, columns: 2 }
const xml = async (blob: Blob, filename: string) => {
  const { ZipReader, BlobReader, TextWriter } = await import('@zip.js/zip.js')
  const reader = new ZipReader(new BlobReader(blob))
  const entry = (await reader.getEntries()).find((entry) => entry.filename === filename)!
  if (!('getData' in entry) || !entry.getData) {
    throw new Error('Expected an exported XML file')
  }
  const value = await entry.getData(new TextWriter())
  await reader.close()
  return value
}

it('maps custom and named page dimensions after orientation with physical margins and columns', () => {
  const layout = normalizeNoteLayout({
    pageSizeId: 'custom',
    customPageWidthMm: 180,
    customPageHeightMm: 240,
    orientation: 'landscape',
    marginId: 'custom',
    customMargin: '0.5in',
    columns: 2,
  })
  expect(noteLayoutToPageLayoutOptions(layout, true)?.geometry).toEqual(geometry)
  expect(
    noteLayoutToPageLayoutOptions(
      normalizeNoteLayout({ pageSizeId: 'letter', orientation: 'portrait', marginId: 'none' }),
      true,
    )?.geometry,
  ).toEqual({ widthMm: 215.9, heightMm: 279.4, marginMm: 0, columns: 1 })
  // Existing band-only call sites and direct generators retain their absent-geometry baseline.
  expect(noteLayoutToPageLayoutOptions(normalizeNoteLayout({}))).toBeUndefined()
})

it('converts absolute margin units and refuses unresolvable CSS or empty printable areas', () => {
  for (const value of ['25.4mm', '2.54cm', '1in', '72pt', '6pc', '96px'])
    expect(marginLengthToMm(value)).toBeCloseTo(25.4)
  expect(marginLengthToMm('0')).toBe(0)
  for (const value of ['10%', '1em', 'calc(1cm + 1px)', '1cm 2cm', '-1cm', '10'])
    expect(() => marginLengthToMm(value)).toThrow('page margin')
  expect(() => validatedPageGeometry({ ...geometry, marginMm: 100 })).toThrow('printable area')
  expect(() => validatedPageGeometry({ ...geometry, widthMm: Number.NaN })).toThrow('invalid')
  expect(() => validatedPageGeometry({ ...geometry, widthMm: 10, marginMm: 0, columns: 6 })).toThrow('columns')
})

it('writes exact oriented DOCX dimensions, all margins, text columns and page numbering together', async () => {
  const document = new DOMParser().parseFromString(
    await xml(
      await buildDocxBlob([], {
        geometry,
        pageNumber: { format: 'n', align: 'right', location: 'footer', startAt: 4 },
      }),
      'word/document.xml',
    ),
    'application/xml',
  )
  expect(document.querySelector('parsererror')).toBeNull()
  const twips = (value: number) => String(Math.round((value * 1440) / 25.4))
  const size = document.getElementsByTagName('w:pgSz')[0]
  expect(size.getAttribute('w:w')).toBe(twips(240))
  expect(size.getAttribute('w:h')).toBe(twips(180))
  expect(size.getAttribute('w:orient')).toBe('landscape')
  const margin = document.getElementsByTagName('w:pgMar')[0]
  for (const side of ['top', 'bottom', 'left', 'right']) expect(margin.getAttribute(`w:${side}`)).toBe('720')
  expect(document.getElementsByTagName('w:cols')[0].getAttribute('w:num')).toBe('2')
  expect(document.getElementsByTagName('w:pgNumType')[0].getAttribute('w:start')).toBe('4')
})

it('writes ODT physical page dimensions, margins and flowing text columns', async () => {
  const document = new DOMParser().parseFromString(
    await xml(await buildOdtBlob([], { geometry }), 'styles.xml'),
    'application/xml',
  )
  expect(document.querySelector('parsererror')).toBeNull()
  const properties = document.getElementsByTagName('style:page-layout-properties')[0]
  expect(properties.getAttribute('fo:page-width')).toBe('240mm')
  expect(properties.getAttribute('fo:page-height')).toBe('180mm')
  expect(properties.getAttribute('fo:margin')).toBe('12.7mm')
  expect(properties.getAttribute('style:print-orientation')).toBe('landscape')
  expect(document.getElementsByTagName('style:columns')[0].getAttribute('fo:column-count')).toBe('2')
})

it('passes exact physical page dimensions and margins through the PDF worker renderer; rejects unsupported flowing columns', async () => {
  let rendered: ReactElement<{ children: ReactElement<{ size: unknown; style: Record<string, number> }> }> | undefined
  const runtime = {
    Document: 'Document',
    Page: 'Page',
    View: 'View',
    Text: 'Text',
    pdf: (document: typeof rendered) => {
      rendered = document
      return { toBlob: async () => new Blob(['%PDF-']) }
    },
  } as unknown as PDFRendererRuntime
  await renderPDFWithRuntime(runtime, [], 'A4', [], false, { geometry: { ...geometry, columns: 1 } })
  expect(rendered!.props.children.props.size).toEqual({
    width: millimetersToPoints(240),
    height: millimetersToPoints(180),
  })
  expect(rendered!.props.children.props.style.paddingHorizontal).toBeCloseTo(36)
  expect(() => renderPDFWithRuntime(runtime, [], 'A4', [], false, { geometry })).toThrow(
    'does not support flowing text columns',
  )
  await renderPDFWithRuntime(runtime, [], 'LETTER', [])
  expect(rendered!.props.children.props.size).toBe('LETTER')
  expect(rendered!.props.children.props.style.paddingHorizontal).toBe(PDF_PAGE_PADDING)
})
