/**
 * @jest-environment jsdom
 *
 * VANISH GUARD + SELECTION GATE for the dedicated "Mermaid" toolbar section
 * (t118).
 *
 * This section is the exact shape that has silently disappeared from this toolbar
 * twice: a group whose contents are all special-cased JSX rather than
 * renderer-backed buttons. Green `tsc` and green pure-logic tests are NOT evidence
 * that it appears. So this mounts the REAL ToolbarPlugin inside the real composer
 * and drives the whole pipeline — the mermaid selection listener, the
 * `effectiveContextualWidget` derivation, `hasContextualTab`, the tab strip, and
 * the captioned-segment renderer — then asserts on the resulting DOM.
 *
 * It gates BOTH WAYS, because "always visible" and "correctly gated" render
 * identically when a chart happens to be selected:
 *   - with a mermaid node selected, the Mermaid tab and its segments exist;
 *   - with nothing selected, the tab is gone.
 *
 * It also asserts the ICON MAPPING MISS cannot have happened: `Icon` renders its
 * `type` as literal text inside a <label> when the name is in neither icon map,
 * `VectorIconNameOrEmoji` admits any string so tsc is blind, and the names here
 * arrive as dynamic props so the IconNameCoverage sweep does not see them either.
 *
 * Decorators are not mounted (no ContentEditable in this tree), so the heavy
 * `mermaid` library is never imported — the section is driven purely off node
 * state, which is the point.
 */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { $createNodeSelection, $getRoot, $setSelection, LexicalEditor } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { $createMermaidNode, $isMermaidNode, MermaidNode } from '../../Lexical/Nodes/MermaidNode'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

// The FLOATING toolbar reaches SelectionTools, which needs the pane context. Stubbed
// on the SelectionTools.spec.tsx model rather than mounting a real PaneController.
jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Mounting the real ToolbarPlugin costs several seconds in jsdom; under a full
// parallel run that crossed jest's 5s default and failed as a TIMEOUT, which reads
// exactly like a broken toolbar. Headroom, not a wait for anything async.
jest.setTimeout(30000)

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Docked by default. `docked = false` leaves the toolbar FLOATING, which is the
 * other surface the contextual buttons reach — a flat row rather than captioned
 * segments — and the one a mutation that empties the flat list would break.
 */
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

let mermaidKey = ''

/** Insert a diagram and select it as a NODE selection — what clicking it does. */
const insertAndSelectMermaid = async () => {
  await act(async () => {
    ;(editor as LexicalEditor).update(() => {
      const node = $createMermaidNode('graph TD\n  A --> B')
      $getRoot().append(node)
      mermaidKey = node.getKey()
      const selection = $createNodeSelection()
      selection.add(node.getKey())
      $setSelection(selection)
    })
    await Promise.resolve()
  })
}

const clearSelection = async () => {
  await act(async () => {
    ;(editor as LexicalEditor).update(() => {
      $setSelection(null)
    })
    await Promise.resolve()
  })
}

const tabLabels = () =>
  Array.from(container.querySelectorAll('[role="tablist"] [role="tab"]')).map((tab) => tab.textContent)

const mermaidTab = () =>
  Array.from(container.querySelectorAll('[role="tablist"] [role="tab"]')).find(
    (tab) => tab.textContent === 'Mermaid',
  ) as HTMLButtonElement | undefined

const activateMermaidTab = async () => {
  const tab = mermaidTab()
  expect(tab).toBeDefined()
  await act(async () => {
    tab!.click()
    await Promise.resolve()
  })
}

const segment = (caption: string) => container.querySelector(`[role="group"][aria-label="${caption}"]`)

/** Read the live node's settings back out of the editor state. */
const readNode = <T,>(read: (node: MermaidNode) => T): T => {
  let result: T | undefined
  ;(editor as LexicalEditor).getEditorState().read(() => {
    const node = $getRoot()
      .getChildren()
      .find((candidate) => $isMermaidNode(candidate))
    result = read(node as MermaidNode)
  })
  return result as T
}

