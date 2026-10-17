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
const mockMetadata = jest.fn()
const mockRead = jest.fn()
jest.mock('@/Assistant/assistantSyncedChats', () => ({
  ...jest.requireActual('@/Assistant/assistantSyncedChats'),
  AssistantSyncedChats: class {
    async read(options?: { includeTrashed?: boolean }) {
      const rows = (await mockRead()) ?? mockRows
      return options?.includeTrashed ? rows : rows.filter((row: SyncedChat) => !row.trashed)
    }
    async getStorageStats() {
      return {
        activeChats: mockRows.filter((row) => !row.trashed).length,
        trashedChats: mockRows.filter((row) => row.trashed).length,
        deletedChats: 0,
        writerRecords: mockRows.length,
        lifecycleRecords: 0,
        invalidRecords: 0,
        serializedUnits: 100,
        budgetedSerializedUnits: 100,
        budgetedWriterRecords: 2,
        trashedSerializedUnits: 0,
        deletedSerializedUnits: 0,
        trashRetentionDays: 30,
        limits: { chats: 100, writersPerChat: 64, records: 512, serializedUnits: 10000, recordUnits: 1000 },
      }
    }
    async trash(id: string) {
      mockRows = mockRows.map((row) => (row.tab.id === id ? { ...row, trashed: true } : row))
      mockListeners.forEach((listener) => listener())
    }
    async restore(id: string) {
      mockRows = mockRows.map((row) => (row.tab.id === id ? { ...row, trashed: false } : row))
      mockListeners.forEach((listener) => listener())
    }
    async emptyTrash() {
      mockRows = mockRows.filter((row) => !row.trashed)
      mockListeners.forEach((listener) => listener())
    }

    subscribe(listener: () => void) {
      mockListeners.add(listener)
      return () => mockListeners.delete(listener)
    }
    dispose() {}
    async pruneExpiredTrash() {}
    async save(tab: SyncedChat['tab'], messages: SyncedChat['messages'], deniedToolNames: string[]) {
      await mockCheckpoint(tab, messages, deniedToolNames)
    }
    async updateMetadata(tab: SyncedChat['tab']) {
      await mockMetadata(tab)
    }
    async purgeTrashed(id: string) {
      return this.delete(id)
    }
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
    alerts: { confirm: jest.fn(async () => true) },
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
        .find((button) => button.textContent?.includes('Move chat to trash'))!
        .click(),
    )
    expect(mockRows.find((row) => row.tab.id === 'first')?.trashed).toBe(true)
    expect(application.alerts.confirm).toHaveBeenCalled()
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

it('keeps untouched new drafts out of a full synced catalog and seeds history with the chosen mode and title', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] })
  mockRows = Array.from({ length: 100 }, (_, index) => chat(`saved-${index}`, 'Existing chat'))
  mockListeners.clear()
  mockMetadata.mockRejectedValue(new Error('Synced chat storage is full.'))
  mockCheckpoint.mockResolvedValue(undefined)
  jest.mocked(ConversationPanel).mockImplementation(() => null)
  const application = {
    identifier: 'draft-host',
    sessions: { getUser: () => ({ uuid: 'account-a' }) },
    protections: { isLocked: async () => false },
    storage: { getValue: () => undefined },
    addEventObserver: () => () => undefined,
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const activeProps = () =>
    jest
      .mocked(ConversationPanel)
      .mock.calls.map(([props]) => props)
      .filter((props) => props.isActive)
      .at(-1)!
  try {
    await act(async () => root.render(<AssistantView application={application} id="draft-assistant" />))
    for (let count = 0; count < 5; count++) {
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click())
    }
    const draft = activeProps()
    await act(async () => {
      draft.onModeChange?.('plan')
      draft.onFirstUserMessage?.('A useful draft title')
      await draft.sharedChat!.checkpoint([], [])
      await jest.advanceTimersByTimeAsync(600)
    })
    expect(mockMetadata).not.toHaveBeenCalled()
    expect(mockCheckpoint).not.toHaveBeenCalled()
    expect(mockRows).toHaveLength(100)
    expect(container.textContent).not.toContain('Chat details could not be synced')
    const failure = new Error('Real storage failure')
    mockCheckpoint.mockRejectedValueOnce(failure)
    await expect(
      draft.sharedChat!.checkpoint([{ id: 'question', kind: 'user', text: 'Start this work' }], []),
    ).rejects.toBe(failure)
    await act(async () => {
      await draft.sharedChat!.checkpoint([{ id: 'question', kind: 'user', text: 'Start this work' }], [])
    })
    expect(mockCheckpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'A useful draft title', conversationMode: 'plan' }),
      expect.arrayContaining([expect.objectContaining({ text: 'Start this work' })]),
      [],
    )
  } finally {
    await act(async () => root.unmount())
    container.remove()
    jest.useRealTimers()
  }
})

