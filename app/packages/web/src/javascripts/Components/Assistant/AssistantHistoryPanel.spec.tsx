/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantHistoryPanel } from './AssistantHistoryPanel'
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('separates hidden active chats from trash, restores and purges only explicit targets', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const onDelete = jest.fn(async () => true),
    onRestore = jest.fn(async () => true),
    onPurge = jest.fn(async () => true),
    onEmptyTrash = jest.fn(async () => true)
  try {
    await act(async () =>
      root.render(
        <AssistantHistoryPanel
          tabs={[{ id: 'active', title: 'Hidden active', userRenamed: true }]}
          closedTabIds={['active']}
          trashedTabs={[{ id: 'trash', title: 'Trashed chat', userRenamed: true }]}
          onResume={jest.fn()}
          onRename={jest.fn()}
          onDelete={onDelete}
          onRestore={onRestore}
          onPurge={onPurge}
          onEmptyTrash={onEmptyTrash}
        />,
      ),
    )
    expect(container.textContent).toContain('Hidden active')
    expect(container.textContent).not.toContain('Trashed chat')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Move to trash: Hidden active"]')!.click(),
    )
    expect(onDelete).toHaveBeenCalledWith(['active'])
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Trash (1)')!.click(),
    )
    expect(container.textContent).not.toContain('Hidden active')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Restore Trashed chat"]')!.click())
    expect(onRestore).toHaveBeenCalledWith(['trash'])
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Permanently delete Trashed chat"]')!.click(),
    )
    expect(onPurge).toHaveBeenCalledWith(['trash'])
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Empty trash and clean deleted history')!
        .click(),
    )
    expect(onEmptyTrash).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
  }
})
