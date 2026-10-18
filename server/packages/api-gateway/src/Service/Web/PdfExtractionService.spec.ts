import { PdfExtractionService } from './PdfExtractionService'

describe('PdfExtractionService', () => {
  const document = { status: 200, contentType: 'application/pdf', bytes: Buffer.from('%PDF-test') }
  const extracted = {
    pageCount: 1,
    pages: [{ pageNumber: 1, text: 'hello' }],
    truncated: false,
    scannedOrNoText: false,
  }
  it('passes bounded page selection to the extractor and removes untrusted extra properties', async () => {
    const extract = jest.fn().mockResolvedValue({ ...extracted, secret: 'discard' })
    const service = new PdfExtractionService(async () => document, extract)
    expect(await service.execute({ url: 'https://example.com/report.pdf' })).toEqual({
      ...extracted,
      url: 'https://example.com/report.pdf',
    })
    expect(extract).toHaveBeenCalledWith(document.bytes, 1, 10)
  })
  it.each([{ startPage: 0 }, { endPage: 21 }, { startPage: 2, endPage: 1 }, { startPage: 1.5 }])(
    'rejects invalid page range before downloading %j',
    async (range) => {
      const download = jest.fn()
      const service = new PdfExtractionService(download, jest.fn())
      await expect(service.execute({ url: 'https://example.com/a', ...range })).rejects.toThrow('INVALID_PDF_REQUEST')
      expect(download).not.toHaveBeenCalled()
    },
  )
  it('normalizes malformed URLs without downloading', async () => {
    const service = new PdfExtractionService(jest.fn(), jest.fn())
    await expect(service.execute({ url: 'not a URL' })).rejects.toThrow('INVALID_PDF_REQUEST')
  })
  it.each([403, 429, 500])('does not extract upstream HTTP %s errors', async (status) => {
    const extract = jest.fn()
    const service = new PdfExtractionService(async () => ({ ...document, status }), extract)
    await expect(service.execute({ url: 'https://example.com/a' })).rejects.toThrow()
    expect(extract).not.toHaveBeenCalled()
  })
  it('rejects oversized documents before invoking native code', async () => {
    const service = new PdfExtractionService(
      async () => ({ ...document, bytes: new Uint8Array(5 * 1024 * 1024 + 1) }),
      jest.fn(),
    )
    await expect(service.execute({ url: 'https://example.com/a' })).rejects.toThrow('INVALID_PDF_DOCUMENT')
  })
  it.each([
    null,
    {},
    { ...extracted, pageCount: 2 },
    { ...extracted, pages: [{ pageNumber: 2, text: 'wrong page' }] },
    { ...extracted, pages: [{ pageNumber: 1, text: 'x'.repeat(200_001) }] },
  ])('rejects malformed companion responses', async (result) => {
    const service = new PdfExtractionService(
      async () => document,
      async () => result,
    )
    await expect(service.execute({ url: 'https://example.com/a' })).rejects.toThrow('INVALID_PDF_RESPONSE')
  })
})
