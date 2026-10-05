/**
 * @jest-environment jsdom
 *
 * Renders the REAL `SuperEmbeddedImage` (the component that owns the
 * `<img src={src}>` JSX) through `RemoteImageComponent`, and asserts on the
 * attribute of the real `<img>` element in the real DOM.
 *
 * Why it is written this way: a pasted `<img src="file:///C:/…">` — the shape
 * Word, Outlook and Windows Explorer put in the `text/html` clipboard flavour —
 * used to reach this attribute verbatim, and an https page asking for a
 * `file://` subresource is refused by the browser with
 *
 *   Security Error: Content at https://… may not load or link to file:///…
 *
 * A boolean assertion on a helper would pass whether or not anything actually
 * renders, so every case here reads `container.querySelector('img')` and the
 * `src` ATTRIBUTE it carries. The positive cases (https, data:) assert an
 * `<img>` IS produced, so a "fix" that simply stopped rendering images fails.
 */

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
  // Consumed by the REAL `usePreference` inside SuperEmbeddedImage.
  getPreference: jest.fn((_key: unknown, fallback: unknown) => fallback),
  addEventObserver: jest.fn(() => () => undefined),
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
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Utils', () => ({ isDesktopApplication: () => false }))
// SuperEmbeddedImage itself is NOT mocked — only its chrome, so the `<img>` is real.
jest.mock('../ImageTools/ImageResizer', () => ({ __esModule: true, default: () => null }))
jest.mock('../ImageTools/ImageToolbar', () => ({ __esModule: true, default: () => null }))
jest.mock('../ImageTools/ImageCaption', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TRANSPARENT_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('RemoteImageComponent — what actually lands in <img src>', () => {
  let container: HTMLElement
  let root: Root

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }),
    })
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (src: string) => {
    act(() => {
      root.render(
        createElement(RemoteImageComponent, {
          className: { base: '', focus: '' },
          src,
          alt: 'Pasted image',
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
  }

  it('still renders a real <img> carrying an https source verbatim', () => {
    render('https://images.example.test/photo.png')

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toBe('https://images.example.test/photo.png')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('still renders a real <img> for a data: source (img-src allows data:)', () => {
    render(TRANSPARENT_PNG_DATA_URL)

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toBe(TRANSPARENT_PNG_DATA_URL)
  })

  it('emits NO <img> at all for a pasted file:/// source, so the browser is never asked to load it', () => {
    render('file:///C:/Users/me/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png')

    // The assertion that matters: zero image elements in the rendered DOM.
    // Nothing can produce "may not load or link to file:///" if nothing asks.
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.innerHTML).not.toContain('file://')

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.getAttribute('data-unsafe-image-source')).toBe('true')
    expect(alert?.textContent).toContain('could not be loaded')
    // No "open in a new tab" escape hatch for a local path, and no Retry that
    // would only re-emit the same refused request.
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).not.toContain('Retry')
  })

  it.each(['sn-file://3f2ae1#page=2', 'javascript:alert(1)', 'about:blank'])(
    'emits no <img> for the unsupported scheme %s',
    (src) => {
      render(src)

      expect(container.querySelectorAll('img')).toHaveLength(0)
      expect(container.querySelector('[data-unsafe-image-source="true"]')).not.toBeNull()
    },
  )
})
