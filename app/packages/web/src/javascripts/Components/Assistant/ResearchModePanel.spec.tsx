/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import { runResearchModeForApplication } from '@/Assistant/researchModeRunner'
import ResearchModePanel from './ResearchModePanel'

jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ presentPane: jest.fn() }) }))
jest.mock('@/Assistant/researchModeRunner', () => ({
  getResearchModeAvailability: () => ({ available: true }),
  runResearchModeForApplication: jest.fn(async () => null),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('names the tab from its topic and requests approved web research when starting', async () => {
  const application = {
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: 'account-a' }) },
    addEventObserver: () => () => undefined,
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onTopicChange = jest.fn()
  try {
    act(() => root.render(createElement(ResearchModePanel, { application, onClose: jest.fn(), onTopicChange })))
    const input = container.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, ' topic ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onTopicChange).toHaveBeenLastCalledWith(' topic ')
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Research & create note'),
    )!
    await act(async () => start.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onTopicChange).toHaveBeenLastCalledWith('topic')
    expect(runResearchModeForApplication).toHaveBeenCalledWith(application, 'topic', {
      webAccess: true,
      signal: expect.any(AbortSignal),
    })
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
