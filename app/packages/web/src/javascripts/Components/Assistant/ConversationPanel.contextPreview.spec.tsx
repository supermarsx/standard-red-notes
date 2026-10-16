/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { buildContextForSelection } from '@/Assistant/assistantContextSource'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import ConversationPanel from './ConversationPanel'

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
jest.mock('./ContextSelector', () => ({ __esModule: true, default: () => <div data-context-selector /> }))
jest.mock('./AssistantUsageMeter', () => ({ __esModule: true, default: () => null }))
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

  const renderPanel = (isActive = true) => {
    act(() => {
      root.render(
        <ConversationPanel
          application={application as never}
          tabId="chat-one"
          accountScope="anonymous:test-app:dock:device-one"
          persistenceAllowed={false}
          isActive={isActive}
        />,
      )
    })
  }

  beforeEach(() => {
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
})
