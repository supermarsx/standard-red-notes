/**
 * @jest-environment jsdom
 *
 * AssistantUsageMeter reset-clause guard. When the rolling window has already
 * elapsed, formatResetDuration returns 'now' — the meter must NOT print the
 * nonsensical "resets in now". A still-open window keeps the "resets in …" hint.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
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
  it('shows actual call input/output and reported totals without inventing a context limit', () => {
    const el = render({
      fiveHour: undefined,
      weekly: undefined,
      chat: { calls: 2, reportedCalls: 1, input: 100, output: 25, last: { input: 100, output: 25 } },
    })
    expect(el.textContent).toContain('Last call · In 100 · Out 25')
    expect(el.textContent).toContain('This open chat · In 100 · Out 25 · 1/2 calls reported')
    expect(el.textContent).toContain('Input context · 100 · limit not reported')
    expect(el.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('shows known context percentage only from a reported limit, alongside existing account windows', () => {
    const el = render({
      fiveHour: window({}),
      weekly: undefined,
      chat: { calls: 1, reportedCalls: 1, last: { input: 80, output: 12, contextLimit: 100 } },
    })
    expect(el.textContent).toContain('Input context · 80 / 100 (80%)')
    expect(el.querySelector('[aria-label="Last call input context usage"]')?.getAttribute('aria-valuenow')).toBe('80')
    expect(el.querySelector('[aria-label="5-hour AI token usage"]')).not.toBeNull()
  })

  it('shows missing latest token reports as unknown even when earlier chat totals exist', () => {
    const el = render({
      fiveHour: undefined,
      weekly: undefined,
      chat: { calls: 2, reportedCalls: 1, input: 100, output: 25, last: {} },
    })
    expect(el.textContent).toContain('Last call · In not reported · Out not reported')
    expect(el.textContent).toContain('This open chat · In 100 · Out 25')
  })
  it('does NOT render the reset clause for an already-elapsed window', () => {
    const el = render({
      fiveHour: window({ resetsAt: new Date(Date.now() - 60_000).toISOString() }),
      weekly: undefined,
    })
    expect(el.textContent).not.toContain('resets')
  })

  it('renders the "resets in …" hint for a still-open window', () => {
    const el = render({
      fiveHour: window({ resetsAt: new Date(Date.now() + 45 * 60_000).toISOString() }),
      weekly: undefined,
    })
    expect(el.textContent).toContain('resets in')
    expect(el.textContent).not.toContain('resets in now')
  })
})
