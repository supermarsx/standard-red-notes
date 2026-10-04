/** @jest-environment jsdom */

/**
 * Render proof for the per-tab LOCK control in the editor tab bar.
 *
 * Two things are pinned here, and the first is the reason this file exists at all:
 *
 *  1. THE ICON NAME RESOLVES. `Icon` looks `type` up in IconNameToSvgMapping and,
 *     on a miss, renders the NAME ITSELF as text inside a <label>.
 *     `VectorIconNameOrEmoji` admits any string, so a name that does not exist
 *     typechecks cleanly — this has shipped three times (IconNameCoverage.spec.ts).
 *     That sweep only sees STATIC `type="…"` literals; the padlock's type is a
 *     ternary over the locked state, so it is invisible to the sweep and has to be
 *     proven by rendering both states, which is what the first two tests do.
 *  2. THE CONTROL IS WIRED. Clicking the padlock must reach the controller group's
 *     `setTabLocked` with the inverted value, and the rendered state must follow
 *     the group rather than any local copy. UI in this repo has typechecked,
 *     passed tests and still never appeared.
 *
 * Built on the NoteGroupView.emptyTabs.spec.tsx model: the real NoteGroupView and
 * real NoteTabBar, with only the heavy content children stubbed.
 */

import { act, createElement, ReactElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'

const noop = () => undefined

const stub = (testId: string) => ({
  __esModule: true,
  default: () => createElement('div', { 'data-testid': testId }),
})
jest.mock('../MultipleSelectedNotes/MultipleSelectedNotes', () => stub('multiple-selected-notes'))
jest.mock('../MultipleSelectedFiles/MultipleSelectedFiles', () => stub('multiple-selected-files'))
jest.mock('../NoteView/NoteView', () => stub('note-view'))
jest.mock('../FileView/FileView', () => stub('file-view'))
jest.mock('../NoteView/NoteConflictResolutionModal/NoteConflictResolutionView', () => stub('conflict-view'))
jest.mock('./TilesToolbar', () => stub('tiles-toolbar'))
jest.mock('./EmptyTabView', () => stub('empty-tab-view'))
jest.mock('./PaneViewTabRoutes', () => ({ __esModule: true, PANE_VIEW_TAB_ROUTES: {} }))

import NoteGroupView from './NoteGroupView'
import ApplicationProvider from '../ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakeController = { runtimeId: string; item?: { uuid: string; title: string } }

const makeApplication = (controllers: FakeController[], initiallyLocked: string[] = []) => {
  const locked = new Set(initiallyLocked)
  const setTabLocked = jest.fn((uuid: string, shouldLock: boolean) => {
    if (shouldLock) {
      locked.add(uuid)
    } else {
      locked.delete(uuid)
    }
  })

  const application = {
    isStarted: () => false,
    isLaunched: () => false,
    addEventObserver: () => noop,
    itemControllerGroup: {
      itemControllers: controllers,
      activeItemViewController: controllers[0],
      addActiveControllerChangeObserver: (callback: () => void) => {
        callback()
        return noop
      },
      setActiveItemController: noop,
      closeItemController: noop,
      get lockedTabUuids() {
        // A NEW set each read, exactly as the real getter returns, so the view
        // cannot accidentally depend on object identity.
        return new Set(locked)
      },
      isTabLocked: (uuid: string) => locked.has(uuid),
      setTabLocked,
    },
    notesController: { selectedNotesCount: controllers.length ? 1 : 0 },
    itemListController: {
      selectedFilesCount: 0,
      selectedFiles: [],
      firstSelectedItem: undefined,
      openNoteInNewTile: async () => undefined,
      openNewNoteInNewTile: async () => undefined,
    },
    paneController: {
      currentPane: 'editor',
      isInMobileView: false,
      viewTabs: [],
      activeViewTabId: undefined,
      setActiveViewTab: noop,
      closeViewTab: noop,
      openEmptyTab: noop,
    },
    addAndroidBackHandlerEventListener: () => noop,
    setAndroidBackHandlerFallbackListener: noop,
    addNativeMobileEventListener: () => noop,
  } as unknown as WebApplication

  return { application, setTabLocked, locked }
}

let container: HTMLDivElement
let root: Root

const mount = (element: ReactElement, application: WebApplication) => {
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(AndroidBackHandlerProvider, { application, children: element }),
      }),
    )
  })
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    }),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const controllers: FakeController[] = [{ runtimeId: 'a', item: { uuid: 'uuid-a', title: 'Alpha' } }]

