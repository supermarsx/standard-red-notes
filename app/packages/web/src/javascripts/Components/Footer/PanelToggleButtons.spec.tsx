/** @jest-environment jsdom */

/**
 * Render proof for the panel collapse/expand toggles after their move out of the
 * top bars and into the footer bar.
 *
 * The bar is deliberately high here: this repo has shipped UI that typechecked,
 * passed tests and never appeared. So these tests render the REAL <Footer/> (only
 * its unrelated sibling widgets are stubbed) and assert the buttons exist inside
 * the real `#footer-bar` element, assert the editor pane no longer renders a
 * collapse rail, and statically assert no component outside Footer/ still owns a
 * pane-collapse affordance.
 */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { observable, runInAction } from 'mobx'
import { readFileSync, readdirSync } from 'fs'
import { join, sep, basename } from 'path'
import { WebApplication } from '@/Application/WebApplication'
import { WebApplicationGroup } from '@/Application/WebApplicationGroup'
import en from '@/Internationalization/Resources/en'

// ---------------------------------------------------------------------------
// Pane state. The toggles read this via useResponsiveAppPane. Collapse state is
// a real mobx observable so that flipping it exercises the same observer-driven
// re-render path the app uses — a plain object would be swallowed by the memo
// that mobx-react-lite's observer() puts around the component.
// ---------------------------------------------------------------------------
const paneCollapse = observable({ navigation: false, list: false })
const paneState = {
  toggleNavigationPane: jest.fn(),
  toggleListPane: jest.fn(),
  setPaneLayout: jest.fn(),
}

jest.mock('../Panes/ResponsivePaneProvider', () => ({
  __esModule: true,
  useResponsiveAppPane: () => ({
    get isNavigationPaneCollapsed() {
      return paneCollapse.navigation
    },
    get isListPaneCollapsed() {
      return paneCollapse.list
    },
    toggleNavigationPane: paneState.toggleNavigationPane,
    toggleListPane: paneState.toggleListPane,
    setPaneLayout: paneState.setPaneLayout,
  }),
  default: ({ children }: { children: React.ReactNode }) => children,
}))

const setCollapsed = (navigation: boolean, list: boolean) => {
  act(() => {
    runInAction(() => {
      paneCollapse.navigation = navigation
      paneCollapse.list = list
    })
  })
}

// Real English strings, so the assertions below check the shipped copy rather
// than whatever a stub happens to return.
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: (namespace: 'navigation' | 'notes') => ({
    t: (key: string) => (en[namespace] as Record<string, string>)[key],
  }),
}))

// Footer's other widgets are irrelevant here and each drag in large dependency
// trees; the footer's own markup (the <footer id="footer-bar"> element) is real.
const stub = (testId: string) => ({
  __esModule: true,
  default: () => createElement('div', { 'data-testid': testId }),
})
jest.mock('./AccountMenuButton', () => stub('account-menu-button'))
jest.mock('./PreferencesButton', () => stub('preferences-button'))
jest.mock('./QuickSettingsButton', () => stub('quick-settings-button'))
jest.mock('./AssistantButton', () => stub('assistant-button'))
jest.mock('./ConstellationButton', () => stub('constellation-button'))
jest.mock('./VaultSelectionButton', () => stub('vault-selection-button'))
jest.mock('./ConnectionStatus', () => stub('connection-status'))
jest.mock('./NoteStats', () => stub('note-stats'))
jest.mock('./NotesFolderCounter', () => stub('notes-folder-counter'))
jest.mock('./AssistantUsage', () => stub('assistant-usage'))
jest.mock('../SyncResolutionMenu/SyncResolutionMenu', () => stub('sync-resolution-menu'))
jest.mock('../NoteGroupView/NoteGroupView', () => stub('note-group-view'))

import Footer from './Footer'
import EditorPane from '../NoteGroupView/EditorPane'
import ApplicationProvider from '../ApplicationProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = () => {}

const application = {
  isStarted: () => false,
  isLaunched: () => false,
  addEventObserver: () => noop,
  addWebEventObserver: () => noop,
  addSingleEventObserver: () => noop,
  getPreference: (_key: unknown, defaultValue: unknown) => defaultValue,
  status: { addEventObserver: () => noop },
} as unknown as WebApplication

const applicationGroup = { getDescriptors: () => [] } as unknown as WebApplicationGroup

const COMPONENTS_DIR = join(__dirname, '..')

