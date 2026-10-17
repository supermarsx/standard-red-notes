/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent, ButtonType } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import AssistantView from './AssistantView'
const mockChatObservers = new Set<() => void>()
const mockPruneExpiredTrash = jest.fn<Promise<void>, []>()
const mockDeleteWait = jest.fn<Promise<void>, [string]>()
jest.mock('@/Assistant/assistantSyncedChats', () => ({
  ...jest.requireActual('@/Assistant/assistantSyncedChats'),
  AssistantSyncedChats: class {
    constructor(private application: WebApplication) {}
    private key() {
      return `test-synced-chats:${this.application.sessions.getUser()?.uuid}`
    }
    async read(options?: { includeTrashed?: boolean }) {
      const rows = (this.application.storage.getValue(this.key()) ?? []) as { tab: { id: string }; trashed?: boolean }[]
      return options?.includeTrashed ? rows : rows.filter((row) => !row.trashed)
    }
    async getStorageStats() {
      return {
        activeChats: 2,
        trashedChats: 0,
        deletedChats: 0,
        deletedResidualRecords: 0,
        writerRecords: 2,
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
      await mockDeleteWait(id)
      this.application.storage.setValue(
        this.key(),
        (await this.read({ includeTrashed: true })).map((row) => (row.tab.id === id ? { ...row, trashed: true } : row)),
      )
      mockChatObservers.forEach((listener) => listener())
    }
    async restore(id: string) {
      this.application.storage.setValue(
        this.key(),
        (await this.read({ includeTrashed: true })).map((row) => {
          return row.tab.id === id ? { ...row, trashed: false } : row
        }),
      )
      mockChatObservers.forEach((listener) => listener())
    }
    async emptyTrash() {
      this.application.storage.setValue(this.key(), await this.read())
      mockChatObservers.forEach((listener) => listener())
    }

    subscribe(callback: () => void) {
      mockChatObservers.add(callback)
      return () => mockChatObservers.delete(callback)
    }
    dispose() {}
    async pruneExpiredTrash() {
      await mockPruneExpiredTrash()
    }
    async updateMetadata(tab: unknown) {
      const rows = (await this.read()) as { tab: { id: string } }[]
      const next = rows.filter((row) => row.tab.id !== (tab as { id: string }).id)
      next.push({ tab } as never)
      this.application.storage.setValue(this.key(), next)
    }
    async purgeTrashed(id: string) {
      return this.delete(id)
    }
    async delete(id: string) {
      await mockDeleteWait(id)
      this.application.storage.setValue(
        this.key(),
        ((await this.read({ includeTrashed: true })) as { tab: { id: string } }[]).filter((row) => row.tab.id !== id),
      )
    }
  },
}))

jest.mock('./ConversationPanel', () => ({
  __esModule: true,
  default: ({
    conversationMode,
    onModeChange,
    onFirstUserMessage,
    isActive,
  }: {
    conversationMode: string
    onModeChange: (mode: string) => void
    onFirstUserMessage: (text: string) => void
    isActive: boolean
  }) => (
    <div data-chat-active={String(isActive)}>
      <select
        aria-label="Assistant mode"
        value={conversationMode}
        onChange={(event) => onModeChange(event.target.value)}
      >
        {['chat', 'agent', 'plan', 'research', 'deep-research'].map((mode) => (
          <option key={mode}>{mode}</option>
        ))}
      </select>
      <textarea aria-label="Draft" />
      <button aria-label="Seed conversation title" onClick={() => onFirstUserMessage('Saved project')}>
        Seed title
      </button>
    </div>
  ),
}))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('../Panes/ResponsivePaneProvider', () => ({
  useResponsiveAppPane: () => ({ dismissLastPane: jest.fn(), presentPane: jest.fn() }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ApplicationObserver = (event: ApplicationEvent) => Promise<void>

const createApplication = () => {
  let userUuid = 'account-a'
  let locked = false
  const observers = new Set<ApplicationObserver>()
  const values = new Map<string, unknown>()
  const application = {
    identifier: 'test-app',
    sessions: {
      isSignedIn: () => true,
      isCurrentSessionReadOnly: jest.fn(() => false),
      getUser: () => ({ uuid: userUuid }),
    },
    protections: {
      isLocked: async () => locked,
    },
    alerts: { confirm: jest.fn().mockResolvedValue(true) },
    storage: {
      getValue: (key: string) => values.get(key),
      setValue: (key: string, value: unknown) => {
        values.set(key, value)
      },
      setValueAndAwaitPersist: async (key: string, value: unknown) => {
        values.set(key, value)
      },
      removeValue: async (key: string) => {
        values.delete(key)
      },
    },
    addEventObserver: (observer: ApplicationObserver) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
  } as unknown as WebApplication

  return {
    application,
    values,
    setUserUuid: (next: string) => {
      userUuid = next
    },
    setLocked: (next: boolean) => {
      locked = next
    },
    emit: async (event: ApplicationEvent) => {
      await Promise.all([...observers].map((observer) => observer(event)))
    },
  }
}

const click = (element: Element) => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const renderAssistant = async (root: Root, application: WebApplication) => {
  await act(async () => {
    root.render(createElement(AssistantView, { application, id: 'assistant' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const choose = (select: HTMLSelectElement, mode: string) =>
  act(() => {
    select.value = mode
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })

describe('AssistantView shared conversation modes', () => {
  let container: HTMLElement
  let root: Root
  beforeEach(() => {
    mockChatObservers.clear()
    mockPruneExpiredTrash.mockReset().mockResolvedValue(undefined)
    mockDeleteWait.mockResolvedValue(undefined)
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.useRealTimers()
  })
  it('maintains trash on activation and hourly wake without overlapping or following an old account', async () => {
    jest.useFakeTimers({
      doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick'],
    })
    jest.setSystemTime(10000)
    const harness = createApplication()
    await renderAssistant(root, harness.application)
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(1)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(1)
    let finish!: () => void
    mockPruneExpiredTrash.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await act(async () => {
      jest.advanceTimersByTime(3600000)
      await Promise.resolve()
    })
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(2)
    await act(async () => {
      jest.advanceTimersByTime(3600000)
      await Promise.resolve()
    })
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(2)
    harness.setUserUuid('account-b')
    await act(async () => harness.emit(ApplicationEvent.SignedIn))
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(3)
    await act(async () => finish())
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(3)
  })

  it('surfaces a failed automatic cleanup and clears its own warning after a clock-reset focus retry', async () => {
    jest.useFakeTimers({
      doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick'],
    })
    jest.setSystemTime(10000)
    const harness = createApplication()
    mockPruneExpiredTrash.mockRejectedValueOnce(new Error('PRIVATE server detail'))
    await renderAssistant(root, harness.application)
    expect(container.textContent).toContain('Automatic chat trash cleanup could not complete')
    expect(container.textContent).not.toContain('PRIVATE server detail')
    jest.setSystemTime(5000)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(mockPruneExpiredTrash).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('Automatic chat trash cleanup could not complete')
  })

  it('does not automatically prune a read-only session', async () => {
    const harness = createApplication()
    jest.mocked(harness.application.sessions.isCurrentSessionReadOnly).mockReturnValue(true)
    await renderAssistant(root, harness.application)
    expect(mockPruneExpiredTrash).not.toHaveBeenCalled()
  })

  it('switches all five modes without replacing the mounted draft or creating another tab', async () => {
    const { application } = createApplication()
    await renderAssistant(root, application)
    const input = container.querySelector('textarea')!
    input.value = 'keep this draft'
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Assistant mode"]')!
    expect(select.value).toBe('agent')
    for (const mode of ['chat', 'plan', 'research', 'deep-research', 'agent']) {
      choose(select, mode)
      expect(select.value).toBe(mode)
      expect(container.querySelector('textarea')).toBe(input)
      expect(input.value).toBe('keep this draft')
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    }
    expect(container.querySelector('[aria-label="Deep research"]')).toBeNull()
  })
  it('restores legacy research tabs in the shared composer and persists explicit mode intent', async () => {
    const { application, values } = createApplication()
    values.set('test-synced-chats:account-a', [
      { tab: { id: 'legacy', title: 'Earlier research', kind: 'deep-research', userRenamed: false } },
    ])
    await renderAssistant(root, application)
    click(container.querySelector('[role="tab"][aria-label="Earlier research"]')!)
    const select = container.querySelector<HTMLSelectElement>(
      '[data-assistant-tab="legacy"] [aria-label="Assistant mode"]',
    )!
    expect(select.value).toBe('deep-research')
    choose(select, 'plan')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    const records = values.get('test-synced-chats:account-a') as {
      tab: { id: string; conversationMode: string; conversationModeUpdatedAt: number }
    }[]
    expect(records.find((record) => record.tab.id === 'legacy')?.tab).toMatchObject({
      conversationMode: 'plan',
      conversationModeUpdatedAt: expect.any(Number),
    })
  })
  it('drops the old account draft on account changes', async () => {
    const harness = createApplication()
    await renderAssistant(root, harness.application)
    const original = container.querySelector('textarea')!
    original.value = 'private draft'
    harness.setUserUuid('account-b')
    await act(async () => harness.emit(ApplicationEvent.SignedIn))
    expect(container.querySelector('textarea')).not.toBe(original)
    expect(container.querySelector('textarea')?.value).toBe('')
  })
  it('reveals a replacement conversation when the active one is deleted remotely', async () => {
    const { application, values } = createApplication()
    const first = { tab: { id: 'first', title: 'First', kind: 'chat', userRenamed: false } }
    const second = { tab: { id: 'second', title: 'Second', kind: 'research', userRenamed: false } }
    values.set('test-synced-chats:account-a', [first, second])
    await renderAssistant(root, application)
    expect(container.querySelector('[role="tab"][aria-label="Second"]')).toBeNull()
    values.set('test-synced-chats:account-a', [second])
    await act(async () => {
      mockChatObservers.forEach((callback) => callback())
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.querySelector('[role="tab"][aria-label="Second"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-assistant-tab="second"]')?.classList.contains('hidden')).toBe(false)
  })
  it('closing history and the last legacy research conversation creates a normal chat without reopening either', async () => {
    const { application, values } = createApplication()
    values.set('test-synced-chats:account-a', [
      { tab: { id: 'legacy', title: 'Earlier research', kind: 'research', userRenamed: false } },
    ])
    await renderAssistant(root, application)
    for (const close of [...container.querySelectorAll('[role="tab"] [aria-label="Close chat"]')]) {
      click(close)
    }
    click(container.querySelector('[aria-label="Chat history"]')!)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Open Assistant in editor tab"]')?.disabled).toBe(
      true,
    )
    click(container.querySelector('[aria-label="Close history"]')!)
    expect(container.querySelector('[role="tab"][aria-label="History"]')).toBeNull()
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector('[role="tab"][aria-label="Earlier research"]')).toBeNull()
    click(container.querySelector('[aria-label="Close chat"]')!)
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector<HTMLSelectElement>('[data-chat-active="true"] select')?.value).toBe('agent')
  })

  it('closes legacy tabs in one batch and leaves exactly one fresh conversation', async () => {
    const { application, values } = createApplication()
    values.set('test-synced-chats:account-a', [
      { tab: { id: 'research', title: 'Old research', kind: 'research', userRenamed: false } },
      { tab: { id: 'deep', title: 'Old deep research', kind: 'deep-research', userRenamed: false } },
    ])
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Restore closed chat"]')!)
    const closes = [...container.querySelectorAll('[role="tab"] [aria-label="Close chat"]')]
    expect(closes).toHaveLength(2)
    act(() => {
      closes.forEach((close) => close.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    })
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-label')).toBe('New chat')
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector<HTMLSelectElement>('[data-chat-active="true"] select')?.value).toBe('agent')
    click(container.querySelector('[aria-label="Close chat"]')!)
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-label')).toBe('New chat')
  })

  it('closing the last conversation dismisses history and opens only a fresh chat', async () => {
    const { application } = createApplication()
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Chat history"]')!)
    click(container.querySelector('[aria-label="Close chat"]')!)
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-label')).toBe('New chat')
    expect(container.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[aria-label="Close history"]')).toBeNull()
    expect(container.querySelector('textarea')?.value).toBe('')
  })

  it('confirms bulk deletion in history, keeps cancelled chats and then deletes the selected history', async () => {
    const { application, values } = createApplication()
    values.set('test-synced-chats:account-a', [
      { tab: { id: 'first', title: 'First', kind: 'chat', userRenamed: false } },
      { tab: { id: 'second', title: 'Second', kind: 'research', userRenamed: false } },
    ])
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Chat history"]')!)
    const history = container.querySelector('[aria-label="Assistant history"]')!
    click([...history.querySelectorAll('button')].find((button) => button.textContent === 'Select all')!)
    const remove = [...history.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Move selected to trash'),
    )!
    jest.mocked(application.alerts.confirm).mockResolvedValueOnce(false)
    await act(async () => remove.click())
    expect(history.querySelectorAll('li')).toHaveLength(2)
    expect(application.alerts.confirm).toHaveBeenCalledWith(
      expect.stringContaining('2 conversations'),
      expect.any(String),
      'Move to trash',
      ButtonType.Danger,
    )
    await act(async () => remove.click())
    expect(values.get('test-synced-chats:account-a')).toEqual([
      expect.objectContaining({ trashed: true }),
      expect.objectContaining({ trashed: true }),
    ])
    expect(container.querySelector('[role="tab"][aria-label="History"]')?.getAttribute('aria-selected')).toBe('true')
    expect(history.querySelector('[aria-label="Resume First"]')).toBeNull()
    expect(history.querySelector('[aria-label="Resume Second"]')).toBeNull()
  })

  it.each([
    { switchFocus: true, closeNeighbor: false },
    { switchFocus: true, closeNeighbor: true },
    { switchFocus: false, closeNeighbor: true },
  ])(
    'preserves focus and closed choices while deletion is pending (switch focus: $switchFocus, close neighbor: $closeNeighbor)',
    async ({ switchFocus, closeNeighbor }) => {
      const { application, values } = createApplication()
      values.set('test-synced-chats:account-a', [
        { tab: { id: 'first', title: 'First', kind: 'chat', userRenamed: false } },
        { tab: { id: 'second', title: 'Second', kind: 'chat', userRenamed: false } },
        { tab: { id: 'third', title: 'Third', kind: 'chat', userRenamed: false } },
      ])
      let finishDelete!: () => void
      mockDeleteWait.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDelete = resolve
          }),
      )
      await renderAssistant(root, application)
      click(container.querySelector('[aria-label="Restore closed chat"]')!)
      click(container.querySelector('[aria-label="Restore closed chat"]')!)
      const tab = (title: string) => container.querySelector<HTMLElement>(`[role="tab"][aria-label="${title}"]`)!
      click(tab('First'))
      act(() => tab('First').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
      click(
        [...container.querySelectorAll('[role="menuitem"]')].find(
          (item) => item.textContent?.trim() === 'Move chat to trash',
        )!,
      )
      await act(async () => {
        await Promise.resolve()
      })
      expect(mockDeleteWait).toHaveBeenCalledWith('first')
      if (switchFocus) {
        click(tab('Third'))
      }
      if (closeNeighbor) {
        act(() => tab('Second').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })))
      }
      expect(tab(switchFocus ? 'Third' : 'First').getAttribute('aria-selected')).toBe('true')
      await act(async () => finishDelete())
      expect(tab('First')).toBeNull()
      expect(tab('Third').getAttribute('aria-selected')).toBe('true')
      if (closeNeighbor) {
        expect(tab('Second')).toBeNull()
      }
    },
  )

  it('restores from trash and requires confirmation before permanent cleanup', async () => {
    const { application, values } = createApplication()
    values.set('test-synced-chats:account-a', [
      { tab: { id: 'trashed', title: 'Archived project', userRenamed: true }, trashed: true },
    ])
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Chat history"]')!)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const trashButton = () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Trash ('))!
    click(trashButton())
    expect(container.textContent).toContain('Archived project')
    jest.mocked(application.alerts.confirm).mockResolvedValueOnce(false)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Permanently delete Archived project"]')!.click(),
    )
    expect(values.get('test-synced-chats:account-a') as unknown[]).toHaveLength(1)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Restore Archived project"]')!.click(),
    )
    expect(values.get('test-synced-chats:account-a')).toEqual([expect.objectContaining({ trashed: false })])
    expect(container.querySelector('[aria-label="Permanently delete Archived project"]')).toBeNull()
  })

  it('renames a chat from history and saves the explicit title to synced metadata', async () => {
    const { application, values } = createApplication()
    values.set('test-synced-chats:account-a', [
      { tab: { id: 'first', title: 'First', kind: 'chat', userRenamed: false } },
    ])
    await renderAssistant(root, application)
    click(container.querySelector('[aria-label="Chat history"]')!)
    click(container.querySelector('[aria-label="Rename First"]')!)
    const input = container.querySelector<HTMLInputElement>('[aria-label="Chat title"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed project')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(container.querySelector('[aria-label="Resume Renamed project"]')).not.toBeNull()
    expect(values.get('test-synced-chats:account-a')).toEqual([
      expect.objectContaining({
        tab: expect.objectContaining({ id: 'first', title: 'Renamed project', userRenamed: true }),
      }),
    ])
  })

  it('does not bulk delete after the account changes while confirmation is open', async () => {
    const harness = createApplication()
    harness.values.set('test-synced-chats:account-a', [
      { tab: { id: 'first', title: 'First', kind: 'chat', userRenamed: false } },
    ])
    await renderAssistant(root, harness.application)
    click(container.querySelector('[aria-label="Chat history"]')!)
    let confirm!: (value: boolean) => void
    jest.mocked(harness.application.alerts.confirm).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve
        }),
    )
    click(container.querySelector('[aria-label="Move to trash: First"]')!)
    harness.setUserUuid('account-b')
    await act(async () => harness.emit(ApplicationEvent.SignedIn))
    await act(async () => confirm(true))
    expect(harness.values.get('test-synced-chats:account-a')).toEqual([
      { tab: { id: 'first', title: 'First', kind: 'chat', userRenamed: false } },
    ])
  })
})
