/**
 * @jest-environment jsdom
 *
 * Render contract for `BlockStyleGalleryBar` after the block-section restack
 * (task t37): the gallery bar is now a PURE full-width squares track — the
 * "Edit styles" pill button moved OUT to the caller's first-line button row, so
 * it must no longer appear inside this component. jsdom has no ResizeObserver
 * and reports a 0px `getBoundingClientRect`, so we install a no-op observer plus
 * a 2000px-wide `getBoundingClientRect` (the width the effect reads on mount) to
 * make every preview square fit inline (no overflow "▾" / Popover), then assert
 * the squares render and the Edit-styles control is absent here. (2000px, not
 * 1000px, so all 16 squares — grown from the 7 new block styles in task t40 —
 * still fit inline at GALLERY_SQUARE_WIDTH=88+gap.)
 */
import { createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import BlockStyleGalleryBar from '@/Components/SuperEditor/Plugins/ToolbarPlugin/BlockStyleGallery'
import {
  GALLERY_BLOCKS,
  GalleryBlockDescriptor,
  orderGalleryBlocks,
} from '@/Components/SuperEditor/Plugins/ToolbarPlugin/typographyGallery'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The gallery's overflow toggle renders a (closed) Popover whose subtree reads
// the ApplicationProvider + AndroidBackHandler contexts (they throw when
// absent); the very first render happens at a 0px track width — before the
// ResizeObserver effect widens it — so that Popover mounts at least once. Wrap
// every mount in both contexts, backed by a minimal fake app (same pattern as
// NoteTabBar.spec).
const fakeApp = {
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
} as never

// A real ResizeObserver.observe fires asynchronously, so the effect's initial
// width comes from getBoundingClientRect; mirror that here (no-op observer +
// stubbed width) rather than firing the callback synchronously.
class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLElement
let root: Root
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  // jsdom has no matchMedia; the (closed) overflow Popover's useMediaQuery needs it.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return { width: 2000, height: 40, top: 0, left: 0, right: 2000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

const render = (
  extraProps: { activeBlockType?: string; activeBlockStyle?: string; blocks?: GalleryBlockDescriptor[] } = {},
) => {
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application: fakeApp,
        children: createElement(AndroidBackHandlerProvider, {
          application: fakeApp,
          children: createElement(BlockStyleGalleryBar, {
            profile: null,
            onApplyBlock: () => undefined,
            ...extraProps,
          }),
        }),
      }),
    )
  })
}

describe('BlockStyleGalleryBar (post-restack)', () => {
  it('renders every block-style preview square inline when the track is wide', () => {
    render()
    // Each square is a <button> titled with its block label; a wide track fits
    // them all inline (no overflow toggle).
    const squareButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      GALLERY_BLOCKS.some((d) => b.getAttribute('title') === d.label),
    )
    expect(squareButtons.length).toBe(GALLERY_BLOCKS.length)
    expect(container.textContent).toContain('Heading 1')
    expect(container.textContent).toContain('Checklist')
  })

  it('no longer renders an "Edit styles" control (it moved to the caller\'s first line)', () => {
    render()
    expect(container.textContent).not.toContain('Edit styles')
    const editStyles = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.getAttribute('title') ?? '').startsWith('Edit styles'),
    )
    expect(editStyles.length).toBe(0)
  })

  it('exposes a single full-width track (w-full) as the measured root', () => {
    render()
    const rootEl = container.firstElementChild as HTMLElement
    expect(rootEl).not.toBeNull()
    expect(rootEl.className).toContain('w-full')
  })

  it('wraps each preview in a fit-scaling layer (transform: scale) so oversized samples stay visible', () => {
    render()
    const scaled = Array.from(container.querySelectorAll('div')).filter((d) =>
      (d.getAttribute('style') ?? '').includes('scale('),
    )
    expect(scaled.length).toBe(GALLERY_BLOCKS.length) // one scaling wrapper per inline square
  })

  it('renders the new default order: first square is Normal, second is Normal (spaced)', () => {
    render()
    const squareButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      GALLERY_BLOCKS.some((d) => b.getAttribute('title') === d.label),
    )
    expect(squareButtons[0]?.getAttribute('title')).toBe('Normal')
    expect(squareButtons[1]?.getAttribute('title')).toBe('Normal (spaced)')
  })

  it('honours an injected block order: a reordered `blocks` prop renders Code first', () => {
    render({ blocks: orderGalleryBlocks(['code']) })
    const squareButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      GALLERY_BLOCKS.some((d) => b.getAttribute('title') === d.label),
    )
    expect(squareButtons[0]?.getAttribute('title')).toBe('Code')
    // The injected order is still the complete set (merge appends the rest).
    expect(squareButtons.length).toBe(GALLERY_BLOCKS.length)
  })

  it('marks the square matching the active block type as pressed (and only that one)', () => {
    render({ activeBlockType: 'h1' })
    const squareButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      GALLERY_BLOCKS.some((d) => b.getAttribute('title') === d.label),
    )
    const heading1 = squareButtons.find((b) => b.getAttribute('title') === 'Heading 1')
    expect(heading1?.getAttribute('aria-pressed')).toBe('true')
    // Every other square (other than a "Heading 1"-titled one — the leading
    // indicator is a second "Heading 1" and is also pressed) is not pressed.
    for (const button of squareButtons) {
      if (button.getAttribute('title') !== 'Heading 1') {
        expect(button.getAttribute('aria-pressed')).toBe('false')
      }
    }
  })
})

