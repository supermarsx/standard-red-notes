import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util'
import { extractFileTextForTags, isExtractableTextMime } from './fileTextExtraction'

// The default (node) jest env may not expose Web text codecs; polyfill from util.
const codecGlobal = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown }
if (!codecGlobal.TextEncoder) {
  codecGlobal.TextEncoder = NodeTextEncoder
}
if (!codecGlobal.TextDecoder) {
  codecGlobal.TextDecoder = NodeTextDecoder
}

// Control the OCR flag + cache without pulling in the real pdf/tesseract stack.
const mockGetOcrServerConfig = jest.fn(() => ({ enabled: false, defaultLanguage: 'eng' }))
const mockReadOcrCache = jest.fn<{ pageNumber: number; text: string }[] | undefined, [string]>(() => undefined)

jest.mock('./pdfOcr', () => ({
  getOcrServerConfig: () => mockGetOcrServerConfig(),
  readOcrCache: (key: string) => mockReadOcrCache(key),
  buildOcrFileKey: (uuid: string, remote?: string) => (remote ? `${uuid}:${remote}` : uuid),
  joinPageTexts: (pages: { text: string }[]) => pages.map((p) => p.text).join('\n\n'),
}))

type MockApp = {
  files: { downloadFile: jest.Mock }
}