describe('panel toggles in the footer bar', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    runInAction(() => {
      paneCollapse.navigation = false
      paneCollapse.list = false
    })
    paneState.toggleNavigationPane = jest.fn()
    paneState.toggleListPane = jest.fn()

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
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
    act(() => root.unmount())
    container.remove()
  })

  const renderFooter = () => {
    act(() => {
      root.render(createElement(Footer, { application, applicationGroup }))
    })
    const footerBar = container.querySelector('#footer-bar')
    if (!footerBar) {
      throw new Error('footer bar did not render')
    }
    return footerBar
  }

  /** Buttons found inside the footer bar, keyed by accessible name. */
  const toggleButtonsIn = (scope: Element) =>
    Array.from(scope.querySelectorAll('button[aria-expanded]')).map((button) => ({
      label: button.getAttribute('aria-label'),
      expanded: button.getAttribute('aria-expanded'),
      element: button as HTMLButtonElement,
    }))

  it('renders both toggles inside the real footer bar element', () => {
    const footerBar = renderFooter()

    const buttons = toggleButtonsIn(footerBar)
    expect(buttons.map((b) => b.label)).toEqual(['Collapse topics panel', 'Collapse notes panel'])

    // Not merely somewhere in the document: inside the footer bar itself.
    const toggleGroup = footerBar.querySelector('[data-testid="footer-panel-toggles"]')
    expect(toggleGroup).not.toBeNull()
    expect(footerBar.contains(toggleGroup as Node)).toBe(true)
    expect(container.querySelectorAll('[data-testid="footer-panel-toggles"]')).toHaveLength(1)
  })

  it('changes each accessible name and aria-expanded with the pane state', () => {
    const footerBar = renderFooter()

    expect(toggleButtonsIn(footerBar).map((b) => [b.label, b.expanded])).toEqual([
      ['Collapse topics panel', 'true'],
      ['Collapse notes panel', 'true'],
    ])

    // No re-render call: the live footer must react to the pane state itself.
    setCollapsed(true, true)

    expect(toggleButtonsIn(footerBar).map((b) => [b.label, b.expanded])).toEqual([
      ['Expand topics panel', 'false'],
      ['Expand notes panel', 'false'],
    ])

    setCollapsed(false, false)

    expect(toggleButtonsIn(footerBar).map((b) => [b.label, b.expanded])).toEqual([
      ['Collapse topics panel', 'true'],
      ['Collapse notes panel', 'true'],
    ])
  })

  it('still collapses and expands: each button invokes its pane toggle in both states', () => {
    const footerBar = renderFooter()

    const clickBoth = () => {
      const buttons = toggleButtonsIn(footerBar)
      expect(buttons).toHaveLength(2)
      act(() => {
        buttons[0].element.click()
        buttons[1].element.click()
      })
    }

    // The collapse direction.
    clickBoth()
    expect(paneState.toggleNavigationPane).toHaveBeenCalledTimes(1)
    expect(paneState.toggleListPane).toHaveBeenCalledTimes(1)

    // …and the expand direction, from the collapsed state.
    setCollapsed(true, true)
    clickBoth()
    expect(paneState.toggleNavigationPane).toHaveBeenCalledTimes(2)
    expect(paneState.toggleListPane).toHaveBeenCalledTimes(2)
  })

  it('keeps the toggles keyboard operable as real focusable buttons', () => {
    const buttons = toggleButtonsIn(renderFooter())

    for (const { element } of buttons) {
      expect(element.tagName).toBe('BUTTON')
      expect(element.getAttribute('type')).toBe('button')
      // Not removed from the tab order, and not a div masquerading as a button.
      expect(element.getAttribute('tabindex')).not.toBe('-1')
      expect(element.getAttribute('disabled')).toBeNull()

      // Wrapped in act: the tooltip anchor schedules state updates on focus.
      act(() => element.focus())
      expect(document.activeElement).toBe(element)
    }
  })

  /**
   * The "nothing is lost below 768px" claim. jsdom applies no CSS, so this cannot
   * assert visibility at a viewport width — it asserts the responsive contract in
   * the rendered DOM: the footer that hosts the toggles, and the toggles
   * themselves, are `hidden` by default and only `md:flex`. Every control this
   * change replaced carried the same pair (PaneCollapseButton's own base classes),
   * so the md+ floor is unchanged rather than newly introduced.
   */
  it('keeps the toggles on the same md+ floor as the footer that hosts them', () => {
    const footerBar = renderFooter()

    expect(footerBar.classList.contains('hidden')).toBe(true)
    expect(footerBar.classList.contains('md:flex')).toBe(true)

    const buttons = toggleButtonsIn(footerBar)
    expect(buttons).toHaveLength(2)
    for (const { element } of buttons) {
      expect(element.classList.contains('hidden')).toBe(true)
      expect(element.classList.contains('md:flex')).toBe(true)
    }
  })

  it.each([
    ['both panes expanded', false, false],
    ['both panes collapsed', true, true],
  ])('no longer renders an expand rail above the editor (%s)', (_case, navigation, list) => {
    runInAction(() => {
      paneCollapse.navigation = navigation
      paneCollapse.list = list
    })

    act(() => {
      root.render(
        createElement(ApplicationProvider, {
          application,
          children: createElement(EditorPane, { application, id: 'editor-column', className: '' }),
        }),
      )
    })

    expect(container.querySelector('[data-testid="note-group-view"]')).not.toBeNull()
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="footer-panel-toggles"]')).toHaveLength(0)
  })
})

describe('panel toggles are gone from the top bars', () => {
  const tsxFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        return tsxFiles(full)
      }
      return entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.spec.tsx') ? [full] : []
    })

  const nonFooterComponents = tsxFiles(COMPONENTS_DIR).filter((file) => !file.includes(`${sep}Footer${sep}`))

  it('leaves PaneCollapseButton with exactly one consumer, the footer toggles', () => {
    const consumers = tsxFiles(COMPONENTS_DIR).filter(
      (file) =>
        !file.endsWith('PaneCollapseButton.tsx') && /import PaneCollapseButton from/.test(readFileSync(file, 'utf8')),
    )

    expect(consumers.map((file) => basename(file))).toEqual(['PanelToggleButtons.tsx'])
  })

  it('has no pane-collapse copy left in any non-footer component', () => {
    const forbidden = [
      'collapseTagsPanel',
      'expandTagsPanel',
      'collapseNotesPanel',
      'expandNotesPanel',
      'expandTopicsPanel',
    ]

    const offenders = nonFooterComponents.filter((file) => {
      const source = readFileSync(file, 'utf8')
      return forbidden.some((key) => source.includes(key))
    })

    expect(offenders).toEqual([])
  })

  it('mounts the toggle group only from the footer', () => {
    const importers = tsxFiles(COMPONENTS_DIR).filter(
      (file) =>
        !file.endsWith('PanelToggleButtons.tsx') &&
        /(import PanelToggleButtons|<PanelToggleButtons)/.test(readFileSync(file, 'utf8')),
    )

    expect(importers.map((file) => basename(file))).toEqual(['Footer.tsx'])
  })
})
