/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import SaveResearchReport from './SaveResearchReport'
const mockSave = jest.fn()
jest.mock('@/Assistant/saveResearchReport', () => ({
  researchReportTargets: () => [{ uuid: 'existing', title: 'Existing note' }],
  saveResearchReport: (...args: unknown[]) => mockSave(...args),
}))
it('requires destination confirmation and suppresses duplicate saves', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  let finish!: (value: string) => void
  mockSave.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  try {
    await act(async () =>
      root.render(
        <SaveResearchReport application={{} as WebApplication} report="Report [source]" reportId="report-1" />,
      ),
    )
    expect(mockSave).not.toHaveBeenCalled()
    await act(async () => host.querySelector('button')!.click())
    expect(mockSave).not.toHaveBeenCalled()
    const select = host.querySelector('select')!
    await act(async () => {
      select.value = 'existing'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const confirm = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Append findings',
    )!
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1]).toEqual({
      report: 'Report [source]',
      reportId: 'report-1',
      target: { kind: 'existing', noteUuid: 'existing' },
    })
    await act(async () => finish('existing'))
    expect(host.textContent).toContain('Findings saved')
  } finally {
    await act(async () => root.unmount())
  }
})
