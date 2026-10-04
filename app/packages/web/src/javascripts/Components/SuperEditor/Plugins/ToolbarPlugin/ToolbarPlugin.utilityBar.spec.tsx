/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the merged utility bar (task t101).
 *
 * The clipboard/history actions and the Office-ribbon tab strip used to be two
 * stacked full-width bands; they are now one bar, actions on the left and the
 * formatting tabs after them. (The strip was originally pushed hard right by an
 * auto margin; t111 centres it instead, for mouse travel, and falls back to flush
 * right on a narrow bar. Where the strip SITS is the subject of
 * ToolbarPlugin.tabStripAlignment.spec.tsx; this file only cares that both halves
 * share one bar and stay reachable.) Merging two rendered regions into one is
 * exactly the shape of change that has twice made a toolbar group silently
 * disappear from this file while `tsc` and the whole suite stayed green — the
 * tab strip in particular is the ONLY way to reach the Insert / Layout / AI /
 * Tools formatting groups, so losing it would hide most of the editor.
 *
 * So this mounts the REAL ToolbarPlugin and asserts, from the DOM: both halves
 * are present, they are in the SAME bar (not two bands again, and not one half
 * dropped), the tabs sit after the actions, and clicking a tab still swaps the
 * ribbon groups below.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'

// Desktop layout; `alwaysShowToolbar` (below) then docks the full ribbon.
jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const fakeApp = {
  getPreference: (key: string, fallback: unknown) => {
    if (key === PrefKey.AlwaysShowSuperToolbar) {
      return true
    }
    return PrefDefaults[key as PrefKey] ?? fallback
  },
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
    setLocalValue: () => undefined,
  },
  addEventObserver: () => () => undefined,
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
  isAuthorizedToRenderItem: () => true,
  vaultLocks: { addEventObserver: () => () => undefined },
  items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
  keyboardService: { addCommandHandler: () => () => undefined },
} as never

let container: HTMLElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const mount = async () => {
  await act(async () => {
    root.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer initialValue={undefined}>
            <ToolbarPlugin />
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })
}

const utilityBar = () => container.querySelector('[data-super-toolbar-utility-bar]')
const clipboardTools = () => container.querySelector('[aria-label="Clipboard and history tools"]')
const tabStrip = () => container.querySelector('[role="tablist"]')
const tabLabels = () => Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim())
const group = (label: string) => container.querySelector(`[role="group"][aria-label="${label}"]`)

const clickTab = async (label: string) => {
  const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
    (candidate) => candidate.textContent === label,
  )
  expect(tab).toBeDefined()
  await act(async () => {
    ;(tab as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('the merged clipboard + formatting-tabs bar', () => {
  it('renders exactly one bar, not two stacked bands', async () => {
    await mount()
    expect(container.querySelectorAll('[data-super-toolbar-utility-bar]')).toHaveLength(1)
    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1)
  })

  it('keeps the clipboard and history actions inside that bar', async () => {
    await mount()
    const tools = clipboardTools()
    expect(tools).not.toBeNull()
    expect(utilityBar()!.contains(tools!)).toBe(true)

    // The labelled clipboard actions. Compared case-insensitively: under test
    // the i18n layer echoes the raw key ('cut'), in the app it returns 'Cut'.
    const text = (tools!.textContent ?? '').toLowerCase()
    expect(text).toContain('cut')
    expect(text).toContain('copy')
    expect(text).toContain('paste')

    // Undo / Redo / Print are icon-only, so they are proven through the divider
    // rule instead: a divider renders ONLY when there is a visible button on
    // both sides of it. Two dividers therefore means all three segments —
    // cut/copy/paste, undo/redo, and print — are non-empty.
    expect(tools!.querySelectorAll('[role="separator"]').length).toBeGreaterThanOrEqual(2)
  })

  it('puts the formatting tabs in the same bar, after the actions', async () => {
    await mount()
    const strip = tabStrip()
    expect(strip).not.toBeNull()
    expect(utilityBar()!.contains(strip!)).toBe(true)

    // One bar, not a separate row: the tabs follow the actions in DOM order.
    const position = clipboardTools()!.compareDocumentPosition(strip!)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // They are no longer pushed over by an auto margin — t111 centres the strip
    // using flexible siblings instead, and an auto margin would eat the free space
    // those siblings need. ToolbarPlugin.tabStripAlignment.spec.tsx owns that
    // contract; asserted here only so this file cannot quietly re-pin the strip.
    expect(strip!.className).not.toContain('ml-auto')
  })

  it('still renders every formatting tab', async () => {
    await mount()
    expect(tabLabels()).toEqual(['Home', 'Insert', 'Layout', 'AI', 'Tools'])
  })

  it('still switches the ribbon groups when a tab is clicked', async () => {
    await mount()

    // Home is the default tab.
    expect(group('Font')).not.toBeNull()
    expect(group('Find')).toBeNull()

    await clickTab('Tools')

    expect(group('Find')).not.toBeNull()
    expect(group('Selection')).not.toBeNull()
    expect(group('Font')).toBeNull()

    await clickTab('Home')

    expect(group('Font')).not.toBeNull()
    expect(group('Find')).toBeNull()
  })

  it('marks the active tab so the reader can tell which groups are showing', async () => {
    await mount()
    const selected = () =>
      Array.from(container.querySelectorAll('[role="tab"]'))
        .filter((tab) => tab.getAttribute('aria-selected') === 'true')
        .map((tab) => tab.textContent)

    expect(selected()).toEqual(['Home'])
    await clickTab('Layout')
    expect(selected()).toEqual(['Layout'])
  })

  it('renders the ribbon groups below the bar, not inside it', async () => {
    await mount()
    // A merge that accidentally nested the ribbon inside the one-line bar would
    // still satisfy every assertion above.
    expect(utilityBar()!.contains(group('Font')!)).toBe(false)
  })

  describe('the guard itself bites', () => {
    // A guard that cannot fail is not a guard. These prove the selectors above
    // are load-bearing: take each half of the bar back out of the rendered DOM
    // and the queries the assertions rest on stop finding anything.
    it('notices if the formatting tabs disappear', async () => {
      await mount()
      expect(tabStrip()).not.toBeNull()

      tabStrip()!.remove()

      expect(tabStrip()).toBeNull()
      expect(tabLabels()).toEqual([])
    })

    it('notices if the clipboard actions disappear', async () => {
      await mount()
      expect(clipboardTools()).not.toBeNull()

      clipboardTools()!.remove()

      expect(clipboardTools()).toBeNull()
    })

    it('notices if the two halves are split back into separate bands', async () => {
      await mount()
      const strip = tabStrip()!
      expect(utilityBar()!.contains(strip)).toBe(true)

      // Re-parent the tab strip as a sibling band, the pre-merge arrangement.
      utilityBar()!.parentElement!.appendChild(strip)

      expect(utilityBar()!.contains(strip)).toBe(false)
    })
  })
})
