/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { isIOS } from '@standardnotes/ui-services'

import AssistantMessageActions from './AssistantMessageActions'

jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => <span aria-hidden="true" /> }))
jest.mock('@/Utils/copyTextToClipboard', () => ({ copyTextToClipboard: jest.fn() }))
jest.mock('@/NativeMobileWeb/useAndroidBackHandler', () => ({
  useAndroidBackHandler: () => () => () => undefined,
}))
jest.mock('@standardnotes/ui-services', () => ({
  ...jest.requireActual('@standardnotes/ui-services'),
  isIOS: jest.fn(() => true),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ImmediateResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as never)
  }

  unobserve() {}
  disconnect() {}
}

describe('AssistantMessageActions accessibility with the real Popover and Menu', () => {
  let container: HTMLElement
  let root: Root
  let originalMatchMedia: typeof window.matchMedia
  let originalResizeObserver: typeof ResizeObserver
  let originalAnimate: typeof HTMLElement.prototype.animate

  beforeEach(() => {
    jest.mocked(isIOS).mockReturnValue(true)
    originalMatchMedia = window.matchMedia
    originalResizeObserver = globalThis.ResizeObserver
    originalAnimate = HTMLElement.prototype.animate
    window.matchMedia = ((query: string) => ({
      matches: query === '(min-width: 768px)' || query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver
    HTMLElement.prototype.animate = (() =>
      ({
        currentTime: 0,
        finished: Promise.resolve(),
        cancel: () => undefined,
      }) as unknown as Animation) as typeof HTMLElement.prototype.animate
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.matchMedia = originalMatchMedia
    globalThis.ResizeObserver = originalResizeObserver
    HTMLElement.prototype.animate = originalAnimate
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  const renderActions = () => {
    act(() => {
      root.render(
        <AssistantMessageActions
          message={{ id: 'assistant-one', kind: 'assistant', text: 'Answer text' }}
          onRemoveMessage={() => undefined}
        >
          {(messageTextRef) => <div ref={messageTextRef}>Answer text</div>}
        </AssistantMessageActions>,
      )
    })
  }

  const flushEffects = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('keeps one ARIA owner intact across close and reopen and renders a real role=menu', async () => {
    renderActions()
    await flushEffects()
    const options = container.querySelector<HTMLButtonElement>('[aria-label="Message options"]')!
    expect(options.getAttribute('aria-haspopup')).toBe('true')
    expect(options.hasAttribute('aria-expanded')).toBe(false)

    act(() => options.click())
    await flushEffects()
    expect(options.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('menu[role="menu"][aria-label="Message context menu"]')).not.toBeNull()

    act(() => options.click())
    await flushEffects()
    expect(options.getAttribute('aria-haspopup')).toBe('true')
    expect(options.hasAttribute('aria-expanded')).toBe(false)

    act(() => options.click())
    await flushEffects()
    expect(options.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('menu[role="menu"][aria-label="Message context menu"]')).not.toBeNull()
  })

  it('restores focus to the direct point-anchor invoker on Escape', async () => {
    renderActions()
    const group = container.querySelector<HTMLElement>('[role="group"]')!
    act(() => group.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 22, clientY: 24 })))
    await flushEffects()
    const menu = document.querySelector<HTMLElement>('menu[role="menu"][aria-label="Message context menu"]')!
    expect(menu).not.toBeNull()

    act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await flushEffects()
    expect(document.activeElement).toBe(group)
    expect(document.querySelector('menu[role="menu"][aria-label="Message context menu"]')).toBeNull()
  })

  it('opens the point-anchored menu after an iOS long press', async () => {
    jest.useFakeTimers()
    renderActions()
    const group = container.querySelector<HTMLElement>('[role="group"]')!
    act(() => group.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 31, clientY: 33 })))
    expect(jest.getTimerCount()).toBeGreaterThan(0)
    act(() => jest.advanceTimersByTime(371))
    await flushEffects()

    expect(document.querySelector('menu[role="menu"][aria-label="Message context menu"]')).not.toBeNull()
  })
})
