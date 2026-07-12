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

const makeApp = (impl?: (cb: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>): { app: MockApp; downloadFile: jest.Mock } => {
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