const lockButton = () =>
  container.querySelector(
    'button[aria-label="Lock Alpha"], button[aria-label="Unlock Alpha"]',
  ) as HTMLButtonElement | null

describe('editor tab lock control', () => {
  it('renders a real glyph for the UNLOCKED padlock, not its icon name as text', () => {
    const { application } = makeApplication(controllers)
    mount(createElement(NoteGroupView, { application }), application)

    const button = lockButton()
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Lock Alpha')
    expect(button?.querySelector('svg')).not.toBeNull()
    // The emoji fallback path renders a <label> holding the unresolved name.
    expect(button?.querySelector('label')).toBeNull()
    expect(button?.textContent).toBe('')
  })

  it('renders a real glyph for the LOCKED padlock too', () => {
    const { application } = makeApplication(controllers, ['uuid-a'])
    mount(createElement(NoteGroupView, { application }), application)

    const button = lockButton()
    expect(button?.getAttribute('aria-label')).toBe('Unlock Alpha')
    expect(button?.querySelector('svg')).not.toBeNull()
    expect(button?.querySelector('label')).toBeNull()
    expect(button?.textContent).toBe('')
  })

  it('exposes the lock as a toggle and reflects the persisted state', () => {
    const { application } = makeApplication(controllers, ['uuid-a'])
    mount(createElement(NoteGroupView, { application }), application)

    expect(lockButton()?.getAttribute('aria-pressed')).toBe('true')

    const tab = container.querySelector('[role="tab"]')
    // The lock is state the user must be able to read without hovering.
    expect(tab?.getAttribute('title')).toContain('locked')
  })

  it('shows an unlocked tab as not pressed, with no "locked" claim in its tooltip', () => {
    const { application } = makeApplication(controllers)
    mount(createElement(NoteGroupView, { application }), application)

    expect(lockButton()?.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[role="tab"]')?.getAttribute('title')).toBe('Alpha')
  })

  it('locks the tab when the padlock is clicked, and re-renders as locked', () => {
    const { application, setTabLocked } = makeApplication(controllers)
    mount(createElement(NoteGroupView, { application }), application)

    act(() => {
      lockButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setTabLocked).toHaveBeenCalledWith('uuid-a', true)
    expect(lockButton()?.getAttribute('aria-pressed')).toBe('true')
  })

  it('unlocks a locked tab when the padlock is clicked again', () => {
    const { application, setTabLocked } = makeApplication(controllers, ['uuid-a'])
    mount(createElement(NoteGroupView, { application }), application)

    act(() => {
      lockButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(setTabLocked).toHaveBeenCalledWith('uuid-a', false)
    expect(lockButton()?.getAttribute('aria-pressed')).toBe('false')
  })

  it('does not select the tab when the padlock is clicked', () => {
    const { application } = makeApplication([
      { runtimeId: 'a', item: { uuid: 'uuid-a', title: 'Alpha' } },
      { runtimeId: 'b', item: { uuid: 'uuid-b', title: 'Beta' } },
    ])
    const setActive = jest.fn()
    ;(application.itemControllerGroup as unknown as { setActiveItemController: unknown }).setActiveItemController =
      setActive

    mount(createElement(NoteGroupView, { application }), application)

    act(() => {
      ;(container.querySelector('button[aria-label="Lock Beta"]') as HTMLButtonElement | null)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    expect(setActive).not.toHaveBeenCalled()
  })
})
