/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import type { SyncedChat } from '@/Assistant/assistantSyncedChats'
import AssistantView from './AssistantView'
import ConversationPanel from './ConversationPanel'

let mockRows: SyncedChat[] = []
const mockListeners = new Set<() => void>()
const mockCheckpoint = jest.fn()
jest.mock('@/Assistant/assistantSyncedChats', () => ({
  AssistantSyncedChats: class {
    async read() {
      return mockRows
    }
    subscribe(listener: () => void) {
      mockListeners.add(listener)
      return () => mockListeners.delete(listener)
    }
    dispose() {}
    async save(tab: SyncedChat['tab'], messages: SyncedChat['messages'], deniedToolNames: string[]) {
      mockCheckpoint(tab, messages, deniedToolNames)
    }
    async updateMetadata() {}
    async delete(id: string) {
      mockRows = mockRows.filter((row) => row.tab.id !== id)
      mockListeners.forEach((listener) => listener())
    }
  },
}))
jest.mock('./ConversationPanel', () => ({
  __esModule: true,
  default: jest.fn(({ sharedChat }: { sharedChat?: { history?: SyncedChat } }) => (
    <p>{sharedChat?.history?.messages.map((message) => message.text).join(' ')}</p>
  )),
}))
jest.mock('./DeepResearchPanel', () => ({ __esModule: true, default: () => null }))
jest.mock('./ResearchModePanel', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ dismissLastPane: () => {} }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const chat = (id: string, text: string): SyncedChat => ({
  tab: { id, title: id, userRenamed: false },
  messages: [{ id: `message_${id}`, kind: 'user', text }],
  deniedToolNames: [],
})
it('follows remote chat updates without stealing focus, supports middle-click hide/restore, deletes across views, and fences old checkpoints on sign-out', async () => {
  jest
    .mocked(ConversationPanel)
    .mockImplementation(({ sharedChat }) => (
      <p>{sharedChat?.history?.messages.map((message) => message.text).join(' ')}</p>
    ))
  mockRows = [chat('first', 'Original')]
  mockListeners.clear()
  let user: { uuid: string } | undefined = { uuid: 'account-a' }
  const observers = new Set<(event: ApplicationEvent) => Promise<void>>()
  const application = {
    identifier: 'sync-host',
    sessions: { getUser: () => user },
    protections: { isLocked: async () => false },
    storage: { getValue: () => undefined },
    addEventObserver: (observer: (event: ApplicationEvent) => Promise<void>) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<AssistantView application={application} id="assistant" />))
    expect(container.textContent).toContain('Original')
    expect(container.textContent).not.toContain('already owned')
    const old = jest.mocked(ConversationPanel).mock.calls.at(-1)![0].sharedChat!
    await act(async () => {
      mockRows = [chat('first', 'Updated remotely'), chat('second', 'Second device')]
      mockListeners.forEach((listener) => listener())
    })
    expect(container.textContent).toContain('Updated remotely')
    expect(container.querySelector('[role="tab"][aria-label="first"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[role="tab"][aria-label="second"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click())
    const first = container.querySelector('[role="tab"][aria-label="first"]')!
    await act(async () =>
      first.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })),
    )
    expect(container.querySelector('[role="tab"][aria-label="first"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Restore closed chat"]')!.click())
    expect(container.querySelector('[role="tab"][aria-label="first"]')).not.toBeNull()
    await act(async () =>
      container
        .querySelector('[role="tab"][aria-label="first"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    )
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent?.includes('Delete'))!
        .click(),
    )
    expect(mockRows.map((row) => row.tab.id)).not.toContain('first')
    user = undefined
    await act(async () => {
      await Promise.all([...observers].map((observer) => observer(ApplicationEvent.SignedOut)))
    })
    await expect(old.checkpoint([{ id: 'old', kind: 'user', text: 'Private old account' }], [])).rejects.toThrow(
      'unavailable',
    )
    expect(mockCheckpoint).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
