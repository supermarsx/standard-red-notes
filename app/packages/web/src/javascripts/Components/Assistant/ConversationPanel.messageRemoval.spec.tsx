/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ApplicationEvent } from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'

import {
  AssistantChatHistoryStorage,
  PersistedAssistantMessage,
  persistAssistantChatHistoryStrict,
  readAssistantChatHistoryResult,
} from '@/Assistant/assistantChatHistory'
import { buildContextForSelection } from '@/Assistant/assistantContextSource'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import ConversationPanel from './ConversationPanel'

jest.mock('@/Assistant/assistantContextSource', () => ({
  buildContextForSelection: jest.fn(() => ({
    scope: 'current-note',
    noteCount: 0,
    characters: 0,
    truncated: false,
    noteTitles: [],
    noteUuids: [],
    omittedNoteCount: 0,
    text: '',
  })),
  resolveContextNoteUuids: jest.fn(() => []),
}))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))
jest.mock('./ContextSelector', () => ({ __esModule: true, default: () => <div data-context-selector /> }))
jest.mock('./AssistantUsageMeter', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => <span /> }))
jest.mock('@/Components/Button/Button', () => ({
  __esModule: true,
  default: ({ label }: { label: string }) => <button>{label}</button>,
}))
jest.mock('./AssistantMessageActions', () => ({
  __esModule: true,
  default: ({
    message,
    children,
    onRemoveMessage,
  }: {
    message: { id: string }
    children: (ref: { current: HTMLDivElement | null }) => React.ReactNode
    onRemoveMessage: (id: string) => void
  }) => (
    <div data-message-id={message.id}>
      {children({ current: null })}
      <button aria-label={`Remove ${message.id}`} onClick={() => onRemoveMessage(message.id)} />
    </div>
  ),
}))
jest.mock('@standardnotes/ui-services', () => ({
  ...jest.requireActual('@standardnotes/ui-services'),
  confirmDialog: jest.fn(),
}))
jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLElement.prototype.scrollTo = jest.fn()

const accountScope = 'anonymous:test-app:dock:device-one'
const tabId = 'chat-one'

