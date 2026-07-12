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
    // Every other square is not pressed.
    for (const button of squareButtons) {
      if (button.getAttribute('title') !== 'Heading 1') {
        expect(button.getAttribute('aria-pressed')).toBe('false')
      }
    }
  })
})
