/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantComposer from './AssistantComposer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps the same typing area after Send, explains the running controls, and routes Enter without submitting IME text', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const props = {
    input: 'follow up',
    configured: true,
    onInput: jest.fn(),
    onSend: jest.fn(),
    onSteer: jest.fn(),
    onQueue: jest.fn(),
    onStop: jest.fn(),
  }
  try {
    act(() => root.render(<AssistantComposer {...props} running={false} />))
    const input = container.querySelector('textarea')!
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(props.onSend).toHaveBeenCalledTimes(1)
    act(() => root.render(<AssistantComposer {...props} running />))
    expect(container.querySelector('textarea')).toBe(input)
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    expect(container.textContent).toContain('Guide response adds instructions now.')
    const click = (title: string) =>
      act(() => (container.querySelector(`[title="${title}"]`) as HTMLButtonElement).click())
    click('Send this message after the current response finishes')
    click('Stop this response and clear queued messages')
    expect(props.onQueue).toHaveBeenCalledTimes(1)
    expect(props.onStop).toHaveBeenCalledTimes(1)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })))
    expect(props.onSteer).not.toHaveBeenCalled()
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(props.onSteer).toHaveBeenCalledTimes(1)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true })))
    expect(props.onSteer).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
