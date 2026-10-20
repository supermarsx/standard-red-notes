/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantActivityGroup from './AssistantActivityGroup'

jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('includes compact persisted counts when earlier tool cards were omitted', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <AssistantActivityGroup
          tools={[{ label: 'Fetch', outcome: 'succeeded' }]}
          omittedCounts={{ succeeded: 599, failed: 2 }}
        >
          Details
        </AssistantActivityGroup>,
      ),
    )
    expect(container.querySelector('summary')?.textContent).toBe('600 completed· 2 failed')
  } finally {
    act(() => root.unmount())
  }
})

it('keeps a working indicator while the answer is generating after completed tools', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const tools = [{ label: 'Read note', outcome: 'succeeded' as const }]
  try {
    act(() =>
      root.render(
        <AssistantActivityGroup tools={tools} streaming>
          Progress
        </AssistantActivityGroup>,
      ),
    )
    expect(container.querySelector('summary')?.textContent).toContain('Working…')
    act(() => root.render(<AssistantActivityGroup tools={tools}>Progress</AssistantActivityGroup>))
    expect(container.querySelector('summary')?.textContent).not.toContain('Working…')
  } finally {
    act(() => root.unmount())
  }
})

it('starts collapsed with the latest real pending activity and retains detailed actions when expanded', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const undo = jest.fn()
  try {
    act(() =>
      root.render(
        createElement(AssistantActivityGroup, {
          tools: [
            { label: 'Read notes', outcome: 'succeeded' },
            { label: 'Search notes' },
            { label: 'Read selected note' },
          ],
          selectableText: createElement('div', { 'aria-label': 'Activity updates' }, 'Inspecting the note.'),
          children: createElement('button', { onClick: undo }, 'Undo change'),
        }),
      ),
    )
    const details = container.querySelector('details')!
    const summary = container.querySelector('summary')!
    expect(details.open).toBe(false)
    expect(summary.textContent).toContain('Read selected note')
    expect(summary.textContent).toContain('Working…')
    expect(summary.textContent).not.toContain('Search notes')
    expect(container.querySelector('[aria-label="Activity updates"]')?.textContent).toBe('Inspecting the note.')
    expect(container.querySelector('button')).toBeNull()
    act(() => {
      summary.click()
      details.dispatchEvent(new Event('toggle'))
    })
    expect(details.open).toBe(true)
    act(() => container.querySelector('button')!.click())
    expect(undo).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
  }
})

it('keeps failed, denied and interrupted outcomes visible while collapsed without claiming they completed', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        createElement(AssistantActivityGroup, {
          tools: [
            { label: 'Update note', outcome: 'succeeded', changed: true },
            { label: 'Search', outcome: 'failed' },
            { label: 'Delete', outcome: 'denied' },
            { label: 'Read', outcome: 'interrupted' },
          ],
          children: 'Detailed tool cards',
        }),
      ),
    )
    expect(container.querySelector('details')!.open).toBe(false)
    expect(container.querySelector('summary')!.textContent).toBe(
      '1 completed· 1 failed· 1 denied· 1 interrupted· 1 changed',
    )
    expect(container.textContent).not.toContain('4 completed')
    act(() => root.render(createElement(AssistantActivityGroup, { tools: [], children: 'No work' })))
    expect(container.querySelector('details')).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})
