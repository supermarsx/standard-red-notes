/**
 * @jest-environment jsdom
 *
 * Mini ("icon rail") mode, rendered.
 *
 * A green tsc and a green projection spec are not evidence that an icon rail
 * exists: the projection is only reached if `Navigation` actually provides the
 * mode to its entries, and a label only stays reachable if the attributes it
 * moved into are actually on the rendered element. Both of those are render
 * facts, so this mounts the real `Navigation`, the real section buttons and the
 * real list rows and reads the DOM they produce.
 *
 * It also pins the icon trap: `Icon` renders its `type` as TEXT inside a
 * `<label>` on a mapping miss, and `VectorIconNameOrEmoji` admits any string so
 * tsc cannot see it. In the full column a missing glyph is merely ugly next to
 * the label; on a rail where the label is gone, the icon name becomes the only
 * thing rendered. So `Icon` is deliberately NOT stubbed here, and every entry is
 * asserted to carry an `<svg>` and no `<label>`.
 *
 * No measurement is asserted anywhere: jsdom has no layout engine, so every
 * dimension reads 0. Mini does not set a width in any case.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { SystemViewId } from '@standardnotes/snjs'

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/Hooks/useSafeAreaPadding', () => ({
  useAvailableSafeAreaPadding: () => ({ hasBottomInset: false }),
}))

jest.mock('../Panes/ResponsivePaneProvider', () => ({
  useResponsiveAppPane: () => ({ setPaneLayout: jest.fn(), presentPane: jest.fn() }),
}))

jest.mock('../Panes/usePaneGesture', () => ({
  usePaneSwipeGesture: () => [jest.fn()],
}))

jest.mock('@/Hooks/useIsTabletOrMobileScreen', () => ({
  __esModule: true,
  default: () => mockScreen,
}))

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

jest.mock('../Button/RoundIconButton', () => ({ __esModule: true, default: () => null }))
jest.mock('../Footer/QuickSettingsButton', () => ({ __esModule: true, default: () => null }))
jest.mock('../Footer/VaultSelectionButton', () => ({ __esModule: true, default: () => null }))
jest.mock('../Footer/PreferencesButton', () => ({ __esModule: true, default: () => null }))
jest.mock('../Notifications/NotificationsPanel', () => ({ __esModule: true, default: () => null }))

jest.mock('./TagSearchBar', () => ({ __esModule: true, default: () => 'TAG_SEARCH_BAR' }))
jest.mock('./SmartViewsSection', () => ({ __esModule: true, default: () => 'SMART_VIEWS_SECTION' }))
jest.mock('./TagsSection', () => ({ __esModule: true, default: () => 'TAGS_SECTION' }))

jest.mock('../Workflows/useWorkflowsStatus', () => ({
  useWorkflowsStatus: () => ({
    state: { kind: 'loaded', status: { enabled: true } },
    signedIn: true,
    refresh: jest.fn(),
  }),
}))

jest.mock('../FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: jest.fn(), removeDragTarget: jest.fn() }),
}))

jest.mock('@/Hooks/usePremiumModal', () => ({
  usePremiumModal: () => ({ activate: jest.fn() }),
}))

jest.mock('@/Logging', () => ({
  LoggingDomain: { NavigationList: 'navigation-list' },
  log: jest.fn(),
}))

import Navigation from './Navigation'
import SmartViewsListItem from './SmartViewsListItem'
import { TagsListItem } from './TagsListItem'
import { NavigationMiniContext, NAVIGATION_PANE_MINI_PREF_KEY } from './navigationMini'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MINI_PREF_KEY = String(NAVIGATION_PANE_MINI_PREF_KEY)

/** The eleven fixed sidebar entries, in render order, with their labels. */
const ENTRY_LABELS = [
  'Home',
  'Notifications',
  'Dashboard',
  'Reminders',
  'Calendar',
  'Todos',
  'Research',
  'Bookmarks',
  'Templates',
  'Files',
  'Workflows',
]

let mockScreen = { isTabletOrMobile: false, isTablet: false, isMobile: false }

const localPreferences = new Map<string, unknown>()
const eventObservers = new Set<() => Promise<void>>()

