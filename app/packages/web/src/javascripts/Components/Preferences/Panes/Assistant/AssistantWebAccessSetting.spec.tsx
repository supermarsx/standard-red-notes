/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantWebAccessSetting from './AssistantWebAccessSetting'
it('offers compact themed Allow, Safe and Strict choices with accurate explanations', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const onChange = jest.fn()
  try {
    await act(async () => root.render(<AssistantWebAccessSetting value="allow" disabled={false} onChange={onChange} />))
    const select = container.querySelector('select')!
    expect(Array.from(select.options).map((option) => option.text)).toEqual(['Allow (default)', 'Safe', 'Strict'])
    expect(select.className).toContain('bg-default')
    expect(container.textContent).toContain('without individual approvals')
    await act(async () => {
      select.value = 'safe'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('safe')
    await act(async () => root.render(<AssistantWebAccessSetting value="safe" disabled={false} onChange={onChange} />))
    expect(container.textContent).toContain('other URLs need approval')
    await act(async () => root.render(<AssistantWebAccessSetting value="strict" disabled={true} onChange={onChange} />))
    expect(select.disabled).toBe(true)
    expect(container.textContent).toContain('every page read')
  } finally {
    await act(async () => root.unmount())
  }
})