describe('BlockStyleGalleryBar leading "current style" indicator', () => {
  // Titled preview-square buttons in DOM order (both the persistent leading
  // indicator and the in-track copies match a descriptor label).
  const titledSquares = () =>
    Array.from(container.querySelectorAll('button')).filter((b) =>
      GALLERY_BLOCKS.some((d) => b.getAttribute('title') === d.label),
    )

  it('renders the active style up front: the FIRST titled square is the active one and is pressed', () => {
    render({ activeBlockType: 'h1' })
    const squares = titledSquares()
    // The leading indicator precedes the in-track copy, so the very first titled
    // square is the active "Heading 1"…
    expect(squares[0]?.getAttribute('title')).toBe('Heading 1')
    expect(squares[0]?.getAttribute('aria-pressed')).toBe('true')
    // …and it is a genuine second "Heading 1" (leading + in-track), both pressed.
    const heading1s = squares.filter((b) => b.getAttribute('title') === 'Heading 1')
    expect(heading1s.length).toBe(2)
    for (const b of heading1s) {
      expect(b.getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('tracks the active type live: re-rendering with a new active type updates the leading square', () => {
    render({ activeBlockType: 'h1' })
    expect(titledSquares()[0]?.getAttribute('title')).toBe('Heading 1')
    // Same root, new active block type → the leading square follows the selection.
    render({ activeBlockType: 'quote' })
    const squares = titledSquares()
    expect(squares[0]?.getAttribute('title')).toBe('Quote')
    expect(squares[0]?.getAttribute('aria-pressed')).toBe('true')
    // The leading "Heading 1" is gone; only the in-track Quote + leading Quote remain.
    expect(squares.filter((b) => b.getAttribute('title') === 'Heading 1').length).toBe(1)
    expect(squares.filter((b) => b.getAttribute('title') === 'Quote').length).toBe(2)
  })

  it('shows a neutral "None" placeholder (no titled duplicate) when the active block has no gallery match', () => {
    render({ activeBlockType: 'h6' })
    // h6 → resolveActiveGalleryKey null → leading slot is the placeholder.
    expect(container.textContent).toContain('None')
    // The placeholder is NOT a titled descriptor button, so the titled-square count
    // stays exactly the palette size (no leading duplicate).
    expect(titledSquares().length).toBe(GALLERY_BLOCKS.length)
    // No square is pressed (nothing in the palette matches h6).
    for (const b of titledSquares()) {
      expect(b.getAttribute('aria-pressed')).toBe('false')
    }
  })
})
