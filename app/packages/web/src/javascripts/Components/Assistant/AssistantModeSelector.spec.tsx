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
  it('shows only an icon and abbreviation until the themed options are opened', async () => {
    const onChange = jest.fn()
    await act(async () => root.render(<AssistantModeSelector value="deep-research" onChange={onChange} />))
    const button = container.querySelector('button[aria-label="Assistant mode"]')!
    expect(button.textContent).toBe('Deep')
    expect(button.getAttribute('title')).toContain('Deep Research')
    await act(async () => {
      ;(button as HTMLButtonElement).click()
    })
    const choices = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(choices).toHaveLength(5)
    expect(choices[0].textContent).toBe('Chat')
    expect(choices[0].title).toContain('using read-only tools')
    await act(async () => {
      choices.find((choice) => choice.textContent?.startsWith('Plan'))!.click()
    })
    expect(onChange).toHaveBeenCalledWith('plan')
  })
  it('keeps the current mode disabled during an active run', async () => {
    await act(async () => root.render(<AssistantModeSelector value="research" onChange={jest.fn()} disabled />))
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
    expect(container.querySelector('button')?.textContent).toBe('Res.')
  })
})
