/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import InlineFileComponent, { INLINE_PREVIEW_IDLE_TIMEOUT_MS, INLINE_SAVE_IDLE_TIMEOUT_MS } from './InlineFileComponent'
import { InlineFileNode } from './InlineFileNode'
import { MAX_LOCAL_FILE_SIZE } from '@/Constants/Constants'

const mockEditor = {
  registerCommand: jest.fn(() => jest.fn()),
  update: jest.fn((callback: () => void) => callback()),
}
const mockApplication = {
  platform: 'web',
  generateUUID: jest.fn(() => 'generated-file'),
  filesController: { uploadNewFile: jest.fn() },
}
const mockCreatedFileNode = { type: 'encrypted-file-node' }

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('../EncryptedFilePlugin/Nodes/FileUtils', () => ({
  $createFileNode: jest.fn(() => mockCreatedFileNode),
}))
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('@lexical/react/useLexicalNodeSelection', () => ({
  useLexicalNodeSelection: () => [false, jest.fn()],
}))
jest.mock('@lexical/react/LexicalBlockWithAlignableContents', () => ({
  BlockWithAlignableContents: ({ children }: { children: import('react').ReactNode }) =>
    createElement('div', null, children),
}))
jest.mock('../ImageTools/SuperEmbeddedImage', () => ({
  __esModule: true,
  default: ({ src }: { src: string }) => createElement('div', { 'data-inline-image-src': src }),
}))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FilePreview/PdfPreview', () => ({
  __esModule: true,
  default: ({ bytes }: { bytes: Uint8Array }) =>
    createElement('div', { 'data-inline-pdf-bytes': Array.from(bytes).join(',') }, 'PDF preview'),
}))
jest.mock('@/Components/FilePreview/TextPreview', () => ({
  __esModule: true,
  default: ({ bytes }: { bytes: Uint8Array }) =>
    createElement('div', { 'data-inline-text-bytes': Array.from(bytes).join(',') }, 'Text preview'),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const streamResponse = (chunk: Uint8Array, contentLength = String(chunk.byteLength)) => {
  let read = false
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-length' ? contentLength : null) },
    body: {
      getReader: () => ({
        read: jest.fn(async () => {
          if (read) {
            return { done: true, value: undefined }
          }
          read = true
          return { done: false, value: chunk }
        }),
        cancel: jest.fn(async () => undefined),
        releaseLock: jest.fn(),
      }),
    },
  } as unknown as Response
}

describe('InlineFileComponent PDF preview', () => {
  let container: HTMLElement
  let root: Root
  let originalFetch: typeof globalThis.fetch
  let originalIntersectionObserver: typeof IntersectionObserver | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalFetch = globalThis.fetch
    originalIntersectionObserver = globalThis.IntersectionObserver
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = undefined
    mockEditor.registerCommand.mockImplementation(() => jest.fn())
    mockEditor.update.mockImplementation((callback: () => void) => callback())
    mockApplication.filesController.uploadNewFile.mockReset()
    URL.createObjectURL = jest.fn(() => 'blob:owned-inline-image')
    URL.revokeObjectURL = jest.fn()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
      originalIntersectionObserver
  })

  const renderInline = async ({
    src,
    mimeType,
    fileName,
    node = {} as InlineFileNode,
  }: {
    src: string
    mimeType: string
    fileName?: string
    node?: InlineFileNode
  }) => {
    await act(async () => {
      root.render(
        createElement(InlineFileComponent, {
          className: { base: '', focus: '' },
          src,
          mimeType,
          fileName,
          format: null,
          setFormat: jest.fn(),
          node,
          nodeKey: 'inline-file',
          width: undefined,
          setWidth: jest.fn(),
          caption: undefined,
          setCaption: jest.fn(),
          float: 'none',
          setFloat: jest.fn(),
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('loads inline PDF bytes without an object embed or credential/referrer leakage', async () => {
    const bytes = Uint8Array.from([37, 80, 68, 70])
    const fetchMock = jest.fn().mockResolvedValue({
      ...streamResponse(bytes),
    })
    globalThis.fetch = fetchMock as typeof globalThis.fetch

    await act(async () => {
      root.render(
        createElement(InlineFileComponent, {
          className: { base: '', focus: '' },
          src: 'data:application/pdf;base64,JVBERg==',
          mimeType: 'application/pdf',
          fileName: 'document.pdf',
          format: null,
          setFormat: jest.fn(),
          node: {} as InlineFileNode,
          nodeKey: 'inline-pdf',
          width: undefined,
          setWidth: jest.fn(),
          caption: undefined,
          setCaption: jest.fn(),
          float: 'none',
          setFloat: jest.fn(),
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('object')).toBeNull()
    expect(container.querySelector('[data-inline-pdf-viewport="true"]')?.className).toContain(
      'h-[clamp(20rem,65vh,48rem)]',
    )
    expect(container.querySelector('[data-inline-pdf-bytes="37,80,68,70"]')).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      'data:application/pdf;base64,JVBERg==',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    )
  })

  it('does not fetch an offscreen inline attachment until it approaches the viewport', async () => {
    let intersectionCallback!: IntersectionObserverCallback
    const fetchMock = jest.fn().mockResolvedValue({
      ...streamResponse(Uint8Array.from([37, 80, 68, 70])),
    })
    globalThis.fetch = fetchMock as typeof globalThis.fetch
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = '400px 0px'
      readonly thresholds = [0.01]
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      observe = jest.fn()
      disconnect = jest.fn()
      unobserve = jest.fn()
      takeRecords = jest.fn(() => [])
    } as unknown as typeof IntersectionObserver

    await act(async () => {
      root.render(
        createElement(InlineFileComponent, {
          className: { base: '', focus: '' },
          src: 'data:application/pdf;base64,JVBERg==',
          mimeType: 'application/pdf',
          fileName: 'offscreen.pdf',
          format: null,
          setFormat: jest.fn(),
          node: {} as InlineFileNode,
          nodeKey: 'offscreen-pdf',
          width: undefined,
          setWidth: jest.fn(),
          caption: undefined,
          setCaption: jest.fn(),
          float: 'none',
          setFloat: jest.fn(),
        }),
      )
      await Promise.resolve()
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-inline-preview-deferred="true"]')).not.toBeNull()

    const loadButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Load preview',
    )
    await act(async () => {
      loadButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-inline-pdf-bytes="37,80,68,70"]')).not.toBeNull()

    await act(async () => {
      intersectionCallback(
        [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-inline-pdf-bytes="37,80,68,70"]')).not.toBeNull()
  })

  it('routes an opaque but valid UTF-8 attachment to the safe text preview', async () => {
    const bytes = Uint8Array.from([104, 101, 108, 108, 111])
    globalThis.fetch = jest.fn().mockResolvedValue({
      ...streamResponse(bytes),
    }) as typeof globalThis.fetch

    await act(async () => {
      root.render(
        createElement(InlineFileComponent, {
          className: { base: '', focus: '' },
          src: 'data:application/octet-stream;base64,aGVsbG8=',
          mimeType: 'application/octet-stream',
          fileName: 'extensionless',
          format: null,
          setFormat: jest.fn(),
          node: {} as InlineFileNode,
          nodeKey: 'inline-text',
          width: undefined,
          setWidth: jest.fn(),
          caption: undefined,
          setCaption: jest.fn(),
          float: 'none',
          setFloat: jest.fn(),
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-inline-text-bytes="104,101,108,108,111"]')).not.toBeNull()
  })

  it('aborts a stalled inline preview and reaches a retryable terminal error state', async () => {
    jest.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      globalThis.fetch = jest.fn((_source, options) => {
        signal = options?.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }) as typeof globalThis.fetch

      await act(async () => {
        root.render(
          createElement(InlineFileComponent, {
            className: { base: '', focus: '' },
            src: 'https://example.invalid/stalled.pdf',
            mimeType: 'application/pdf',
            fileName: 'stalled.pdf',
            format: null,
            setFormat: jest.fn(),
            node: {} as InlineFileNode,
            nodeKey: 'stalled-pdf',
            width: undefined,
            setWidth: jest.fn(),
            caption: undefined,
            setCaption: jest.fn(),
            float: 'none',
            setFloat: jest.fn(),
          }),
        )
        await Promise.resolve()
      })
      expect(container.textContent).toContain('Loading file preview')

      await act(async () => {
        jest.advanceTimersByTime(INLINE_PREVIEW_IDLE_TIMEOUT_MS)
        await Promise.resolve()
      })

      expect(signal?.aborted).toBe(true)
      expect(container.textContent).toContain('Retry preview')
      expect(container.textContent).not.toContain('Loading file preview')
    } finally {
      jest.useRealTimers()
    }
  })

  it('fetches a remote image exactly once, validates it, and renders only an owned object URL', async () => {
    const sourceChunk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const fetchMock = jest.fn().mockResolvedValue(streamResponse(sourceChunk))
    globalThis.fetch = fetchMock as typeof fetch

    await renderInline({
      src: 'https://example.invalid/photo.png',
      mimeType: 'image/png',
      fileName: 'photo.png',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/photo.png',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    )
    expect(container.querySelector('[data-inline-image-src="blob:owned-inline-image"]')).not.toBeNull()
    expect(sourceChunk).toEqual(new Uint8Array(sourceChunk.byteLength))

    await renderInline({
      src: 'blob:replacement',
      mimeType: 'application/zip',
      fileName: 'replacement.zip',
    })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:owned-inline-image')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a remote image whose bytes contradict its declared allowlisted type', async () => {
    const pdfChunk = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const fetchMock = jest.fn().mockResolvedValue(streamResponse(pdfChunk))
    globalThis.fetch = fetchMock as typeof fetch

    await renderInline({
      src: 'https://example.invalid/not-an-image.png',
      mimeType: 'image/png',
      fileName: 'not-an-image.png',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(container.querySelector('[data-inline-image-src]')).toBeNull()
    expect(container.textContent).toContain('Retry preview')
    expect(pdfChunk).toEqual(new Uint8Array(pdfChunk.byteLength))
  })

  it('enforces the product upload cap and retries a failed save through the bounded source fetch', async () => {
    const oversized = streamResponse(new Uint8Array(), String(MAX_LOCAL_FILE_SIZE + 1))
    const savedChunk = new Uint8Array([1, 2, 3])
    const fetchMock = jest.fn().mockResolvedValueOnce(oversized).mockResolvedValueOnce(streamResponse(savedChunk))
    globalThis.fetch = fetchMock as typeof fetch
    const replace = jest.fn()
    const node = { replace } as unknown as InlineFileNode
    mockApplication.filesController.uploadNewFile.mockResolvedValue({ uuid: 'saved-file' })

    await renderInline({
      src: 'https://example.invalid/archive.zip',
      mimeType: 'application/zip',
      fileName: 'archive.zip',
      node,
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save to Files')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockApplication.filesController.uploadNewFile).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('maximum supported attachment size')

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Retry save')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mockApplication.filesController.uploadNewFile).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(savedChunk).toEqual(new Uint8Array(savedChunk.byteLength))
  })

  it('aborts a stalled save at the idle timeout and exposes a visible retry state', async () => {
    jest.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      globalThis.fetch = jest.fn((_source, options) => {
        signal = options?.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }) as typeof fetch

      await renderInline({
        src: 'https://example.invalid/stalled.zip',
        mimeType: 'application/zip',
        fileName: 'stalled.zip',
      })
      act(() => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Save to Files')
          ?.click()
      })
      expect(container.textContent).toContain('Saving...')

      await act(async () => {
        jest.advanceTimersByTime(INLINE_SAVE_IDLE_TIMEOUT_MS)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(signal?.aborted).toBe(true)
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('stopped responding')
      expect(container.textContent).toContain('Retry save')
      expect(container.textContent).not.toContain('Saving...')
    } finally {
      jest.useRealTimers()
    }
  })

  it('cancels a pending save when its source changes without uploading stale bytes', async () => {
    let signal: AbortSignal | undefined
    globalThis.fetch = jest.fn((_source, options) => {
      signal = options?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch

    await renderInline({
      src: 'https://example.invalid/first.zip',
      mimeType: 'application/zip',
      fileName: 'first.zip',
    })
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save to Files')
        ?.click()
    })
    await renderInline({
      src: 'blob:replacement',
      mimeType: 'application/zip',
      fileName: 'replacement.zip',
    })

    expect(signal?.aborted).toBe(true)
    expect(mockApplication.filesController.uploadNewFile).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Saving...')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
