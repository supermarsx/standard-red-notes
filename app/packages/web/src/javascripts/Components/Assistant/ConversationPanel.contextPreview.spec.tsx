/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { buildContextForSelection } from '@/Assistant/assistantContextSource'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import ConversationPanel from './ConversationPanel'
import type { AssistantSharedChatBinding } from '@/Assistant/assistantSyncedChats'
import type { AssistantConversationMode } from '@/Assistant/conversationModes'

jest.mock('@/Assistant/assistantContextSource', () => ({
  ...jest.requireActual('@/Assistant/assistantContextSource'),
  buildContextForSelection: jest.fn(() => ({
    scope: 'current-note',
    noteCount: 1,
    characters: 12,
    truncated: false,
    noteTitles: ['Current note'],
    noteUuids: ['note-one'],
    omittedNoteCount: 0,
    text: 'Current note',
  })),
  resolveContextNoteUuids: jest.fn(() => []),
}))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))
jest.mock('./AssistantMessageActions', () => ({
  __esModule: true,
  default: ({
    children,
  }: {
    children: (ref: import('react').RefObject<HTMLDivElement | null>) => import('react').ReactNode
  }) => <div>{children({ current: null })}</div>,
}))
jest.mock('./ContextSelector', () => ({ __esModule: true, default: () => <div data-context-selector /> }))
jest.mock('./AssistantUsageMeter', () => ({ __esModule: true, default: () => null }))
jest.mock('./AssistantNoticeDismissal', () => ({
  __esModule: true,
  default: ({ onSelect, onClose }: { onSelect: (choice: string) => void; onClose: () => void }) => (
    <div role="dialog">
      {['once', '15-days', 'never'].map((choice) => (
        <button key={choice} onClick={() => onSelect(choice)}>
          {choice}
        </button>
      ))}
      <button onClick={onClose}>Cancel</button>
    </div>
  ),
}))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => <span /> }))
jest.mock('@/Components/Button/Button', () => ({
  __esModule: true,
  default: ({ label }: { label: string }) => <button>{label}</button>,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
HTMLElement.prototype.scrollTo = jest.fn()

describe('ConversationPanel context preview cadence', () => {
  let container: HTMLElement
  let root: Root
  let noteObserver: (() => void) | undefined
  let editorObserver: (() => void) | undefined
  const removeEditorObserver = jest.fn()
  const activeItem = { uuid: 'note-one' }
  const application = {
    identifier: 'test-app',
    storage: {},
    sessions: { isSignedIn: () => false, getUser: () => undefined },
    getPreference: (_key: unknown, fallback: unknown) => fallback,
    setPreference: jest.fn(async () => undefined),
    addEventObserver: jest.fn(() => () => undefined),
    items: {
      addObserver: jest.fn((_type: unknown, observer: () => void) => {
        noteObserver = observer
        return () => undefined
      }),
    },
    itemListController: {
      activeControllerItem: activeItem,
      selectedItemsCount: 1,
      firstSelectedItem: activeItem,
    },
    itemControllerGroup: {
      itemControllers: [] as { item: { uuid: string } }[],
      activeItemViewController: { item: activeItem } as { item: { uuid: string } } | undefined,
      addActiveControllerChangeObserver: jest.fn((callback: () => void) => {
        editorObserver = callback
        callback()
        return removeEditorObserver
      }),
    },
  }

  const renderPanel = (
    isActive = true,
    sharedChat?: AssistantSharedChatBinding,
    onModeChange?: (mode: AssistantConversationMode) => void,
  ) => {
    act(() => {
      root.render(
        <ConversationPanel
          application={application as never}
          tabId="chat-one"
          accountScope="anonymous:test-app:dock:device-one"
          persistenceAllowed={false}
          isActive={isActive}
          sharedChat={sharedChat}
          onModeChange={onModeChange}
        />,
      )
    })
  }

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
    application.items.addObserver.mockImplementation((_type: unknown, observer: () => void) => {
      noteObserver = observer
      return () => undefined
    })
    application.addEventObserver.mockImplementation(() => () => undefined)
    application.itemControllerGroup.addActiveControllerChangeObserver.mockImplementation((callback: () => void) => {
      editorObserver = callback
      callback()
      return removeEditorObserver
    })
    jest.mocked(buildContextForSelection).mockImplementation(() => ({
      scope: 'current-note',
      noteCount: 1,
      characters: 12,
      truncated: false,
      noteTitles: ['Current note'],
      noteUuids: ['note-one'],
      omittedNoteCount: 0,
      text: 'Current note',
    }))
    noteObserver = undefined
    editorObserver = undefined
    application.itemControllerGroup.activeItemViewController = { item: activeItem }
    application.itemControllerGroup.itemControllers = []
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('places all five modes after context and tool permissions, before the message input', () => {
    const onModeChange = jest.fn()
    renderPanel(true, undefined, onModeChange)
    const context = container.querySelector('[data-context-selector]')!
    const tools = container.querySelector('[aria-label="Assistant tool permissions"]')!
    const modes = container.querySelector<HTMLButtonElement>('[aria-label="Assistant mode"]')!
    const input = container.querySelector('[aria-label="Message the assistant"]')!
    expect(context.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tools.compareDocumentPosition(modes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(modes.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(modes.getAttribute('title')).toContain('Assistant mode: Agent')
  })

  it('does not rescan note plaintext during unrelated streaming-style rerenders', () => {
    renderPanel()
    expect(buildContextForSelection).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 25; index++) {
      renderPanel()
    }
    expect(buildContextForSelection).toHaveBeenCalledTimes(1)

    act(() => noteObserver?.())
    expect(buildContextForSelection).toHaveBeenCalledTimes(2)
  })

  it('skips preview scans while the chat is hidden and refreshes on activation', () => {
    renderPanel(false)
    expect(buildContextForSelection).not.toHaveBeenCalled()

    renderPanel(true)
    expect(buildContextForSelection).toHaveBeenCalledTimes(1)
  })

  it('updates an empty chat immediately on editor handoff without a note mutation or parent rerender', () => {
    jest.mocked(buildContextForSelection).mockImplementation(() => {
      const uuid = application.itemControllerGroup.activeItemViewController?.item.uuid
      return {
        scope: 'current-note',
        noteCount: uuid ? 1 : 0,
        characters: 12,
        truncated: false,
        noteTitles: uuid ? [uuid] : [],
        noteUuids: uuid ? [uuid] : [],
        omittedNoteCount: 0,
        text: uuid ?? '',
      }
    })
    renderPanel()
    expect(container.textContent).toContain('“note-one”')
    act(() => {
      application.itemControllerGroup.activeItemViewController = { item: { uuid: 'note-two' } }
      editorObserver?.()
    })
    expect(container.textContent).toContain('“note-two”')
    expect(container.textContent).not.toContain('“note-one”')
    expect(buildContextForSelection).toHaveBeenCalledTimes(2)
    act(() => editorObserver?.())
    expect(buildContextForSelection).toHaveBeenCalledTimes(2)
    renderPanel(false)
    expect(removeEditorObserver).toHaveBeenCalled()
    expect(application.itemControllerGroup.addActiveControllerChangeObserver).toHaveBeenCalledTimes(2)
  })

  const chooseReminder = (choice: string) => {
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Hide AI privacy reminder"]')?.click())
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    act(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find((button) => button.textContent === choice)
        ?.click(),
    )
  }
  const remountPanel = () => {
    act(() => root.unmount())
    root = createRoot(container)
    renderPanel()
  }
  it('can hide both privacy reminders just for this mounted chat, or cancel without hiding them', () => {
    renderPanel()
    chooseReminder('Cancel')
    expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).not.toBeNull()
    chooseReminder('once')
    expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).toBeNull()
    expect(container.querySelector('[aria-label="Dismiss notice"]')).toBeNull()
    remountPanel()
    expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).not.toBeNull()
  })
  it('keeps never-again dismissed on remount', () => {
    renderPanel()
    chooseReminder('never')
    remountPanel()
    expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).toBeNull()
  })
  it.each(['15-days', 'never'])('still hides this reminder when %s cannot be persisted', (choice) => {
    renderPanel()
    const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full')
    })
    try {
      chooseReminder(choice)
      expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).toBeNull()
    } finally {
      write.mockRestore()
    }
    remountPanel()
    expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).not.toBeNull()
  })
  it('shows the reminder again after fifteen days even if the chat stays mounted', () => {
    jest.useFakeTimers()
    try {
      renderPanel()
      chooseReminder('15-days')
      expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).toBeNull()
      remountPanel()
      expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).toBeNull()
      act(() => jest.advanceTimersByTime(15 * 24 * 60 * 60 * 1000))
      expect(container.querySelector('[aria-label="Hide AI privacy reminder"]')).not.toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
  it('hydrates live remote messages without echoing them into a follower checkpoint', async () => {
    jest.useFakeTimers()
    try {
      const checkpoint = jest.fn(async () => undefined)
      const binding: AssistantSharedChatBinding = {
        ready: true,
        checkpoint,
        refresh: async () => undefined,
        history: {
          tab: { id: 'chat-one', title: 'Shared', userRenamed: false },
          messages: [{ id: 'remote-message', kind: 'user', text: 'First remote text' }],
          deniedToolNames: [],
        },
      }
      renderPanel(true, binding)
      expect(container.textContent).toContain('First remote text')
      renderPanel(true, {
        ...binding,
        history: {
          ...binding.history!,
          messages: [{ id: 'remote-message', kind: 'user', text: 'Updated on another device' }],
        },
      })
      expect(container.textContent).toContain('Updated on another device')
      expect(container.textContent).not.toContain('First remote text')
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2000)
      })
      expect(checkpoint).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
