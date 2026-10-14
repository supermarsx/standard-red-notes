/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import Persistence from './Persistence'
import { STARTUP_BEHAVIOR_KEY, STARTUP_VIEW_KEY } from '@/Services/WorkspaceStartup/workspaceState'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
describe('startup choices', () => {
  it('defaults to all open tabs and saves new-note and specific-view choices', async () => {
    const setValue = jest.fn()
    const app = { getValue: () => undefined, setValue } as unknown as WebApplication
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<Persistence application={app} />))
      expect(container.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true)
      const label = (text: string) =>
        Array.from(container.querySelectorAll('label')).find((entry) => entry.textContent?.trim() === text)!
      await act(async () => label('A new note').click())
      expect(setValue).toHaveBeenCalledWith(STARTUP_BEHAVIOR_KEY, 'new-note')
      await act(async () => label('A specific view').click())
      await act(async () => {
        const select = container.querySelector('select')!
        select.value = AppPaneId.Calendar
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(setValue).toHaveBeenCalledWith(STARTUP_VIEW_KEY, AppPaneId.Calendar)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
