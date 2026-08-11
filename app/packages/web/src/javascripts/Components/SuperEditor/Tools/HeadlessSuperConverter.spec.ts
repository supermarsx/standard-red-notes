/** @jest-environment jsdom */

const mockGeneratePDF = jest.fn<Promise<Blob>, unknown[]>()

jest.mock('../Lexical/Utils/PDFExport/PDFExport', () => ({
  $generatePDFFromNodes: (...args: unknown[]) => mockGeneratePDF(...args),
}))

import { HeadlessSuperConverter } from './HeadlessSuperConverter'

describe('HeadlessSuperConverter PDF Blob path', () => {
  beforeEach(() => {
    mockGeneratePDF.mockReset()
  })

  it('generates a real blank PDF for an empty note instead of returning an empty URL/string', async () => {
    const expected = new Blob(['%PDF-1.7\nblank page'], { type: 'application/pdf' })
    mockGeneratePDF.mockResolvedValue(expected)
    const converter = new HeadlessSuperConverter()

    const actual = await converter.convertSuperStringToPDFBlob('', { pdf: { pageSize: 'A4' } })

    expect(actual).toBe(expected)
    expect(actual.size).toBeGreaterThan(5)
    expect(mockGeneratePDF).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy string API CSP-safe without creating an object URL', async () => {
    const expected = new Blob(['%PDF-1.7\nbody'], { type: 'application/pdf' })
    mockGeneratePDF.mockResolvedValue(expected)
    const converter = new HeadlessSuperConverter()
    const createObjectURL = jest.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })

    const result = await converter.convertSuperStringToOtherFormat('', 'pdf', { pdf: { pageSize: 'LETTER' } })

    expect(result).toMatch(/^data:application\/pdf;base64,/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