describe('ConversationPanel message removal persistence', () => {
  let container: HTMLElement
  let root: Root
  let rootIsMounted: boolean
  let values: Map<string, unknown>
  let storage: AssistantChatHistoryStorage
  let signedIn: boolean
  let userUuid: string | undefined
  let applicationEventObserver: ((event: ApplicationEvent) => void | Promise<void>) | undefined
  let application: {
    identifier: string
    storage: AssistantChatHistoryStorage
    sessions: { isSignedIn: () => boolean; getUser: () => { uuid: string } | undefined }
    getPreference: (_key: unknown, fallback: unknown) => unknown
    setPreference: jest.Mock
    addEventObserver: jest.Mock
    items: { addObserver: jest.Mock }
    itemListController: {
      activeControllerItem: undefined
      selectedItemsCount: number
      firstSelectedItem: undefined
    }
    itemControllerGroup: { itemControllers: never[] }
  }

  const persist = async (messages: PersistedAssistantMessage[]) => {
    await persistAssistantChatHistoryStrict(storage, accountScope, tabId, messages)
  }

  const runPersistence = async (operation: () => Promise<void>) => {
    await operation()
    return true
  }

  const renderPanel = (persistenceRunner: (operation: () => Promise<void>) => Promise<boolean> = runPersistence) => {
    act(() => {
      root.render(
        <ConversationPanel
          application={application as never}
          tabId={tabId}
          accountScope={accountScope}
          persistenceAllowed={true}
          runPersistence={persistenceRunner}
        />,
      )
    })
    rootIsMounted = true
  }

  beforeEach(() => {
    values = new Map()
    signedIn = false
    userUuid = undefined
    applicationEventObserver = undefined
    storage = {
      getValue: <T,>(key: string) => values.get(key) as T,
      setValue: (key, value) => values.set(key, value),
      setValueAndAwaitPersist: jest.fn(async (key: string, value: unknown) => {
        values.set(key, value)
      }),
      removeValue: jest.fn(async (key: string) => {
        values.delete(key)
      }),
    }
    application = {
      identifier: 'test-app',
      storage,
      sessions: {
        isSignedIn: () => signedIn,
        getUser: () => (userUuid ? { uuid: userUuid } : undefined),
      },
      getPreference: (_key, fallback) => fallback,
      setPreference: jest.fn(async () => undefined),
      addEventObserver: jest.fn((observer: (event: ApplicationEvent) => void | Promise<void>) => {
        applicationEventObserver = observer
        return () => undefined
      }),
      items: { addObserver: jest.fn(() => () => undefined) },
      itemListController: {
        activeControllerItem: undefined,
        selectedItemsCount: 0,
        firstSelectedItem: undefined,
      },
      itemControllerGroup: { itemControllers: [] },
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    rootIsMounted = false
    jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
    jest.mocked(buildContextForSelection).mockReturnValue({
      scope: 'current-note',
      noteCount: 0,
      characters: 0,
      truncated: false,
      noteTitles: [],
      noteUuids: [],
      omittedNoteCount: 0,
      text: '',
    })
    jest.mocked(confirmDialog).mockResolvedValue(true)
  })

  afterEach(() => {
    if (rootIsMounted) {
      act(() => root.unmount())
    }
    container.remove()
    localStorage.clear()
    jest.clearAllMocks()
  })

  it('removes only the chosen id, flushes immediately, and stays removed after reload', async () => {
    await persist([
      { kind: 'user', id: 'remove-me', text: 'same text' },
      { kind: 'user', id: 'keep-me', text: 'same text' },
      { kind: 'assistant', id: 'answer', text: 'answer', activities: [] },
    ])
    renderPanel()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove remove-me"]')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const stored = readAssistantChatHistoryResult(storage, accountScope, tabId)
    expect(stored.status).toBe('found')
    expect(stored.status === 'found' ? stored.messages.map((message) => message.id) : []).toEqual(['keep-me', 'answer'])
    expect(container.querySelector('[data-message-id="remove-me"]')).toBeNull()
    expect(container.querySelector('[data-message-id="keep-me"]')).not.toBeNull()

    act(() => root.unmount())
    rootIsMounted = false
    root = createRoot(container)
    renderPanel()
    expect(container.querySelector('[data-message-id="remove-me"]')).toBeNull()
    expect(container.querySelector('[data-message-id="keep-me"]')).not.toBeNull()
  })

  it('requires confirmation before removing tool activity', async () => {
    await persist([
      {
        kind: 'assistant',
        id: 'tool-message',
        text: 'Finished',
        activities: [{ id: 'tool-one', name: 'search_notes', label: 'Searched notes', outcome: 'succeeded' }],
      },
    ])
    jest.mocked(confirmDialog).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderPanel()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove tool-message"]')!.click()
      await Promise.resolve()
    })
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ confirmButtonText: 'Remove', confirmButtonStyle: 'danger' }),
    )
    expect(container.querySelector('[data-message-id="tool-message"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove tool-message"]')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-message-id="tool-message"]')).toBeNull()
  })

  it('does not resume a deferred confirmed removal after unmount', async () => {
    await persist([
      {
        kind: 'assistant',
        id: 'tool-message',
        text: 'Finished',
        activities: [{ id: 'tool-one', name: 'search_notes', label: 'Searched notes', outcome: 'succeeded' }],
      },
    ])
    let resolveConfirmation!: (confirmed: boolean) => void
    jest.mocked(confirmDialog).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve
      }),
    )
    renderPanel()

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove tool-message"]')!.click())
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    rootIsMounted = false
    await act(async () => {
      resolveConfirmation(true)
      await Promise.resolve()
    })

    const stored = readAssistantChatHistoryResult(storage, accountScope, tabId)
    expect(stored.status === 'found' ? stored.messages.map((message) => message.id) : []).toEqual(['tool-message'])
  })

  it('does not resume a deferred confirmed removal across an account session boundary', async () => {
    await persist([
      {
        kind: 'assistant',
        id: 'tool-message',
        text: 'Finished',
        activities: [{ id: 'tool-one', name: 'search_notes', label: 'Searched notes', outcome: 'succeeded' }],
      },
    ])
    let resolveConfirmation!: (confirmed: boolean) => void
    jest.mocked(confirmDialog).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve
      }),
    )
    renderPanel()

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove tool-message"]')!.click())
    signedIn = true
    userUuid = 'different-account'
    await act(async () => {
      await applicationEventObserver?.(ApplicationEvent.SignedIn)
      resolveConfirmation(true)
      await Promise.resolve()
    })

    expect(container.querySelector('[data-message-id="tool-message"]')).not.toBeNull()
    const stored = readAssistantChatHistoryResult(storage, accountScope, tabId)
    expect(stored.status === 'found' ? stored.messages.map((message) => message.id) : []).toEqual(['tool-message'])
  })

  it('keeps removal nonfatal and reports an error when persistence ownership returns false', async () => {
    await persist([{ kind: 'user', id: 'remove-me', text: 'Local-only removal' }])
    const rejectedPersistence = jest.fn(async (_operation: () => Promise<void>) => false)
    renderPanel(rejectedPersistence)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove remove-me"]')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-message-id="remove-me"]')).toBeNull()
    const stored = readAssistantChatHistoryResult(storage, accountScope, tabId)
    expect(stored.status === 'found' ? stored.messages.map((message) => message.id) : []).toEqual(['remove-me'])
    expect(addToast).toHaveBeenCalledWith({
      type: ToastType.Error,
      message: 'Message was removed from this session, but saved chat history could not be updated.',
    })
  })
})
