export type PdfExtractionResult = {
  url: string
  pageCount: number
  pages: { pageNumber: number; text: string }[]
  truncated: boolean
  scannedOrNoText: boolean
}

/** Downloader must enforce public-network DNS/redirect policy before returning bytes. */
export class PdfExtractionService {
  constructor(
    private readonly download: (url: string) => Promise<{ status: number; contentType: string; bytes: Uint8Array }>,
    private readonly extract: (bytes: Uint8Array, startPage: number, endPage: number) => Promise<unknown>,
  ) {}

  async execute(input: { url: string; startPage?: number; endPage?: number }): Promise<PdfExtractionResult> {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      throw new Error('INVALID_PDF_REQUEST')
    }
    const start = input.startPage ?? 1
    const end = input.endPage ?? start + 9
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end - start >= 20
    ) {
      throw new Error('INVALID_PDF_REQUEST')
    }
    const response = await this.download(url.href)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.status === 429 ? 'PDF_RATE_LIMITED' : 'PDF_DOWNLOAD_FAILED')
    }
    if (
      response.bytes.byteLength > 5 * 1024 * 1024 ||
      Buffer.from(response.bytes.subarray(0, 5)).toString('ascii') !== '%PDF-'
    ) {
      throw new Error('INVALID_PDF_DOCUMENT')
    }
    const result = (await this.extract(response.bytes, start, end)) as Partial<PdfExtractionResult> | null
    if (
      !result ||
      !Number.isSafeInteger(result.pageCount) ||
      (result.pageCount ?? 0) < start ||
      typeof result.truncated !== 'boolean' ||
      typeof result.scannedOrNoText !== 'boolean' ||
      !Array.isArray(result.pages) ||
      result.pages.length < 1 ||
      result.pages.length > 20 ||
      (!result.truncated && result.pages.length !== Math.min(end, result.pageCount!) - start + 1)
    ) {
      throw new Error('INVALID_PDF_RESPONSE')
    }
    let total = 0
    const pages = result.pages.map((page, index) => {
      if (
        !page ||
        page.pageNumber !== start + index ||
        page.pageNumber > end ||
        page.pageNumber > result.pageCount! ||
        typeof page.text !== 'string' ||
        (total += page.text.length) > 200_000
      ) {
        throw new Error('INVALID_PDF_RESPONSE')
      }
      return { pageNumber: page.pageNumber, text: page.text }
    })
    return {
      url: url.href,
      pageCount: result.pageCount!,
      pages,
      truncated: result.truncated,
      scannedOrNoText: pages.every((page) => !page.text.trim()),
    }
  }
}
