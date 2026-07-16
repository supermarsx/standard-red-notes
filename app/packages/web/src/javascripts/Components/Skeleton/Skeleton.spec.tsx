/**
 * @jest-environment jsdom
 *
 * Skeleton loading primitives. jsdom does not evaluate CSS animations, so we
 * assert the rendered DOM contract (structure, row count, class merging, and
 * the accessibility affordances) rather than visual motion.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { SkeletonBlock, SkeletonCircle, SkeletonLine, SkeletonList } from '@/Components/Skeleton/Skeleton'

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

describe('Skeleton primitives', () => {
  it('render without crashing', () => {
    act(() => {
      root.render(
        createElement('div', null, [
          createElement(SkeletonLine, { key: 'line' }),
          createElement(SkeletonBlock, { key: 'block' }),
          createElement(SkeletonCircle, { key: 'circle' }),
          createElement(SkeletonList, { key: 'list' }),
        ]),
      )
    })
    expect(container.querySelectorAll('div').length).toBeGreaterThan(0)
  })

  it('applies a passed className onto the element', () => {
    act(() => {
      root.render(createElement(SkeletonLine, { className: 'w-1/3 custom-line' }))
    })
    const line = container.firstElementChild as HTMLElement
    expect(line.className).toContain('custom-line')
    // ...while keeping the base tokens.
    expect(line.className).toContain('bg-passive-3')
    expect(line.className).toContain('animate-pulse')
  })

  it('every primitive root carries animate-pulse (the class the reduced-motion allowlist keeps looping)', () => {
    // A frozen skeleton reads as broken; the _animation.scss allowlist exempts
    // `animate-pulse` from the reduced-motion clamp and re-asserts it as an
    // infinite loop. This is the DOM half of that contract.
    ;[SkeletonLine, SkeletonBlock, SkeletonCircle].forEach((Primitive) => {
      act(() => {
        root.render(createElement(Primitive))
      })
      const el = container.firstElementChild as HTMLElement
      expect(el.className).toContain('animate-pulse')
    })
  })

  it('applies width/height/size via inline style', () => {
    act(() => {
      root.render(createElement(SkeletonCircle, { size: '3rem' }))
    })
    const circle = container.firstElementChild as HTMLElement
    expect(circle.style.width).toBe('3rem')
    expect(circle.style.height).toBe('3rem')
    expect(circle.className).toContain('rounded-full')
  })
})

describe('SkeletonList', () => {
  it('renders exactly `count` rows', () => {
    act(() => {
      root.render(createElement(SkeletonList, { count: 9 }))
    })
    expect(container.querySelectorAll('[data-testid="skeleton-row"]').length).toBe(9)
  })

  it('defaults to 6 rows when no count is given', () => {
    act(() => {
      root.render(createElement(SkeletonList, {}))
    })
    expect(container.querySelectorAll('[data-testid="skeleton-row"]').length).toBe(6)
  })

  it('exposes an accessible loading status', () => {
    act(() => {
      root.render(createElement(SkeletonList, { label: 'Loading notes' }))
    })
    const status = container.querySelector('[role="status"]') as HTMLElement
    expect(status).not.toBeNull()
    expect(status.getAttribute('aria-busy')).toBe('true')
    const srLabel = status.querySelector('.sr-only')
    expect(srLabel?.textContent).toBe('Loading notes')
  })

  it('merges className onto the wrapper and rowClassName onto each row', () => {
    act(() => {
      root.render(createElement(SkeletonList, { count: 2, className: 'my-list', rowClassName: 'my-row' }))
    })
    const status = container.querySelector('[role="status"]') as HTMLElement
    expect(status.className).toContain('my-list')
    const rows = container.querySelectorAll('[data-testid="skeleton-row"]')
    rows.forEach((row) => expect(row.className).toContain('my-row'))
  })
})