const makeApp = (
  impl?: (cb: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>,
): { app: MockApp; downloadFile: jest.Mock } => {
  const downloadFile = jest.fn(async (_file: unknown, cb: (chunk: Uint8Array, progress?: unknown) => Promise<void>) => {
    if (impl) {
      return impl((chunk) => cb(chunk))
    }
    return undefined
  })
  return { app: { files: { downloadFile } }, downloadFile }
}

const makeFile = (mimeType: string) => ({ mimeType, uuid: 'file-uuid', remoteIdentifier: 'remote-1', name: 'f' })

beforeEach(() => {
  mockGetOcrServerConfig.mockReturnValue({ enabled: false, defaultLanguage: 'eng' })
  mockReadOcrCache.mockReturnValue(undefined)
})

describe('isExtractableTextMime', () => {
  it('accepts text/* and structured-text application types', () => {
    expect(isExtractableTextMime('text/plain')).toBe(true)
    expect(isExtractableTextMime('text/csv')).toBe(true)
    expect(isExtractableTextMime('text/markdown')).toBe(true)
    expect(isExtractableTextMime('application/json')).toBe(true)
    expect(isExtractableTextMime('application/xml')).toBe(true)
    expect(isExtractableTextMime('application/ld+json')).toBe(true)
    expect(isExtractableTextMime('image/svg+xml')).toBe(false) // image/*, not application/*
    expect(isExtractableTextMime('application/vnd.custom+xml')).toBe(true)
  })

  it('rejects binary / opaque types and blanks', () => {
    expect(isExtractableTextMime('image/png')).toBe(false)
    expect(isExtractableTextMime('application/pdf')).toBe(false)
    expect(isExtractableTextMime('application/zip')).toBe(false)
    expect(isExtractableTextMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false)
    expect(isExtractableTextMime('')).toBe(false)
    // @ts-expect-error intentionally wrong type
    expect(isExtractableTextMime(undefined)).toBe(false)
  })
})

describe('extractFileTextForTags', () => {
  it('decodes downloaded bytes for a text-like file', async () => {
    const { app, downloadFile } = makeApp(async (push) => {
      await push(new TextEncoder().encode('hello '))
      await push(new TextEncoder().encode('world'))
      return undefined
    })
    const result = await extractFileTextForTags(app as never, makeFile('text/plain') as never)
    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(result.text).toBe('hello world')
    expect(result.onlyMetadataAvailable).toBe(false)
  })

  it('bounds retained/decoded bytes and clamps output for a huge streamed text file', async () => {
    // H1: without a retention bound, every streamed chunk is accumulated and decoded
    // into memory at once (OOM on a multi-GB file). Stream far more than the cap and
    // assert we only ever decode ~budget*4 bytes and return at most `budget` chars.
    const budget = 100
    const retainCap = budget * 4 // UTF-8 is <=4 bytes/char; output is only `budget` chars
    const chunkSize = 1_000
    const chunkCount = 200 // 200_000 bytes streamed — far past the ~400-byte cap
    const { app } = makeApp(async (push) => {
      for (let i = 0; i < chunkCount; i++) {
        await push(new TextEncoder().encode('a'.repeat(chunkSize)))
      }
      return undefined
    })

    const decodeSpy = jest.spyOn((globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder.prototype, 'decode')
    try {
      const result = await extractFileTextForTags(app as never, makeFile('text/plain') as never, { budget })

      // FALSE-GREEN: pre-fix all 200_000 streamed bytes are retained and handed to
      // decode(), so this <=cap assertion FAILS (decoded byteLength would be 200_000).
      expect(decodeSpy).toHaveBeenCalledTimes(1)
      const decoded = decodeSpy.mock.calls[0][0] as Uint8Array
      expect(decoded.byteLength).toBeLessThanOrEqual(retainCap)
      // And the returned text is clamped to the caller's budget regardless.
      expect(result.text.length).toBeLessThanOrEqual(budget)
      expect(result.onlyMetadataAvailable).toBe(false)
    } finally {
      decodeSpy.mockRestore()
    }
  })

  it('forwards options.signal into downloadFile so the in-flight download can be aborted', async () => {
    const { app, downloadFile } = makeApp(async (push) => {
      await push(new TextEncoder().encode('hi'))
      return undefined
    })
    const controller = new AbortController()
    await extractFileTextForTags(app as never, makeFile('text/plain') as never, { signal: controller.signal })

    // FALSE-GREEN: drop the `{ signal: options.signal }` third arg on the downloadFile call and
    // this options object is `undefined` (or lacks the signal), so downloadFile can never abort.
    expect(downloadFile).toHaveBeenCalledTimes(1)
    const passedOptions = downloadFile.mock.calls[0][2] as { signal?: AbortSignal } | undefined
    expect(passedOptions?.signal).toBe(controller.signal)
  })

  it('returns metadata-only for a non-text file WITHOUT downloading', async () => {
    const { app, downloadFile } = makeApp()
    const result = await extractFileTextForTags(app as never, makeFile('image/png') as never)
    expect(downloadFile).not.toHaveBeenCalled()
    expect(result.text).toBe('')
    expect(result.onlyMetadataAvailable).toBe(true)
  })

  it('degrades to metadata-only when the download errors', async () => {
    const { app } = makeApp(async () => 'boom')
    const result = await extractFileTextForTags(app as never, makeFile('text/plain') as never)
    expect(result.text).toBe('')
    expect(result.onlyMetadataAvailable).toBe(true)
  })

  it('PDF with OCR off yields metadata-only and never reads the cache', async () => {
    mockGetOcrServerConfig.mockReturnValue({ enabled: false, defaultLanguage: 'eng' })
    const { app, downloadFile } = makeApp()
    const result = await extractFileTextForTags(app as never, makeFile('application/pdf') as never)
    expect(downloadFile).not.toHaveBeenCalled()
    expect(mockReadOcrCache).not.toHaveBeenCalled()
    expect(result.onlyMetadataAvailable).toBe(true)
  })

  it('PDF with OCR on but no cached text yields metadata-only', async () => {
    mockGetOcrServerConfig.mockReturnValue({ enabled: true, defaultLanguage: 'eng' })
    mockReadOcrCache.mockReturnValue(undefined)
    const { app } = makeApp()
    const result = await extractFileTextForTags(app as never, makeFile('application/pdf') as never)
    expect(mockReadOcrCache).toHaveBeenCalledWith('file-uuid:remote-1')
    expect(result.onlyMetadataAvailable).toBe(true)
  })

  it('PDF with OCR on and cached text reuses the cached extraction', async () => {
    mockGetOcrServerConfig.mockReturnValue({ enabled: true, defaultLanguage: 'eng' })
    mockReadOcrCache.mockReturnValue([
      { pageNumber: 1, text: 'first page' },
      { pageNumber: 2, text: 'second page' },
    ])
    const { app } = makeApp()
    const result = await extractFileTextForTags(app as never, makeFile('application/pdf') as never)
    expect(result.text).toContain('first page')
    expect(result.text).toContain('second page')
    expect(result.onlyMetadataAvailable).toBe(false)
  })
})
