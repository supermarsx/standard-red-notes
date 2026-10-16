/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantChangeDiff from './AssistantChangeDiff'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('allocates large diff rows only while expanded and shows the latest patch on reopening', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const patch = Array.from({ length: 5000 }, (_, index) => `+line ${index}`).join('\n')
  const toggle = (open: boolean) =>
    act(() => {
      const details = container.querySelector('details')!
      details.open = open
      details.dispatchEvent(new Event('toggle'))
    })
  try {
    act(() => root.render(<AssistantChangeDiff patch={patch} noteTitle="Large note" />))
    expect(container.querySelector('pre')).toBeNull()
    expect(container.querySelectorAll('span')).toHaveLength(0)
    toggle(true)
    expect(container.querySelectorAll('pre span')).toHaveLength(5000)
    toggle(false)
    expect(container.querySelector('pre')).toBeNull()
    act(() => root.render(<AssistantChangeDiff patch="+latest" noteTitle="Large note" />))
    expect(container.querySelector('pre')).toBeNull()
    toggle(true)
    expect(container.querySelector('pre')?.textContent).toBe('+latest')
  } finally {
    act(() => root.unmount())
  }
})