describe('the Mermaid toolbar section is gated on a selected diagram', () => {
  it('offers no Mermaid tab with nothing selected', async () => {
    await mount()
    expect(tabLabels().length).toBeGreaterThan(1)
    expect(tabLabels()).not.toContain('Mermaid')
  })

  it('offers a Mermaid tab once a diagram is selected', async () => {
    await mount()
    await insertAndSelectMermaid()
    expect(tabLabels()).toContain('Mermaid')
  })

  it('takes the tab away again when the diagram is deselected', async () => {
    await mount()
    await insertAndSelectMermaid()
    expect(tabLabels()).toContain('Mermaid')
    await clearSelection()
    expect(tabLabels()).not.toContain('Mermaid')
  })

  it('wins over the generic decorator-block section, which would only offer zoom', async () => {
    await mount()
    await insertAndSelectMermaid()
    // Before this work a mermaid block resolved to the generic "Diagram" bucket.
    expect(tabLabels()).not.toContain('Diagram')
    expect(tabLabels()).toContain('Mermaid')
  })
})

describe('the Mermaid section renders its captioned segments — the vanish guard', () => {
  it('renders every segment the section declares', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    // The three inline clusters picked out of the shared control list...
    expect(segment('View mode')).not.toBeNull()
    expect(segment('Fit mode')).not.toBeNull()
    expect(segment('Diagram alignment')).not.toBeNull()
    // ...and the captioned segment wrappers themselves.
    const captions = Array.from(container.querySelectorAll('.super-toolbar-group')).map((group) =>
      group.getAttribute('aria-label'),
    )
    expect(captions).toContain('Source')
    expect(captions).toContain('Fit')
    expect(captions).toContain('Align')
    expect(captions).toContain('Diagram')
  })

  it('renders the three fit modes as pressable buttons, one of them active', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    const buttons = Array.from(segment('Fit mode')!.querySelectorAll('button'))
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.textContent)).toEqual(['Fit width', 'Fit both', 'Actual size'])
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    // The default is fit-width, which is the fit the user asked for.
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('renders the alignment buttons as real svg glyphs, never the icon name as text', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    const buttons = Array.from(segment('Diagram alignment')!.querySelectorAll('button'))
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      // A mapping miss renders `<label>align-left</label>` instead of an <svg>:
      // typechecks clean, and invisible to the IconNameCoverage sweep because the
      // name arrives as a dynamic prop.
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.querySelector('label')).toBeNull()
      for (const name of ['align-left', 'align-center', 'align-right']) {
        expect(button.textContent ?? '').not.toContain(name)
      }
    }
  })

  it('renders the settings button as a glyph, not the text "tune"', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    const group = Array.from(container.querySelectorAll('.super-toolbar-group')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Diagram',
    )
    expect(group).toBeDefined()
    const button = group!.querySelector('button')
    expect(button).not.toBeNull()
    expect(button!.querySelector('svg')).not.toBeNull()
    expect(button!.querySelector('label')).toBeNull()
    expect(button!.textContent ?? '').not.toContain('tune')
  })

  it('still ends with the block zoom affordance, as every contextual section does', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    const captions = Array.from(container.querySelectorAll('.super-toolbar-group')).map((group) =>
      group.getAttribute('aria-label'),
    )
    // The generic trailing segment's caption comes from the `block` translation
    // key, which is lower-case — asserted as rendered, not as prose.
    expect(captions).toContain('block')
    expect(captions).toEqual(['Source', 'Fit', 'Align', 'Diagram', 'block'])
  })
})

describe('the Insert tab draws the Mermaid catalog entry with the diagram glyph', () => {
  const activateTab = async (label: string) => {
    const tab = Array.from(container.querySelectorAll('[role="tablist"] [role="tab"]')).find(
      (candidate) => candidate.textContent === label,
    ) as HTMLButtonElement | undefined
    expect(tab).toBeDefined()
    await act(async () => {
      tab!.click()
      await Promise.resolve()
    })
  }

  /**
   * A ToolbarButton's accessible name arrives through its StyledTooltip, i.e. via
   * `aria-labelledby` pointing at the tooltip element — not `aria-label` — so the
   * name has to be resolved rather than read off the button.
   */
  const accessibleName = (button: Element): string => {
    const direct = button.getAttribute('aria-label')
    if (direct) {
      return direct
    }
    const id = button.getAttribute('aria-labelledby')
    return (id ? (document.getElementById(id)?.textContent ?? '') : '') || ''
  }

  const mermaidCatalogButton = () => {
    const section = Array.from(container.querySelectorAll('[role="group"]')).find(
      (group) => group.getAttribute('aria-label') === 'blockCategoryDiagramsCharts',
    )
    if (!section) {
      throw new Error('the Insert tab has no "Diagrams & charts" section at all')
    }
    const buttons = Array.from(section.querySelectorAll('button'))
    if (buttons.length === 0) {
      throw new Error('the "Diagrams & charts" section rendered no buttons at all')
    }
    return buttons.find((button) => accessibleName(button).includes('MermaidDiagram'))
  }

  it('renders a real svg, never the icon name as text', async () => {
    await mount()
    await activateTab('Insert')
    const button = mermaidCatalogButton()
    expect(button).toBeDefined()
    expect(button!.querySelector('svg')).not.toBeNull()
    expect(button!.querySelector('label')).toBeNull()
    // `<label>diagram</label>` is what a mapping miss renders instead of the glyph.
    expect(button!.textContent ?? '').not.toContain('diagram')
    expect(button!.textContent ?? '').toBe('')
  })
})

