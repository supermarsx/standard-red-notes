/**
 * @jest-environment jsdom
 *
 * Spinner primitive. jsdom does not evaluate CSS animations, so we assert the
 * rendered DOM contract (the `animate-spin` class the reduced-motion allowlist
 * keeps looping, the sane default size, and the `border-r-transparent` gap that
 * makes the rotation visible) rather than visual motion.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import Spinner from '@/Components/Spinner/Spinner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const renderSpinner = (props: { className?: string; contrast?: boolean } = {}): HTMLElement => {
  act(() => {
    root.render(createElement(Spinner, props))
  })
  return container.firstElementChild as HTMLElement
}

describe('Spinner', () => {
  it('always carries animate-spin (the class the reduced-motion allowlist keeps looping)', () => {
    const el = renderSpinner()
    expect(el.className).toContain('animate-spin')
  })

  it('applies a sane default h-4 w-4 size when no width/height class is passed', () => {
    const el = renderSpinner()
    expect(el.className).toContain('h-4')
    expect(el.className).toContain('w-4')
  })

  it('does NOT inject the default size when the caller passes a size class', () => {
    const el = renderSpinner({ className: 'h-6 w-6' })
    expect(el.className).toContain('h-6')
    expect(el.className).toContain('w-6')
    // The default must not also be present, or it would fight the caller's size.
    expect(el.className).not.toContain('h-4')
    expect(el.className).not.toContain('w-4')
  })

  it('default (non-contrast) variant renders border-info and the visible spin gap last', () => {
    const el = renderSpinner()
    expect(el.className).toContain('border-info')
    expect(el.className).toContain('border-r-transparent')
    // border-r-transparent must win source order → be the last color token.
    expect(el.className.trim().endsWith('border-r-transparent')).toBe(true)
  })

  it('contrast variant renders border-info-contrast and still ends with the spin gap', () => {
    const el = renderSpinner({ contrast: true })
    expect(el.className).toContain('border-info-contrast')
    expect(el.className).toContain('border-r-transparent')
    // Gap emitted LAST so it wins over the contrast color and stays visible.
    expect(el.className.trim().endsWith('border-r-transparent')).toBe(true)
  })

  it('merges a caller className while preserving the base ring tokens', () => {
    const el = renderSpinner({ className: 'mx-2.5 h-4 w-4' })
    expect(el.className).toContain('mx-2.5')
    expect(el.className).toContain('rounded-full')
    expect(el.className).toContain('border')
    expect(el.className).toContain('border-solid')
  })
})
