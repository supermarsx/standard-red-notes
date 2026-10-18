/** Only an operator-configured internal endpoint is contacted, never a model-supplied URL. */
export function createPdfExtractorTransport(endpoint: string | undefined, fetchFn: typeof fetch = fetch) {
  return async (bytes: Uint8Array, startPage: number, endPage: number): Promise<unknown> => {
    if (!endpoint) {
      throw new Error('PDF_EXTRACTION_NOT_CONFIGURED')
    }
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('PDF_EXTRACTION_NOT_CONFIGURED')
    }
    url.pathname = '/extract'
    url.search = new URLSearchParams({ startPage: String(startPage), endPage: String(endPage) }).toString()
    url.hash = ''
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25_000)
    try {
      const response = await fetchFn(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: Buffer.from(bytes),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(
          response.status === 429 || response.status === 503 ? 'PDF_EXTRACTOR_BUSY' : 'PDF_EXTRACTION_FAILED',
        )
      }
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          size += value.byteLength
          if (size > 1_200_000) {
            await reader.cancel()
            throw new Error('PDF_EXTRACTION_RESPONSE_TOO_LARGE')
          }
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
      clearTimeout(timeout)
    }
  }
}