describe('the Mermaid section writes to the selected node, not to a copy of its state', () => {
  it('changing the fit mode reaches the node', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    expect(readNode((node) => node.getSettings().fitMode)).toBe('fitWidth')

    const fitBoth = Array.from(segment('Fit mode')!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fit both',
    ) as HTMLButtonElement
    await act(async () => {
      fitBoth.click()
      await Promise.resolve()
    })

    // A control wired to nothing renders identically to a wired one.
    expect(readNode((node) => node.getSettings().fitMode)).toBe('fitBoth')
    expect(readNode((node) => node.getKey())).toBe(mermaidKey)
  })

  it('changing the alignment reaches the node', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    const centre = Array.from(segment('Diagram alignment')!.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Align centre',
    ) as HTMLButtonElement
    await act(async () => {
      centre.click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getSettings().alignment)).toBe('center')
  })

  it('changing the view mode reaches the node, so "show source" is one setting', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    expect(readNode((node) => node.getViewMode())).toBe('split')
    const preview = Array.from(segment('View mode')!.querySelectorAll('button')).find(
      (button) => button.textContent === 'preview',
    ) as HTMLButtonElement
    await act(async () => {
      preview.click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getViewMode())).toBe('preview')
  })

  it('reflects the node back on the toolbar, so the two surfaces agree', async () => {
    await mount()
    await insertAndSelectMermaid()
    await act(async () => {
      ;(editor as LexicalEditor).update(() => {
        const node = $getRoot()
          .getChildren()
          .find((candidate) => $isMermaidNode(candidate)) as MermaidNode
        node.setSettings({ alignment: 'right' })
      })
      await Promise.resolve()
    })
    await activateMermaidTab()
    const pressed = Array.from(segment('Diagram alignment')!.querySelectorAll('button')).filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    )
    expect(pressed).toHaveLength(1)
    expect(pressed[0].getAttribute('aria-label')).toBe('Align right')
  })
})

/**
 * The FLOATING toolbar's flat contextual row. It carries the same actions without
 * captioned segments, and it is a separate code path from the ribbon's — the
 * ribbon's Mermaid tab survives on the generic zoom button alone, so a mutation
 * that empties the flat list is invisible to every assertion above. This closes
 * that gap.
 */
describe('the floating toolbar also surfaces the Mermaid settings action', () => {
  const contextualRow = () => container.querySelector('[aria-label="Mermaid tools"]')

  /**
   * A ToolbarButton's name arrives through its StyledTooltip as `aria-labelledby`,
   * not `aria-label`, so it has to be resolved. A probe that read only
   * `aria-label` would find nothing and could never fail for the right reason.
   */
  const accessibleName = (button: Element): string =>
    button.getAttribute('aria-label') ??
    (button.getAttribute('aria-labelledby')
      ? (document.getElementById(button.getAttribute('aria-labelledby') as string)?.textContent ?? '')
      : '')

  it('renders a Mermaid contextual row with a settings button when the toolbar floats', async () => {
    docked = false
    await mount()
    await insertAndSelectMermaid()
    const row = contextualRow()
    expect(row).not.toBeNull()
    const buttons = Array.from(row!.querySelectorAll('button'))
    // The settings action plus the generic zoom affordance.
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    expect(buttons.map(accessibleName)).toContain('Mermaid settings')
  })

  it('renders no Mermaid contextual row with nothing selected', async () => {
    docked = false
    await mount()
    expect(contextualRow()).toBeNull()
  })

  it('draws the settings action as a glyph there too, not the text "tune"', async () => {
    docked = false
    await mount()
    await insertAndSelectMermaid()
    const button = Array.from(contextualRow()!.querySelectorAll('button')).find(
      (candidate) => accessibleName(candidate) === 'Mermaid settings',
    )
    expect(button).toBeDefined()
    expect(button!.querySelector('svg')).not.toBeNull()
    expect(button!.querySelector('label')).toBeNull()
    expect(button!.textContent ?? '').toBe('')
  })
})
