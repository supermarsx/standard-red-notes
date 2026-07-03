/**
 * @jest-environment jsdom
 *
 * AssistantUsageMeter reset-clause guard. When the rolling window has already
 * elapsed, formatResetDuration returns 'now' — the meter must NOT print the
 * nonsensical "resets in now". A still-open window keeps the "resets in …" hint.
 */
import { createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import AssistantUsageMeter from '@/Components/Assistant/AssistantUsageMeter'
import { TokenWindowUsage } from '@/Assistant/usageMeter'

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

const window = (over: Partial<TokenWindowUsage>): TokenWindowUsage => ({
  usedTokens: 100,
  limitTokens: 1000,
  resetsAt: new Date().toISOString(),
  ...over,
})

const render = (props: Parameters<typeof AssistantUsageMeter>[0]): HTMLElement => {
  act(() => {
    root.render(createElement(AssistantUsageMeter, props))
  })
  return container
}

describe('AssistantUsageMeter', () => {
  it('does NOT render the reset clause for an already-elapsed window', () => {
    const el = render({ fiveHour: window({ resetsAt: new Date(Date.now() - 60_000).toISOString() }), weekly: undefined })
    expect(el.textContent).not.toContain('resets')
  })

  it('renders the "resets in …" hint for a still-open window', () => {
    const el = render({ fiveHour: window({ resetsAt: new Date(Date.now() + 45 * 60_000).toISOString() }), weekly: undefined })
    expect(el.textContent).toContain('resets in')
    expect(el.textContent).not.toContain('resets in now')
  })
})
