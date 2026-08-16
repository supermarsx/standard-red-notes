/** @jest-environment jsdom */

jest.mock('../FilesView/FilesView', () => () => null)

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import AggregateViewSectionButtons from '../AggregateViews/AggregateViewSectionButtons'
import NoteTabBar from '../NoteGroupView/NoteTabBar'
import { PANE_VIEW_TAB_ROUTES } from '../NoteGroupView/PaneViewTabRoutes'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { GLOBAL_COMMANDS } from '../CommandPalette/GlobalCommands'
import { TABBABLE_PANES, ViewTab } from '@/Controllers/PaneController/ViewTab'
import CalendarAggregateView from './CalendarAggregateView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
let activeViewTab: ViewTab | undefined
let openPaneTab: jest.Mock
let presentPane: jest.Mock
let removePane: jest.Mock
let application: WebApplication

const mount = (element: React.ReactElement) => {
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
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  activeViewTab = undefined
  openPaneTab = jest.fn()
  presentPane = jest.fn()
  removePane = jest.fn()
  application = {
    paneController: {
      get activeViewTab() {
        return activeViewTab
      },
      openPaneTab,
      presentPane,
      removePane,
      panes: [],
    },
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  } as unknown as WebApplication
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Calendar first-class navigation tab', () => {
  it('renders Calendar directly alongside the other aggregate apps and opens it through the tab API', () => {
    const renderNavigationApps = () =>
      createElement(AggregateViewSectionButtons, {
        application,
        remindersLabel: 'Reminders',
        calendarLabel: 'Calendar',
        todosLabel: 'Todos',
      })

    mount(renderNavigationApps())

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Reminders', 'Calendar', 'Todos'])
    const calendarButton = buttons.find((button) => button.textContent?.trim() === 'Calendar') as HTMLButtonElement

    act(() => calendarButton.click())

    expect(openPaneTab).toHaveBeenCalledWith(AppPaneId.Calendar)
    expect(presentPane).not.toHaveBeenCalled()
    expect(removePane).not.toHaveBeenCalled()

    activeViewTab = {
      id: AppPaneId.Calendar,
      kind: 'pane',
      paneId: AppPaneId.Calendar,
      title: 'Calendar',
      icon: 'history',
    }
    application = {
      ...application,
      paneController: {
        ...application.paneController,
        activeViewTab,
      },
    } as WebApplication
    mount(renderNavigationApps())
    expect(
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Calendar')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('is declared tabbable and resolves to the Calendar aggregate content route', () => {
    expect(TABBABLE_PANES).toContainEqual({ paneId: AppPaneId.Calendar, title: 'Calendar', icon: 'history' })
    expect(PANE_VIEW_TAB_ROUTES[AppPaneId.Calendar]).toBe(CalendarAggregateView)

    for (const { paneId } of TABBABLE_PANES) {
      expect(PANE_VIEW_TAB_ROUTES[paneId]).toBeDefined()
    }
  })

  it('appears as a selectable, selected tab in the normal tab strip', () => {
    const calendarTab: ViewTab = {
      id: AppPaneId.Calendar,
      kind: 'pane',
      paneId: AppPaneId.Calendar,
      title: 'Calendar',
      icon: 'history',
    }
    const onSelectViewTab = jest.fn()

    mount(
      createElement(NoteTabBar as never, {
        controllers: [],
        activeControllerRuntimeId: undefined,
        onSelect: () => undefined,
        onClose: () => undefined,
        onAddTab: () => undefined,
        canAddTab: true,
        viewTabs: [calendarTab],
        activeViewTabId: calendarTab.id,
        onSelectViewTab,
        onCloseViewTab: () => undefined,
        onToggleSplit: () => undefined,
        isSplit: false,
        canSplit: false,
        onCloseTab: () => undefined,
        onCloseOtherTabs: () => undefined,
        onCloseTabsToRight: () => undefined,
        onCloseAllTabs: () => undefined,
      }),
    )

    const tab = container.querySelector('[role="tab"]') as HTMLElement
    expect(tab.textContent).toContain('Calendar')
    expect(tab.getAttribute('aria-selected')).toBe('true')

    act(() => tab.click())
    expect(onSelectViewTab).toHaveBeenCalledWith(calendarTab)
  })

  it('routes the command-palette action through the same tab API', () => {
    const command = GLOBAL_COMMANDS.find(({ id }) => id === 'global-open-calendar')
    expect(command).toBeDefined()

    command?.run(application)

    expect(openPaneTab).toHaveBeenCalledWith(AppPaneId.Calendar)
    expect(presentPane).not.toHaveBeenCalled()
    expect(removePane).not.toHaveBeenCalled()
  })
})
