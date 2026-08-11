/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import InlineFileComponent from './InlineFileComponent'
import { InlineFileNode } from './InlineFileNode'

const mockEditor = {
  registerCommand: jest.fn(() => jest.fn()),
  update: jest.fn((callback: () => void) => callback()),
}
const mockApplication = {
  platform: 'web',
  generateUUID: jest.fn(() => 'generated-file'),
  filesController: { uploadNewFile: jest.fn() },
}

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('@lexical/react/useLexicalNodeSelection', () => ({
  useLexicalNodeSelection: () => [false, jest.fn()],
}))
jest.mock('@lexical/react/LexicalBlockWithAlignableContents', () => ({
  BlockWithAlignableContents: ({ children }: { children: import('react').ReactNode }) =>
    createElement('div', null, children),
}))
jest.mock('../ImageTools/SuperEmbeddedImage', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FilePreview/PdfPreview', () => ({
  __esModule: true,
  default: ({ bytes }: { bytes: Uint8Array }) =>
    createElement('div', { 'data-inline-pdf-bytes': Array.from(bytes).join(',') }, 'PDF preview'),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('InlineFileComponent PDF preview', () => {
  let container: HTMLElement
  let root: Root
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  })

  it('loads inline PDF bytes without an object embed or credential/referrer leakage', async () => {
    const bytes = Uint8Array.from([37, 80, 68, 70])
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(bytes.buffer),
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
})
