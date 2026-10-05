/**
 * @jest-environment jsdom
 *
 * t120 — AUTO-ACTIVATION of the "Mermaid" contextual ribbon tab.
 *
 * t119 moved every mermaid setting off the chart and into the toolbar's
 * contextual section, which left one regression behind: clicking a diagram made
 * the "Mermaid" tab *appear*, but the user then had to click the tab too before
 * a single control was on screen. Selecting the chart now activates that tab.
 *
 * Three behaviours, and they pull against each other — which is why all three
 * are asserted here rather than just the first:
 *
 *   1. ACTIVATE   — a selected diagram makes the Mermaid tab the active tab, and
 *                   its controls are in the DOM with no second click.
 *   2. RESTORE    — deselecting hands back the tab the diagram displaced, rather
 *                   than dumping the user on Home (or on a tab that is gone).
 *   3. DON'T FIGHT— a tab the user picks themselves while the diagram is still
 *                   selected is final: no yank back on the next Lexical update,
 *                   and no shove back to the displaced tab on deselect either.
 *
 * Plus the surface this must NOT touch: undocked there is no tab strip at all,
 * only the floating toolbar's flat "Mermaid tools" row.
 *
 * Everything is asserted against a REAL LexicalComposer holding a REAL
 * MermaidNode and the REAL ToolbarPlugin, on the model of
 * ToolbarPlugin.mermaidSection.spec.tsx — a pure-logic test of a tab reducer
 * would be blind to the two things that actually break here (an effect that
 * re-runs on Lexical's selection churn, and a contextual group that renders
 * nothing).
 *
 * Decorators are not mounted (no ContentEditable in this tree), so the heavy
 * `mermaid` library is never imported.
 */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  $createNodeSelection,
  $createRangeSelection,
  $getRoot,
  $isTextNode,
  $setSelection,
  LexicalEditor,
} from 'lexical'
import { $createTableNodeWithDimensions } from '@lexical/table'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { $createMermaidNode, $isMermaidNode, MermaidNode } from '../../Lexical/Nodes/MermaidNode'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'

/**
 * Desktop layout — `isMobile` reads the MUTUALLY EXCLUSIVE `sm` query, which is
 * false here, while the Popover reads `MediaQueryBreakpoints.md`. Both maps are
 * carried for the same reason ToolbarPlugin.mermaidSection.spec.tsx carries them.
 */
jest.mock('@/Hooks/useMediaQuery', () => {
  const MediaQueryBreakpoints = {
    sm: 'q-sm',
    md: 'q-md',
    lg: 'q-lg',
    xl: 'q-xl',
    '2xl': 'q-2xl',
    pointerFine: 'q-fine',
  }
  const MutuallyExclusiveMediaQueryBreakpoints = {
    sm: 'x-sm',
    md: 'x-md',
    lg: 'x-lg',
    xl: 'x-xl',
    '2xl': 'x-2xl',
    pointerFine: 'x-fine',
  }
  return {
    MediaQueryBreakpoints,
    MutuallyExclusiveMediaQueryBreakpoints,
    useMediaQuery: (query: string) => query === MediaQueryBreakpoints.md,
  }
})

// The FLOATING toolbar reaches SelectionTools, which needs the pane context.
jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Mounting the real ToolbarPlugin costs several seconds in jsdom; under a full
// parallel run that crosses jest's 5s default and fails as a TIMEOUT, which reads
// exactly like a broken toolbar. Headroom, not a wait for anything async.
jest.setTimeout(30000)

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Docked by default; `docked = false` leaves the toolbar FLOATING. */
let docked = true

