/** @jest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { WebApplication } from '@/Application/WebApplication'
import { runDeepResearchForApplication } from '@/Assistant/deepResearchRunner'
import DeepResearchPanel from './DeepResearchPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('@/Assistant/deepResearchRunner', () => ({
  getDeepResearchAvailability: () => ({ available: true }),
  runDeepResearchForApplication: jest.fn(),
}))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ presentPane: jest.fn() }) }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Button/Button', () => ({
  __esModule: true,
  default: ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
    <button disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}))

it('keeps web consent per investigation, reports its topic, and shows actual retrieved source links', async () => {
  const application = {
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: 'account-a' }) },
    addEventObserver: () => jest.fn(),
  } as unknown as WebApplication
  const run = jest.mocked(runDeepResearchForApplication)
  run.mockResolvedValue({
    question: 'topic',
    report: 'Finding [W1]',
    rounds: 1,
    stopReason: 'no-new-notes',
    sources: [],
    webEvidence: {
      status: 'retrieved',
      sources: [{ title: 'Source page', url: 'https://source.example/report', text: 'Evidence' }],
    },
  })
  const topic = jest.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    act(() => root.render(<DeepResearchPanel application={application} onClose={jest.fn()} onTopicChange={topic} />))
    act(() => {
      const textbox = container.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textbox, 'topic')
      textbox.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(topic).toHaveBeenCalledWith('topic')
    act(() => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Run deep research')!
        .click()
    })
    expect(run).toHaveBeenCalledWith(
      application,
      'topic',
      expect.objectContaining({ includeWeb: false, signal: expect.any(AbortSignal) }),
    )
    const link = container.querySelector('a')!
    expect(link.textContent).toBe('[W1] Source page')
    expect(link.getAttribute('href')).toBe('https://source.example/report')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