it('keeps real existing-chat metadata failures visible and clears that warning only after a successful retry', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] })
  mockRows = [chat('existing', 'Saved message')]
  mockListeners.clear()
  mockMetadata.mockRejectedValue(new Error('Storage offline'))
  jest.mocked(ConversationPanel).mockImplementation(() => null)
  const application = {
    identifier: 'retry-host',
    sessions: { getUser: () => ({ uuid: 'account-a' }) },
    protections: { isLocked: async () => false },
    storage: { getValue: () => undefined },
    addEventObserver: () => () => undefined,
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const activeProps = () =>
    jest
      .mocked(ConversationPanel)
      .mock.calls.map(([props]) => props)
      .filter((props) => props.isActive)
      .at(-1)!
  try {
    await act(async () => root.render(<AssistantView application={application} id="retry-assistant" />))
    await act(async () => {
      activeProps().onModeChange?.('plan')
      await jest.advanceTimersByTimeAsync(600)
    })
    expect(container.textContent).toContain('Chat details could not be synced')
    mockMetadata.mockResolvedValue(undefined)
    await act(async () => {
      activeProps().onModeChange?.('agent')
      await jest.advanceTimersByTimeAsync(600)
    })
    expect(mockMetadata).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Chat details could not be synced')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    jest.useRealTimers()
  }
})

it('coalesces catalog event bursts into a single read and drains the latest invalidation without overlapping reads', async () => {
  mockRows = [chat('first', 'Initial')]
  mockListeners.clear()
  jest
    .mocked(ConversationPanel)
    .mockImplementation(({ sharedChat }) => (
      <p>{sharedChat?.history?.messages.map((message) => message.text).join(' ')}</p>
    ))
  const application = {
    identifier: 'burst-host',
    sessions: { getUser: () => ({ uuid: 'account-a' }) },
    protections: { isLocked: async () => false },
    storage: { getValue: () => undefined },
    addEventObserver: () => () => undefined,
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const pending: Array<(rows: SyncedChat[]) => void> = []
  let active = 0
  let maximumActive = 0
  try {
    await act(async () => root.render(<AssistantView application={application} id="burst-assistant" />))
    mockRead.mockClear()
    mockRead.mockImplementation(() => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      return new Promise<SyncedChat[]>((resolve) =>
        pending.push((rows) => {
          active -= 1
          resolve(rows)
        }),
      )
    })
    await act(async () => {
      for (let event = 0; event < 30; event++) {
        mockListeners.forEach((listener) => listener())
      }
    })
    expect(mockRead).toHaveBeenCalledTimes(1)
    await act(async () => pending[0]([chat('first', 'Intermediate')]))
    expect(mockRead).toHaveBeenCalledTimes(2)
    await act(async () => pending[1]([chat('first', 'Latest')]))
    expect(container.textContent).toContain('Latest')
    expect(maximumActive).toBe(1)
    expect(mockRead).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('preserves an unchanged open chat history identity when another chat receives an update', async () => {
  mockRows = [chat('first', 'Unchanged'), chat('second', 'Old remote content')]
  mockListeners.clear()
  jest.mocked(ConversationPanel).mockImplementation(() => null)
  const application = {
    identifier: 'identity-host',
    sessions: { getUser: () => ({ uuid: 'account-a' }) },
    protections: { isLocked: async () => false },
    storage: { getValue: () => undefined },
    addEventObserver: () => () => undefined,
  } as unknown as WebApplication
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const firstHistory = () =>
    jest
      .mocked(ConversationPanel)
      .mock.calls.map(([props]) => props)
      .filter((props) => props.tabId === 'first')
      .at(-1)!.sharedChat!.history
  try {
    await act(async () => root.render(<AssistantView application={application} id="identity-assistant" />))
    const previous = firstHistory()
    await act(async () => {
      mockRows = [JSON.parse(JSON.stringify(mockRows[0])), chat('second', 'New remote content')]
      mockListeners.forEach((listener) => listener())
    })
    expect(firstHistory()).toBe(previous)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
