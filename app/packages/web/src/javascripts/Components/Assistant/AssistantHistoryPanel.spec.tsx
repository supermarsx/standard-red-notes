/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantHistoryPanel, AssistantRecentChats } from './AssistantHistoryPanel'
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('opens recent-chat actions by pointer or keyboard without resuming the chat', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const onResume = jest.fn()
  const onMenu = jest.fn()
  try {
    await act(async () =>
      root.render(
        <AssistantRecentChats
          tabs={[{ id: 'saved', title: 'Saved chat', userRenamed: true }]}
          currentTabId="new"
          onResume={onResume}
          onMenu={onMenu}
        />,
      ),
    )
    const row = container.querySelector('li')!
    act(() =>
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })),
    )
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ clientX: 20, clientY: 30 }), 'saved')
    act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click())
    expect(onMenu).toHaveBeenCalledTimes(2)
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })))
    expect(onMenu).toHaveBeenCalledTimes(3)
    expect(onResume).not.toHaveBeenCalled()
    act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(onResume).toHaveBeenCalledWith('saved')
  } finally {
    await act(async () => root.unmount())
  }
})
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
