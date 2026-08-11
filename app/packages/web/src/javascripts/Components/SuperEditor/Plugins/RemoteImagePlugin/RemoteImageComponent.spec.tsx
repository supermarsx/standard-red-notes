/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import RemoteImageComponent from './RemoteImageComponent'
import { RemoteImageNode } from './RemoteImageNode'

const mockEditor = {
  registerCommand: jest.fn(() => jest.fn()),
  update: jest.fn((callback: () => void) => callback()),
}
const mockApplication = {
  platform: 'web',
  isNativeMobileWeb: jest.fn(() => false),
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
jest.mock('../ImageTools/SuperEmbeddedImage', () => ({
  __esModule: true,
  default: ({ src, onImageError, referrerPolicy }: { src: string; onImageError: () => void; referrerPolicy: string }) =>
    createElement('img', { src, onError: onImageError, referrerPolicy }),
}))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Utils', () => ({ isDesktopApplication: () => false }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('RemoteImageComponent failure handling', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('uses no-referrer and offers a hardened HTTPS fallback after a load failure', () => {
    act(() => {
      root.render(
        createElement(RemoteImageComponent, {
          className: { base: '', focus: '' },
          src: 'https://images.example.test/photo.png',
          alt: 'Photo',
          node: {} as RemoteImageNode,
          format: null,
          nodeKey: 'remote-image',
          setFormat: jest.fn(),
          width: undefined,
          setWidth: jest.fn(),
          caption: undefined,
          setCaption: jest.fn(),
          float: 'none',
          setFloat: jest.fn(),
        }),
      )
    })

    const image = container.querySelector('img') as HTMLImageElement
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    act(() => image.dispatchEvent(new Event('error', { bubbles: true })))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded')
    const fallback = container.querySelector('a') as HTMLAnchorElement
    expect(fallback.href).toBe('https://images.example.test/photo.png')
    expect(fallback.target).toBe('_blank')
    expect(new Set(fallback.rel.split(/\s+/))).toEqual(new Set(['noopener', 'noreferrer']))
    expect(fallback.getAttribute('referrerpolicy')).toBe('no-referrer')
  })
})
