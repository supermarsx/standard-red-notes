import { createPdfExtractorTransport } from './PdfExtractorTransport'

describe('PDF companion transport', () => {
  it('uses only the configured endpoint, bounded ranges and no redirects', async () => {
    const fetchFn = jest.fn().mockResolvedValue(new Response(JSON.stringify({ pages: [] })))
    await createPdfExtractorTransport('http://assistant-pdf:8091', fetchFn)(new Uint8Array([1]), 2, 5)
    expect(fetchFn).toHaveBeenCalledWith(
      'http://assistant-pdf:8091/extract?startPage=2&endPage=5',
      expect.objectContaining({ redirect: 'error', method: 'POST' }),
    )
  })
  it('fails clearly when not configured', async () => {
    await expect(createPdfExtractorTransport(undefined)(new Uint8Array(), 1, 10)).rejects.toThrow(
      'PDF_EXTRACTION_NOT_CONFIGURED',
    )
  })
  it('rejects oversized JSON before parsing', async () => {
    const fetchFn = jest.fn().mockResolvedValue(new Response(' '.repeat(1_200_001)))
    await expect(
      createPdfExtractorTransport('http://assistant-pdf:8091', fetchFn)(new Uint8Array(), 1, 10),
    ).rejects.toThrow('PDF_EXTRACTION_RESPONSE_TOO_LARGE')
  })
})