const mockApplication = {
  environment: 1,
  hasPasscode: () => false,
  lock: jest.fn(),
  setPreference: jest.fn(),
  addEventObserver: (callback: () => Promise<void>) => {
    eventObservers.add(callback)
    return () => {
      eventObservers.delete(callback)
    }
  },
  addWebEventObserver: () => () => undefined,
  preferences: {
    getLocalValue: (key: string, defaultValue: unknown) => {
      return localPreferences.has(key) ? localPreferences.get(key) : defaultValue
    },
    setLocalValue: (key: string, value: unknown) => {
      localPreferences.set(key, value)
    },
  },
  navigationController: {
    isSearching: false,
    searchQuery: '',
    setSearchQuery: jest.fn(),
    smartViews: [],
    starredTags: [],
  },
  featuresController: { isVaultsEnabled: () => false, hasSmartViews: true },
  paneController: { activeViewTab: undefined as unknown, openPaneTab: jest.fn() },
  notificationsController: { unreadCount: 0 },
  accountMenuController: { toggleShow: jest.fn() },
  preferencesController: { openPreferences: jest.fn() },
}

describe('Navigation mini mode', () => {
  let container: HTMLDivElement
  let root: Root

  const renderNavigation = async () => {
    await act(async () => {
      root.render(createElement(Navigation, { application: mockApplication as never, id: 'navigation' }))
    })
  }

  const navigationRoot = () => container.querySelector('#navigation') as HTMLElement
  const entries = () => Array.from(container.querySelectorAll<HTMLButtonElement>('#navigation-content button'))

  beforeEach(() => {
    localPreferences.clear()
    eventObservers.clear()
    mockScreen = { isTabletOrMobile: false, isTablet: false, isMobile: false }
    mockApplication.navigationController.isSearching = false
    mockApplication.notificationsController.unreadCount = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the full column with visible labels while the preference is off', async () => {
    await renderNavigation()

    expect(navigationRoot().getAttribute('data-navigation-mini')).toBe('false')
    expect(navigationRoot().className).not.toContain('navigation-mini')

    const rendered = entries()
    expect(rendered).toHaveLength(ENTRY_LABELS.length)

    for (const [index, label] of ENTRY_LABELS.entries()) {
      expect(rendered[index].textContent).toContain(label)
      expect(rendered[index].querySelector('span.font-semibold')).not.toBeNull()
      expect(rendered[index].getAttribute('title')).toBeNull()
    }

    expect(container.textContent).toContain('TAG_SEARCH_BAR')
  })

  it('renders an icon rail with every label moved into title and aria-label', async () => {
    localPreferences.set(MINI_PREF_KEY, true)

    await renderNavigation()

    expect(navigationRoot().getAttribute('data-navigation-mini')).toBe('true')
    expect(navigationRoot().className).toContain('navigation-mini')

    const rendered = entries()
    expect(rendered).toHaveLength(ENTRY_LABELS.length)

    for (const [index, label] of ENTRY_LABELS.entries()) {
      const entry = rendered[index]

      expect(entry.querySelector('span.font-semibold')).toBeNull()
      expect(entry.textContent).not.toContain(label)
      expect(entry.getAttribute('title')).toBe(label)
      expect(entry.getAttribute('aria-label')).toBe(label)
    }
  })

  it('renders a real glyph in every rail entry, never the icon name as text', async () => {
    localPreferences.set(MINI_PREF_KEY, true)

    await renderNavigation()

    for (const entry of entries()) {
      expect(entry.querySelector('svg')).not.toBeNull()
      expect(entry.querySelector('label')).toBeNull()
    }
  })

  it('hides the search input on the rail, but never while a search is running', async () => {
    localPreferences.set(MINI_PREF_KEY, true)

    await renderNavigation()
    expect(container.textContent).not.toContain('TAG_SEARCH_BAR')

    await act(async () => {
      root.unmount()
    })

    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockApplication.navigationController.isSearching = true

    await renderNavigation()
    expect(container.textContent).toContain('TAG_SEARCH_BAR')
  })

  it('stays the full column on tablet, where the pane is presented full-width', async () => {
    // The tablet-responsive rule removes the Navigation pane from the pane stack
    // and presents it full-width when it is selected; a 48px rail of glyphs in a
    // 100%-wide column would be the wrong answer, so mini is suppressed there.
    localPreferences.set(MINI_PREF_KEY, true)
    mockScreen = { isTabletOrMobile: true, isTablet: true, isMobile: false }

    await renderNavigation()

    expect(navigationRoot().getAttribute('data-navigation-mini')).toBe('false')
    expect(entries()[0].textContent).toContain('Home')
    expect(entries()[0].getAttribute('aria-label')).toBeNull()
  })

  it('switches to the rail when the preference changes while mounted', async () => {
    await renderNavigation()
    expect(entries()[0].textContent).toContain('Home')

    await act(async () => {
      mockApplication.preferences.setLocalValue(MINI_PREF_KEY, true)
      await Promise.all([...eventObservers].map((observer) => observer()))
    })

    expect(navigationRoot().getAttribute('data-navigation-mini')).toBe('true')
    expect(entries()[0].textContent).not.toContain('Home')
    expect(entries()[0].getAttribute('aria-label')).toBe('Home')
  })

  it('folds the notification count into the rail entry name instead of dropping it', async () => {
    localPreferences.set(MINI_PREF_KEY, true)
    mockApplication.notificationsController.unreadCount = 3

    await renderNavigation()

    const notifications = entries()[ENTRY_LABELS.indexOf('Notifications')]

    // The button's own aria-label replaces its contents as the accessible name,
    // so a bubble with its own label would be unreachable on the rail.
    expect(notifications.getAttribute('aria-label')).toBe('Notifications, 3 notifications')
    const bubble = notifications.querySelector('span.rounded-full') as HTMLElement
    expect(bubble.textContent).toBe('3')
    expect(bubble.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps the full column bubble labelled in its own right', async () => {
    mockApplication.notificationsController.unreadCount = 3

    await renderNavigation()

    const notifications = entries()[ENTRY_LABELS.indexOf('Notifications')]
    const bubble = notifications.querySelector('span.rounded-full') as HTMLElement

    expect(notifications.getAttribute('aria-label')).toBeNull()
    expect(bubble.getAttribute('aria-label')).toBe('3 notifications')
  })
})

describe('Navigation mini mode — smart view and tag rows', () => {
  let container: HTMLDivElement
  let root: Root

  const renderInMode = async (mini: boolean, child: ReturnType<typeof createElement>) => {
    await act(async () => {
      root.render(createElement(NavigationMiniContext.Provider, { value: mini }, child))
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const smartView = { uuid: 'user-smart-view', title: 'My work', iconString: 'notes' }

  const smartViewElement = () =>
    createElement(SmartViewsListItem, {
      view: smartView as never,
      tagsState: {
        selected: smartView,
        editingTag: undefined,
        allNotesCount: 12,
        setSelectedTag: jest.fn(async () => undefined),
        save: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      } as never,
      features: {} as never,
      setEditingSmartView: jest.fn(),
    })

  it('shows a smart view title, count and menu in the full column', async () => {
    await renderInMode(false, smartViewElement())

    const row = container.querySelector('button.tag') as HTMLElement

    expect(row.className).toContain('px-3.5')
    expect(row.querySelector(`#react-tag-${smartView.uuid}`)?.textContent).toBe('My work')
    expect(row.querySelector('.count')).not.toBeNull()
    expect(row.querySelector('.meta')).not.toBeNull()
    expect(row.getAttribute('aria-label')).toBeNull()
  })

  it('reduces a smart view to its glyph, with the title kept as the accessible name', async () => {
    await renderInMode(true, smartViewElement())

    const row = container.querySelector('button.tag') as HTMLElement

    expect(row.className).toContain('px-0')
    expect(row.className).not.toContain('px-3.5')
    expect(row.querySelector(`#react-tag-${smartView.uuid}`)).toBeNull()
    expect(row.querySelector('.count')).toBeNull()
    expect(row.querySelector('.meta')).toBeNull()
    expect(row.getAttribute('title')).toBe('My work')
    expect(row.getAttribute('aria-label')).toBe('My work')
    expect(row.querySelector('svg')).not.toBeNull()
    expect(row.querySelector('label')).toBeNull()
  })

  it('still renders the All notes system view as a glyph on the rail', async () => {
    await renderInMode(
      true,
      createElement(SmartViewsListItem, {
        view: { uuid: SystemViewId.AllNotes, title: 'All notes', iconString: 'notes' } as never,
        tagsState: {
          selected: undefined,
          editingTag: undefined,
          allNotesCount: 12,
          setSelectedTag: jest.fn(async () => undefined),
          save: jest.fn(async () => undefined),
          remove: jest.fn(async () => undefined),
        } as never,
        features: {} as never,
        setEditingSmartView: jest.fn(),
      }),
    )

    const row = container.querySelector('button.tag') as HTMLElement

    expect(row.getAttribute('aria-label')).toBe('All notes')
    expect(row.querySelector('.count')).toBeNull()
  })

  const tag = { uuid: 'tag-work', title: 'Work', expanded: true, color: undefined }
  const childTag = { uuid: 'tag-child', title: 'Invoices', expanded: false, color: undefined }

  const tagElement = (hidden = false) =>
    createElement(TagsListItem, {
      tag: tag as never,
      type: 'tags' as never,
      navigationController: {
        isSearching: false,
        isTagHidden: (candidate: { uuid: string }) => hidden && candidate.uuid === tag.uuid,
        selected: tag,
        selectedLocation: 'tags',
        editingTag: undefined,
        addingSubtagTo: undefined,
        contextMenuTag: undefined,
        contextMenuOpen: false,
        contextMenuTagSection: 'tags',
        tagToScrollIntoView: undefined,
        getChildren: (parent: { uuid: string }) => (parent.uuid === tag.uuid ? [childTag] : []),
        getNotesCount: () => 4,
        setExpanded: jest.fn(),
        setSelectedTag: jest.fn(async () => undefined),
        setSearchQuery: jest.fn(),
        save: jest.fn(async () => undefined),
      } as never,
      features: { hasFolders: true } as never,
      linkingController: {} as never,
      level: 0,
      onContextMenu: jest.fn(),
    })

  it('shows a tag title, count and context menu in the full column', async () => {
    await renderInMode(false, tagElement())

    const row = container.querySelector('.tag') as HTMLElement

    expect(row.className).toContain('px-3.5')
    expect(row.style.paddingLeft).toBe('14px')
    expect(row.querySelector(`#react-tag-${tag.uuid}-tags`)?.textContent).toBe('Work')
    expect(row.querySelector('.count')).not.toBeNull()
  })

  it('reduces a tag to its glyph while keeping its nesting readable', async () => {
    await renderInMode(true, tagElement())

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.tag'))
    const [parent, child] = rows

    expect(parent.className).toContain('px-0')
    expect(parent.querySelector(`#react-tag-${tag.uuid}-tags`)).toBeNull()
    expect(parent.querySelector('.count')).toBeNull()
    expect(parent.getAttribute('aria-label')).toBe('Work')
    expect(parent.style.paddingLeft).toBe('0px')

    // A sub-tag must not render flush with its parent and claim to be a root.
    expect(child.getAttribute('aria-label')).toBe('Invoices')
    expect(child.style.paddingLeft).toBe('4px')
  })

  it('keeps the expand control on the rail, so a collapsed sub-tree stays reachable', async () => {
    await renderInMode(true, tagElement())

    const parent = container.querySelector('.tag') as HTMLElement

    expect(parent.querySelector('.opened, .closed')).not.toBeNull()
  })

  it('marks a revealed hidden tag in the full column, with copy that promises no protection', async () => {
    await renderInMode(false, tagElement(true))

    const parent = container.querySelector('.tag') as HTMLElement
    const marker = parent.querySelector('[aria-label="Hidden from the sidebar list"]') as HTMLElement

    expect(parent.className).toContain('opacity-60')
    expect(marker).not.toBeNull()
    expect(marker.getAttribute('title')).toBe(
      'Hidden from the sidebar list. Its notes are still in All Notes and in search.',
    )
    // Hiding is tidiness, not protection. Nothing on the row may imply otherwise.
    expect(parent.outerHTML).not.toMatch(/private|protected|secure|locked/i)
    expect(marker.querySelector('svg')).not.toBeNull()
    expect(marker.querySelector('label')).toBeNull()
  })

  it('moves a hidden tag’s state into the rail entry name rather than dropping it', async () => {
    await renderInMode(true, tagElement(true))

    const parent = container.querySelector('.tag') as HTMLElement

    // No room for a second glyph at rail width, so the marker element is gone…
    expect(parent.querySelector('[aria-label="Hidden from the sidebar list"]')).toBeNull()
    // …but the state is still both visible (dimmed) and readable (the name).
    expect(parent.className).toContain('opacity-60')
    expect(parent.getAttribute('aria-label')).toBe('Work, Hidden from the sidebar list')
    expect(parent.getAttribute('title')).toBe('Work, Hidden from the sidebar list')
    expect(parent.outerHTML).not.toMatch(/private|protected|secure|locked/i)
  })

  it('leaves an unhidden tag unmarked and undimmed in both modes', async () => {
    for (const mini of [false, true]) {
      await renderInMode(mini, tagElement(false))

      const parent = container.querySelector('.tag') as HTMLElement

      expect(parent.className).not.toContain('opacity-60')
      expect(parent.querySelector('[aria-label="Hidden from the sidebar list"]')).toBeNull()
    }
  })
})
