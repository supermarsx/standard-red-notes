/** @jest-environment jsdom */
import { act, createElement, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import NotificationsPanel from './NotificationsPanel'
import type { NotificationsController } from '@/Controllers/NotificationsController'
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('offers the recovery button directly in the compact popup and closes it before navigating', async () => {
  const events: string[] = []
  const dismiss = jest.fn()
  const controller = {
    notifications: [
      {
        id: 'sync-failed',
        title: 'Sync problem',
        message: 'Retry',
        level: 'error',
        dismissable: true,
        action: { label: 'Resolve sync', run: () => events.push('navigate') },
      },
    ],
    isRead: () => false,
    dismiss,
    notifyViewOpened: () => {},
    notifyViewClosed: () => {},
  } as unknown as NotificationsController
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        createElement(NotificationsPanel, {
          controller,
          open: true,
          anchorElement: { current: null },
          togglePopover: () => events.push('close'),
        }),
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Resolve sync',
    )!
    await act(async () => {
      button.click()
    })
    expect(events).toEqual(['close', 'navigate'])
    expect(dismiss).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
