/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AssistantModeSelector from './AssistantModeSelector'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Assistant mode explanations', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    })
    container = document.createElement('div')
    container.className = 'main-ui-view'
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  it('keeps compact native choices while explaining every mode and retaining selection behavior', async () => {
    const onChange = jest.fn()
    await act(async () => root.render(<AssistantModeSelector value="agent" onChange={onChange} />))
    const select = container.querySelector('select')!
    expect(select.getAttribute('aria-label')).toBe('Assistant mode')
    expect([...select.options].map((option) => option.text)).toEqual([
      'Chat',
      'Agent',
      'Plan',
      'Research',
      'Deep Research',
    ])
    expect(select.options[0].title).toContain('using read-only tools')
    expect(select.options[1].title).toContain('tool permissions')
    expect(select.options[2].title).toContain('without making changes')
    expect(select.options[3].title).toContain('configured and approved')
    expect(select.options[4].title).toContain('multiple research and refinement steps')
    expect(container.textContent).not.toContain('Discuss the selected context')
    await act(async () => {
      select.value = 'plan'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('plan')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      select.focus()
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    const tooltip = document.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain('Discuss the selected context')
    expect(tooltip?.textContent).toContain('Deep Research')
    expect(tooltip?.className).toContain('bg-contrast')
  })
  it('keeps the current mode disabled during an active run', async () => {
    await act(async () => root.render(<AssistantModeSelector value="research" onChange={jest.fn()} disabled />))
    expect(container.querySelector('select')?.disabled).toBe(true)
    expect(container.querySelector('select')?.value).toBe('research')
  })
})
