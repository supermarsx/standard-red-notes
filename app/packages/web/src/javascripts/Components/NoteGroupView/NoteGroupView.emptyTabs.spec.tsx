/** @jest-environment jsdom */

/**
 * Render proof for the editor tab bar in the ZERO-TAB state.
 *
 * NoteGroupView used to gate its whole subtree on `hasControllers ||
 * viewTabs.length > 0`, so closing the last tab removed the tab bar itself —
 * leaving no in-pane way to open another tab. These tests mount the REAL
 * NoteGroupView with the REAL NoteTabBar (only the heavy content children are
 * stubbed) and assert:
 *
 *  - with zero tabs the bar is in the DOM and its "New note tab" button works,
 *  - the split toggle is present but DISABLED, with a tooltip saying why,
 *  - with a tab open the same split toggle is enabled (i.e. nothing regressed).
 *
 * The bar is deliberately high: this repo has shipped UI that typechecked,
 * passed tests and never appeared.
 */

import { act, createElement, ReactElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'

const noop = () => undefined

// The tab bar is the subject, so it stays real. Everything NoteGroupView renders
// *below* the bar is content we don't assert on and each drags a large dependency
// tree, so stub those.
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

const makeApplication = (controllers: FakeController[], isInMobileView = false) => {
  const calls = {
    openNewNoteInNewTile: 0,
    openEmptyTab: 0,
  }

  const application = {
    isStarted: () => false,
    isLaunched: () => false,
    addEventObserver: () => noop,
    itemControllerGroup: {
      itemControllers: controllers,
      activeItemViewController: controllers[0],
      // The real group notifies on registration-relevant changes; fire once
      // immediately so the view picks up `itemControllers` the way it does in app.
      addActiveControllerChangeObserver: (callback: () => void) => {
        callback()
        return noop
      },
      setActiveItemController: noop,
      closeItemController: noop,
    },
    notesController: { selectedNotesCount: controllers.length ? 1 : 0 },
    itemListController: {
      selectedFilesCount: 0,
      selectedFiles: [],
      firstSelectedItem: undefined,
      openNoteInNewTile: async () => undefined,
      openNewNoteInNewTile: async () => {
        calls.openNewNoteInNewTile += 1
      },
    },
    paneController: {
      currentPane: 'editor',
      isInMobileView,
      viewTabs: [],
      activeViewTabId: undefined,
      setActiveViewTab: noop,
      closeViewTab: noop,
      openEmptyTab: () => {
        calls.openEmptyTab += 1
      },
    },
    // Consumed by the (closed) context-menu Popover inside the tab bar.
    addAndroidBackHandlerEventListener: () => noop,
    setAndroidBackHandlerFallbackListener: noop,
    addNativeMobileEventListener: () => noop,
  } as unknown as WebApplication

  return { application, calls }
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

const addButton = () => container.querySelector('button[aria-label="New note tab"]') as HTMLButtonElement | null
const splitButton = () =>
  container.querySelector('button[aria-label="Split: show notes side by side"]') as HTMLButtonElement | null

describe('editor tab bar with no tabs open', () => {
  it('still renders the tab bar', () => {
    const { application } = makeApplication([])
    mount(createElement(NoteGroupView, { application }), application)

    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist).not.toBeNull()
    // Nothing to show as a tab, but the bar and its controls are there.
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0)
  })

  it('offers a working "new tab" button', () => {
    const { application, calls } = makeApplication([])
    mount(createElement(NoteGroupView, { application }), application)

    const add = addButton()
    expect(add).not.toBeNull()
    expect((add as HTMLButtonElement).disabled).toBe(false)

    act(() => {
      ;(add as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls.openNewNoteInNewTile).toBe(1)
  })

  it('renders the split toggle as present-but-disabled, with the reason as its tooltip', () => {
    const { application } = makeApplication([])
    mount(createElement(NoteGroupView, { application }), application)

    const split = splitButton()
    // Present, not hidden: the user asked for unavailable rather than absent.
    expect(split).not.toBeNull()
    expect((split as HTMLButtonElement).disabled).toBe(true)
    expect((split as HTMLButtonElement).getAttribute('title')).toBe('Open a tab to split')
  })
})

describe('editor tab bar with a tab open', () => {
  const controllers: FakeController[] = [{ runtimeId: 'a', item: { uuid: 'uuid-a', title: 'Alpha' } }]

  it('renders the tab and enables the split toggle', () => {
    const { application } = makeApplication(controllers)
    mount(createElement(NoteGroupView, { application }), application)

    const tabs = container.querySelectorAll('[role="tab"]')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].textContent).toContain('Alpha')

    const split = splitButton()
    expect(split).not.toBeNull()
    expect((split as HTMLButtonElement).disabled).toBe(false)
    expect((split as HTMLButtonElement).getAttribute('title')).toBe('Split: show notes side by side')
  })

  it('keeps the split toggle disabled on mobile, with a mobile-specific reason', () => {
    const { application } = makeApplication(controllers, true)
    mount(createElement(NoteGroupView, { application }), application)

    const split = splitButton()
    expect((split as HTMLButtonElement).disabled).toBe(true)
    expect((split as HTMLButtonElement).getAttribute('title')).toBe('Splitting is unavailable on small screens')
  })
})
