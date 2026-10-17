/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantToolPermissionSelector from './AssistantToolPermissionSelector'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('opens full permission choices from a compact current-policy control', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onChange = jest.fn()
  try {
    await act(async () => root.render(<AssistantToolPermissionSelector value="allow-read" onChange={onChange} />))
    const button = host.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe('Read')
    expect(button.getAttribute('aria-label')).toBe('Assistant tool permissions')
    expect(button.title).toContain('Reads allowed')
    await act(async () => button.click())
    const choices = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(choices).toHaveLength(5)
    await act(async () => choices.find((choice) => choice.textContent?.startsWith('Safe changes'))!.click())
    expect(onChange).toHaveBeenCalledWith('allow-safe')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
