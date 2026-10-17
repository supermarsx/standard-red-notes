/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import AssistantView from './AssistantView'
const mockChatObservers = new Set<() => void>()
jest.mock('@/Assistant/assistantSyncedChats', () => ({
  ...jest.requireActual('@/Assistant/assistantSyncedChats'),
  AssistantSyncedChats: class {
    constructor(private application: WebApplication) {}
    private key() {
      return `test-synced-chats:${this.application.sessions.getUser()?.uuid}`
    }
    async read() {
      return this.application.storage.getValue(this.key()) ?? []
    }
    subscribe(callback: () => void) {
      mockChatObservers.add(callback)
      return () => mockChatObservers.delete(callback)
    }
    dispose() {}
    async updateMetadata(tab: unknown) {
      const rows = (await this.read()) as { tab: { id: string } }[]
      const next = rows.filter((row) => row.tab.id !== (tab as { id: string }).id)
      next.push({ tab } as never)
      this.application.storage.setValue(this.key(), next)
    }
    async delete(id: string) {
      this.application.storage.setValue(
        this.key(),
        ((await this.read()) as { tab: { id: string } }[]).filter((row) => row.tab.id !== id),
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
      getUser: () => ({ uuid: userUuid }),
    },
    protections: {
      isLocked: async () => locked,
    },
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
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
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
})
