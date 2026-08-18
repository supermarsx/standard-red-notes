/** @jest-environment jsdom */

import { FileItem } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import FileComponent from './FileComponent'

const mockEditor = {
  registerCommand: jest.fn(() => jest.fn()),
  update: jest.fn((callback: () => void) => callback()),
}
let mockApplication: {
  items: {
    findItem: jest.Mock
    streamItems: jest.Mock
  }
  filesController: { uploadProgressMap: Map<string, unknown> }
  filePreviewModalController: { activate: jest.Mock }
}
const mockFilePreviewRender = jest.fn()

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('@lexical/react/useLexicalNodeSelection', () => ({
  useLexicalNodeSelection: () => [false, jest.fn()],
}))
jest.mock('@lexical/react/LexicalBlockWithAlignableContents', () => ({
  BlockWithAlignableContents: ({ children }: { children: import('react').ReactNode }) =>
    createElement('div', null, children),
}))
jest.mock('@/Components/FilePreview/FilePreview', () => ({
  __esModule: true,
  default: ({ file }: { file: FileItem }) => {
    mockFilePreviewRender(file.uuid)
    return createElement('div', { 'data-file-preview': file.uuid }, `Preview ${file.name}`)
  },
}))
jest.mock('mobx-react-lite', () => ({ observer: <T,>(component: T) => component }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: () => '1 KB' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FileComponent live attachment recovery', () => {
  let container: HTMLElement
  let root: Root
  let currentFile: FileItem | undefined
  let streamObserver: (change: { changed: FileItem[]; inserted: FileItem[]; removed: FileItem[] }) => void
  let disposeStream: jest.Mock
  let originalIntersectionObserver: typeof IntersectionObserver | undefined
  let mounted: boolean

  const render = (collapsed?: boolean) => {
    act(() => {
      root.render(
        createElement(FileComponent, {
          className: { base: '', focus: '' },
          format: null,
          setFormat: jest.fn(),
          nodeKey: 'file-node',
          fileUuid: 'file-1',
          zoomLevel: 1,
          setZoomLevel: jest.fn(),
          width: undefined,
          setWidth: jest.fn(),
          caption: undefined,
          setCaption: jest.fn(),
          float: 'none',
          setFloat: jest.fn(),
          collapsed,
          setCollapsed: jest.fn(),
        }),
      )
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mounted = true
    currentFile = undefined
    disposeStream = jest.fn()
    originalIntersectionObserver = globalThis.IntersectionObserver
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = undefined
    mockApplication = {
      items: {
        findItem: jest.fn(() => currentFile),
        streamItems: jest.fn((_type, observer) => {
          streamObserver = observer
          return disposeStream
        }),
      },
      filesController: { uploadProgressMap: new Map() },
      filePreviewModalController: { activate: jest.fn() },
    }
  })

  afterEach(() => {
    if (mounted) {
      act(() => root.unmount())
    }
    container.remove()
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
      originalIntersectionObserver
  })

  it('recovers when a synced FileItem arrives later, falls back without IntersectionObserver, and clears on removal', async () => {
    render(false)
    expect(container.textContent).toContain('Unable to find file file-1')

    currentFile = {
      uuid: 'file-1',
      name: 'photo.png',
      mimeType: 'image/png',
      decryptedSize: 1024,
    } as FileItem
    await act(async () => {
      streamObserver({ changed: [], inserted: [currentFile!], removed: [] })
      await Promise.resolve()
    })

    expect(container.querySelector('[data-file-preview="file-1"]')).not.toBeNull()

    const removed = currentFile
    currentFile = undefined
    act(() => streamObserver({ changed: [], inserted: [], removed: [removed] }))

    expect(container.querySelector('[data-file-preview]')).toBeNull()
    expect(container.textContent).toContain('Unable to find file file-1')
  })

  it('disposes the FileItem stream subscription', () => {
    render(false)
    act(() => root.unmount())
    mounted = false
    expect(disposeStream).toHaveBeenCalledTimes(1)
  })

  it('does not mount or decrypt an expanded preview until its host is near the viewport', async () => {
    let intersectionCallback!: IntersectionObserverCallback
    const observe = jest.fn()
    const disconnect = jest.fn()
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = '400px 0px'
      readonly thresholds = [0.01]

      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }

      observe = observe
      disconnect = disconnect
      unobserve = jest.fn()
      takeRecords = jest.fn(() => [])
    } as unknown as typeof IntersectionObserver
    currentFile = {
      uuid: 'file-1',
      name: 'offscreen.pdf',
      mimeType: 'application/pdf',
      decryptedSize: 1024,
    } as FileItem

    render(false)

    expect(observe).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-file-preview]')).toBeNull()
    expect(container.querySelector('[data-file-preview-deferred="true"]')).not.toBeNull()

    const loadButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Load preview',
    )
    expect(loadButton).not.toBeUndefined()
    await act(async () => {
      loadButton?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-file-preview="file-1"]')).not.toBeNull()
    expect(mockFilePreviewRender).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)

    await act(async () => {
      intersectionCallback(
        [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[data-file-preview="file-1"]')).not.toBeNull()
    expect(mockFilePreviewRender).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['PDF', 'document.pdf', 'application/pdf'],
    ['text', 'notes.txt', 'text/plain'],
    ['opaque binary', 'payload.bin', 'application/octet-stream'],
    ['active SVG markup', 'drawing.svg', 'image/svg+xml'],
    ['mislabeled image', 'document.pdf', 'image/png'],
  ])('keeps a default %s attachment compact until explicit expansion', (_label, name, mimeType) => {
    currentFile = {
      uuid: 'file-1',
      name,
      mimeType,
      decryptedSize: 1024,
    } as FileItem

    render(undefined)

    expect(container.querySelector('[data-file-preview]')).toBeNull()
    expect(container.textContent).toContain(name)
    expect(container.querySelector('button[aria-label="Expand file preview"]')).not.toBeNull()
  })

  it('preserves genuine supported image attachments as image-body previews', () => {
    currentFile = {
      uuid: 'file-1',
      name: 'photo.png',
      mimeType: 'image/png',
      decryptedSize: 1024,
    } as FileItem

    render(undefined)

    expect(container.querySelector('[data-file-preview="file-1"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Expand file preview"]')).toBeNull()
  })
})