const fakeApp = {
  getPreference: (key: string, fallback: unknown) => {
    if (key === PrefKey.AlwaysShowSuperToolbar) {
      return docked
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
let editor: LexicalEditor | null

const CaptureEditor = () => {
  const [lexicalEditor] = useLexicalComposerContext()
  useEffect(() => {
    editor = lexicalEditor
  }, [lexicalEditor])
  return null
}

beforeEach(() => {
  docked = true
  jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as never
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  editor = null
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
            <CaptureEditor />
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })
}

const liveEditor = () => editor as LexicalEditor

/** Insert a diagram and select it as a NODE selection — what clicking it does. */
const insertAndSelectMermaid = async () => {
  await act(async () => {
    liveEditor().update(() => {
      const node = $createMermaidNode('graph TD\n  A --> B')
      $getRoot().append(node)
      const selection = $createNodeSelection()
      selection.add(node.getKey())
      $setSelection(selection)
    })
    await Promise.resolve()
  })
}

/** Re-select the diagram already in the document (no new node). */
const reselectMermaid = async () => {
  await act(async () => {
    liveEditor().update(() => {
      const node = $getRoot()
        .getChildren()
        .find((candidate) => $isMermaidNode(candidate)) as MermaidNode
      const selection = $createNodeSelection()
      selection.add(node.getKey())
      $setSelection(selection)
    })
    await Promise.resolve()
  })
}

/**
 * Churn of the kind Lexical produces constantly: the node's state changes while
 * it stays selected, so the toolbar's mermaid listener publishes a NEW selection
 * object and the component re-renders. An activation effect without a latch
 * re-fires here.
 */
const churnSelection = async (alignment: 'left' | 'center' | 'right') => {
  await act(async () => {
    liveEditor().update(() => {
      const node = $getRoot()
        .getChildren()
        .find((candidate) => $isMermaidNode(candidate)) as MermaidNode
      node.setSettings({ alignment })
    })
    await Promise.resolve()
  })
}

const clearSelection = async () => {
  await act(async () => {
    liveEditor().update(() => {
      $setSelection(null)
    })
    await Promise.resolve()
  })
}

/** A table the caret sits inside — the OTHER contextual widget, for contrast. */
const insertAndEnterTable = async () => {
  await act(async () => {
    liveEditor().update(() => {
      const table = $createTableNodeWithDimensions(2, 2, true)
      $getRoot().append(table)
      // The first descendant of a header cell is its (empty) TextNode, not the
      // paragraph, so the point type has to follow the node rather than be
      // assumed — an 'element' point at a text node silently yields no
      // selection at all, and the toolbar would then look correctly inert.
      const caretTarget = table.getFirstDescendant()
      if (caretTarget !== null) {
        const selection = $createRangeSelection()
        const pointType = $isTextNode(caretTarget) ? 'text' : 'element'
        selection.anchor.set(caretTarget.getKey(), 0, pointType)
        selection.focus.set(caretTarget.getKey(), 0, pointType)
        $setSelection(selection)
      }
    })
    await Promise.resolve()
  })
}

/**
 * The RIBBON tab strip, addressed by its own accessible name. Scoped on purpose:
 * the floating toolbar renders a SECOND `role="tablist"` (SelectionTools' "AI
 * action groups"), so a bare `[role="tablist"]` probe would read that one's
 * active tab and report nonsense — and, in the undocked assertions below, would
 * find a tab strip where the ribbon has none.
 */
const RIBBON_TABLIST = '[role="tablist"][aria-label="Formatting groups"]'

const tabs = () => Array.from(container.querySelectorAll(`${RIBBON_TABLIST} [role="tab"]`)) as HTMLButtonElement[]

const tabLabels = () => tabs().map((tab) => tab.textContent)

/**
 * The ACTIVE tab as the DOM reports it. Read off `aria-selected` rather than off
 * a class name, because that attribute is also what a screen reader and the
 * ribbon's own highlight are driven from — if this is wrong the user is wrong.
 */
const activeTabLabel = (): string | null => {
  const selected = tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true')
  // Exactly one tab is active at a time; two would mean `effectiveTabId` had
  // stopped being a single resolution and the assertion below should say so.
  expect(selected.map((tab) => tab.textContent)).toHaveLength(1)
  return selected[0].textContent
}

const clickTab = async (label: string) => {
  const tab = tabs().find((candidate) => candidate.textContent === label)
  expect([label, tab !== undefined]).toEqual([label, true])
  await act(async () => {
    tab!.click()
    await Promise.resolve()
  })
}

const segment = (caption: string) => container.querySelector(`[role="group"][aria-label="${caption}"]`)

describe('1. selecting a diagram activates its ribbon tab', () => {
  it('starts on the first tab with nothing selected, and there is no Mermaid tab', async () => {
    await mount()
    expect(tabLabels()).toEqual(['Home', 'Insert', 'Layout', 'AI', 'Tools'])
    expect(activeTabLabel()).toBe('Home')
  })

  it('makes Mermaid the ACTIVE tab the moment the diagram is selected', async () => {
    await mount()
    await insertAndSelectMermaid()
    expect(tabLabels()).toContain('Mermaid')
    expect(activeTabLabel()).toBe('Mermaid')
  })

  it('puts the diagram controls on screen with NO second click', async () => {
    await mount()
    // Before selection the section does not exist at all.
    expect(segment('Fit mode')).toBeNull()

    await insertAndSelectMermaid()

    // The whole point of t120: these are reachable without clicking the tab.
    // (ToolbarPlugin.mermaidSection.spec.tsx asserts the same set, but only
    // AFTER an explicit `activateMermaidTab()`.)
    expect(segment('View mode')).not.toBeNull()
    expect(segment('Fit mode')).not.toBeNull()
    expect(segment('Diagram alignment')).not.toBeNull()
    const captions = Array.from(container.querySelectorAll('.super-toolbar-group')).map((group) =>
      group.getAttribute('aria-label'),
    )
    expect(captions).toEqual(['Source', 'Fit', 'Align', 'Diagram', 'block'])
  })

  it('activates again on a second diagram selection, so the latch resets', async () => {
    await mount()
    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')
    await clearSelection()
    expect(tabLabels()).not.toContain('Mermaid')
    await reselectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')
  })

  it('leaves OTHER contextual widgets merely available — a table does not steal the ribbon', async () => {
    await mount()
    await insertAndEnterTable()
    // The contextual tab is offered...
    expect(tabLabels()).toContain('Table')
    // ...but the caret is in prose the user is still editing, so the ribbon is
    // not taken from them. Only a diagram, which can only become the selected
    // node by being clicked, gets the auto-switch.
    expect(activeTabLabel()).toBe('Home')
  })
})

describe('2. deselecting hands back the tab the diagram displaced', () => {
  it('restores a tab the user had deliberately chosen beforehand', async () => {
    await mount()
    await clickTab('Insert')
    expect(activeTabLabel()).toBe('Insert')

    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')

    await clearSelection()
    expect(tabLabels()).not.toContain('Mermaid')
    // Not Home. Being dropped on Home is the "worse than the extra click"
    // outcome this exists to prevent.
    expect(activeTabLabel()).toBe('Insert')
  })

  it('restores the implicit first tab when that is where the user was', async () => {
    await mount()
    expect(activeTabLabel()).toBe('Home')
    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')
    await clearSelection()
    expect(activeTabLabel()).toBe('Home')
  })

  it('survives a full round trip, restoring the same tab every time', async () => {
    await mount()
    await clickTab('Tools')

    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')
    await clearSelection()
    expect(activeTabLabel()).toBe('Tools')

    // Second pass on the SAME node: the restore is consumed by the first
    // deselect, so a second one has to be recorded rather than remembered.
    await reselectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')
    await clearSelection()
    expect(activeTabLabel()).toBe('Tools')
  })

  it('never strands the user on a tab that has vanished', async () => {
    await mount()
    await clickTab('Layout')
    await insertAndSelectMermaid()
    await clearSelection()
    // Whatever the restore decides, it has to be a tab that still exists.
    expect(tabLabels()).toContain(activeTabLabel())
  })
})

describe('3. a tab the user picks while the diagram is selected is final', () => {
  it('does not yank them back on the next Lexical update', async () => {
    await mount()
    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')

    await clickTab('Home')
    // The click itself re-renders and re-runs the activation effect; an effect
    // without the latch undoes the click before the user sees it.
    expect(activeTabLabel()).toBe('Home')

    // Then the churn Lexical actually produces: the node changes under the same
    // selection, and the selection is re-applied.
    await churnSelection('center')
    expect(activeTabLabel()).toBe('Home')
    await reselectMermaid()
    expect(activeTabLabel()).toBe('Home')
    await churnSelection('right')
    expect(activeTabLabel()).toBe('Home')

    // And the tab is still THERE — respecting the user is not hiding the tab.
    expect(tabLabels()).toContain('Mermaid')
  })

  it('does not shove the displaced tab back at them on deselect either', async () => {
    await mount()
    await clickTab('Insert')
    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')

    // They move somewhere that is neither the displaced tab nor the fallback,
    // so a restore and a reset-to-Home are both distinguishable from staying.
    await clickTab('Tools')
    expect(activeTabLabel()).toBe('Tools')

    await clearSelection()
    expect(activeTabLabel()).toBe('Tools')
  })

  it('treats re-clicking the Mermaid tab as staying put, so the restore survives', async () => {
    await mount()
    await clickTab('Insert')
    await insertAndSelectMermaid()
    // Clicking the tab you are already on is not a move away from it.
    await clickTab('Mermaid')
    expect(activeTabLabel()).toBe('Mermaid')
    await clearSelection()
    expect(activeTabLabel()).toBe('Insert')
  })

  it('ends our claim on their old tab once they leave ours, even if they walk back', async () => {
    await mount()
    await clickTab('Insert')
    await insertAndSelectMermaid()
    expect(activeTabLabel()).toBe('Mermaid')

    // They leave the tab we put them on. That deliberate choice retires our
    // claim on 'Insert' — we are no longer the reason they are anywhere.
    await clickTab('Tools')
    // Walking back onto the Mermaid tab does not re-arm the claim: they are
    // standing here by their own decision now, not by our displacement.
    await clickTab('Mermaid')
    expect(activeTabLabel()).toBe('Mermaid')

    await clearSelection()
    // So the vanishing tab falls back to the first tab, exactly as it did
    // before t120 — rather than teleporting them to a tab they deliberately
    // left three clicks ago.
    expect(activeTabLabel()).toBe('Home')
  })

  it('lets them walk back onto the Mermaid tab after leaving it', async () => {
    await mount()
    await insertAndSelectMermaid()
    await clickTab('Insert')
    expect(activeTabLabel()).toBe('Insert')
    await clickTab('Mermaid')
    expect(activeTabLabel()).toBe('Mermaid')
    expect(segment('Fit mode')).not.toBeNull()
  })
})

describe('4. the undocked toolbar is left exactly as it was', () => {
  const accessibleName = (button: Element): string =>
    button.getAttribute('aria-label') ??
    (button.getAttribute('aria-labelledby')
      ? (document.getElementById(button.getAttribute('aria-labelledby') as string)?.textContent ?? '')
      : '')

  it('has no tab strip at all, so there is nothing to activate', async () => {
    docked = false
    await mount()
    await insertAndSelectMermaid()
    expect(container.querySelector(RIBBON_TABLIST)).toBeNull()
    expect(tabs()).toHaveLength(0)
  })

  it('still reaches the flat "Mermaid tools" row and its settings button', async () => {
    docked = false
    await mount()
    await insertAndSelectMermaid()
    const row = container.querySelector('[aria-label="Mermaid tools"]')
    expect(row).not.toBeNull()
    const buttons = Array.from(row!.querySelectorAll('button'))
    expect(buttons.map(accessibleName)).toContain('Mermaid settings')
  })

  it('still takes that row away when the diagram is deselected', async () => {
    docked = false
    await mount()
    await insertAndSelectMermaid()
    expect(container.querySelector('[aria-label="Mermaid tools"]')).not.toBeNull()
    await clearSelection()
    expect(container.querySelector('[aria-label="Mermaid tools"]')).toBeNull()
  })
})
