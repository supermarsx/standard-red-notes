import { getPdfjs } from './pdfjs'

describe('PDF.js Jest boundary', () => {
  it('loads without evaluating the ESM browser bundle and fails closed if rendering is attempted', () => {
    const pdfjs = getPdfjs()

    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/__jest__/pdf.worker.min.mjs')
    expect(() => pdfjs.getDocument({ data: new Uint8Array() })).toThrow(
      'PDF.js rendering is unavailable in CommonJS Jest',
    )
  })
})
