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
// The theme VOCABULARY is declared in MermaidSettings.ts and the control LIST in
// MermaidSettingsPanel.tsx. Both are imported here rather than retyped, so a mode
// or a control added there is asserted to appear instead of being asserted away.
import {
  DEFAULT_MERMAID_SETTINGS,
  DEFAULT_MERMAID_THEME_MODE,
  DEFAULT_MERMAID_VIEW_MODE,
  MERMAID_THEME_MODE_LABELS,
  MERMAID_THEME_MODES,
  MermaidThemeMode,
} from '../../Lexical/Nodes/MermaidSettings'
import { MermaidSettingsPanelProps, mermaidSettingsControls } from '../../Lexical/Nodes/MermaidSettingsPanel'

/**
 * Desktop layout — `isMobile` reads the MUTUALLY EXCLUSIVE `sm` query, which is
 * false here. The Popover this file now opens reads `MediaQueryBreakpoints.md`
 * instead, so the mock has to carry BOTH maps and answer true for the desktop
 * one, exactly as ToolbarPlugin.checklistSubsection.spec.tsx does.
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
  // jsdom has no matchMedia, and the Popover's own hooks call it directly rather
  // than through the mocked useMediaQuery.
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

/**
 * Props good enough to ENUMERATE the shared control list (its keys and captions).
 * Deliberately inert — nothing is clicked on the nodes it builds; the real
 * section's own props object is what the DOM assertions exercise.
 */
const probeControlProps = (): MermaidSettingsPanelProps => ({
  variant: 'panel',
  settings: DEFAULT_MERMAID_SETTINGS,
  onSettingsChange: () => undefined,
  viewMode: DEFAULT_MERMAID_VIEW_MODE,
  onViewModeChange: () => undefined,
  width: undefined,
  onWidthChange: () => undefined,
  height: undefined,
  onHeightChange: () => undefined,
  showWidth: true,
})

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
    // The inline clusters picked out of the shared control list...
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
    expect(captions).toContain('Theme')
    expect(captions).toContain('Background')
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
    expect(captions).toEqual(['Source', 'Fit', 'Align', 'Theme', 'Background', 'Diagram', 'block'])
  })
})

/**
 * THEMING, INLINE (t121). The user reported this section as "missing the
 * theming". It was not missing — Theme and Background were reachable, but only
 * behind the settings button, and since t119 removed the chart's own bar the
 * popover is the only other surface there is, so popover-only read as gone.
 *
 * They are now captioned segments of their own, beside Source / Fit / Align.
 * These tests therefore assert the control is in the RIBBON before anything is
 * clicked — the popover assertions further down are a separate guarantee and
 * would pass with the inline segment deleted again.
 *
 * Nothing here hardcodes a theme NAME. The options are compared against
 * MERMAID_THEME_MODES / MERMAID_THEME_MODE_LABELS, which is where the theme
 * vocabulary lives, so a mode added there (an `auto`/`system` mode, say) is
 * asserted to appear rather than asserted away.
 */
describe('the theming controls are inline in the section, not only in its popover', () => {
  /** The ribbon's captioned segment wrapper, by caption. */
  const captionedSegment = (caption: string) =>
    Array.from(container.querySelectorAll('.super-toolbar-group')).find(
      (group) => group.getAttribute('aria-label') === caption,
    )

  const openSection = async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    // No popover: whatever these tests find, they found it on the ribbon.
    expect(document.querySelector('[data-mermaid-settings="panel"]')).toBeNull()
  }

  it('puts the theme control on the ribbon itself, under its own caption', async () => {
    await openSection()
    const themeSegment = captionedSegment('Theme')
    expect(themeSegment).toBeDefined()
    const select = themeSegment!.querySelector('select[aria-label="Diagram theme"]')
    expect(select).not.toBeNull()
    // A mapping miss renders `<label>name</label>` instead of a glyph; this
    // cluster draws no Icon today, and this is what notices if one is added.
    expect(themeSegment!.querySelector('label')).toBeNull()
  })

  it('offers exactly the theme vocabulary MermaidSettings declares', async () => {
    await openSection()
    const select = captionedSegment('Theme')!.querySelector('select[aria-label="Diagram theme"]') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([...MERMAID_THEME_MODES])
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(
      MERMAID_THEME_MODES.map((mode) => MERMAID_THEME_MODE_LABELS[mode]),
    )
    // It shows the node's own theme, so the control is not write-only.
    expect(select.value).toBe(readNode((node) => node.getSettings().themeMode))
  })

  it('writes a theme chosen on the ribbon to the real node', async () => {
    await openSection()
    const select = captionedSegment('Theme')!.querySelector('select[aria-label="Diagram theme"]') as HTMLSelectElement
    const target = MERMAID_THEME_MODES.find((mode) => mode !== DEFAULT_MERMAID_THEME_MODE) as MermaidThemeMode
    expect(readNode((node) => node.getSettings().themeMode)).toBe(DEFAULT_MERMAID_THEME_MODE)

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(select, target)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })

    // A control wired to nothing renders identically to a wired one.
    expect(readNode((node) => node.getSettings().themeMode)).toBe(target)
    expect(readNode((node) => node.getKey())).toBe(mermaidKey)
  })

  it('reflects a theme set on the node back onto the ribbon control', async () => {
    await openSection()
    const target = MERMAID_THEME_MODES.find((mode) => mode !== DEFAULT_MERMAID_THEME_MODE) as MermaidThemeMode
    await act(async () => {
      ;(editor as LexicalEditor).update(() => {
        const node = $getRoot()
          .getChildren()
          .find((candidate) => $isMermaidNode(candidate)) as MermaidNode
        node.setSettings({ themeMode: target })
      })
      await Promise.resolve()
    })
    const select = captionedSegment('Theme')!.querySelector('select[aria-label="Diagram theme"]') as HTMLSelectElement
    expect(select.value).toBe(target)
  })

  it('puts the background control on the ribbon too, and it writes to the node', async () => {
    await openSection()
    const backgroundSegment = captionedSegment('Background')
    expect(backgroundSegment).toBeDefined()
    const toggle = backgroundSegment!.querySelector('button[aria-label="Themed diagram background"]')
    expect(toggle).not.toBeNull()
    expect(backgroundSegment!.querySelector('label')).toBeNull()

    expect(readNode((node) => node.getSettings().background)).toBe('transparent')
    await act(async () => {
      ;(toggle as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getSettings().background)).toBe('themed')
    expect(readNode((node) => node.getSettings().themeMode)).toBe(DEFAULT_MERMAID_THEME_MODE)
  })

  /**
   * The REACHABILITY sweep, derived rather than listed: every cluster in the one
   * shared control list has to be reachable from this section — as an inline
   * captioned segment, or inside the popover, or both. A control added to
   * `mermaidSettingsControls` and wired into neither surface is exactly the bug
   * that was reported, and this is the assertion that fails for it.
   */
  it('leaves no control in the shared list unreachable from this section', async () => {
    await openSection()
    const inlineCaptions = Array.from(container.querySelectorAll('.super-toolbar-group')).map((group) =>
      group.getAttribute('aria-label'),
    )
    await act(async () => {
      ;(captionedSegment('Diagram')!.querySelector('button') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const panel = document.querySelector('[data-mermaid-settings="panel"]')
    expect(panel).not.toBeNull()
    const panelCaptions = Array.from(panel!.querySelectorAll('span.text-passive-1')).map((span) => span.textContent)

    const declared = mermaidSettingsControls(probeControlProps())
    expect(declared.length).toBeGreaterThan(0)
    for (const control of declared) {
      expect([
        control.key,
        inlineCaptions.includes(control.caption) || panelCaptions.includes(control.caption),
      ]).toEqual([control.key, true])
    }
    // And the two theming controls specifically reached the RIBBON.
    const themeControl = declared.find((control) => control.key === 'theme')
    const backgroundControl = declared.find((control) => control.key === 'background')
    expect(themeControl).toBeDefined()
    expect(backgroundControl).toBeDefined()
    expect(inlineCaptions).toContain(themeControl!.caption)
    expect(inlineCaptions).toContain(backgroundControl!.caption)
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
 * REACHABILITY (t119). The chart container no longer mounts a configuration
 * surface — see MermaidNode.selection.spec.tsx, which asserts its absence. That
 * makes this section the single home of every mermaid setting, so "the section
 * exists" is no longer enough: each control the chart used to carry has to be
 * reachable HERE, through the real popover, and has to write to the real node.
 *
 * Five of them (Source, Fit, Align, Theme, Background) are also inline segments
 * above, as of t121. The other three — maximum height, pan & zoom and the width
 * strip — exist nowhere else in the product, so this is the only thing standing
 * between them and being unreachable.
 */
describe('every setting the chart no longer shows is reachable from this section', () => {
  const diagramGroup = () =>
    Array.from(container.querySelectorAll('.super-toolbar-group')).find(
      (candidate) => candidate.getAttribute('aria-label') === 'Diagram',
    )

  const openSettings = async () => {
    const button = diagramGroup()!.querySelector('button') as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
  }

  /** The popover renders outside `container`, so it is found on the document. */
  const panel = () => document.querySelector('[data-mermaid-settings="panel"]')
  const inPanel = (selector: string) => panel()!.querySelector(selector)

  const openPanel = async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    await openSettings()
    expect(panel()).not.toBeNull()
  }

  /** Drive a real <select>/<input> the way React's onChange sees it. */
  const setFieldValue = async (field: HTMLInputElement | HTMLSelectElement, value: string) => {
    const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    await act(async () => {
      setter?.call(field, value)
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('renders no panel until the settings button is pressed', async () => {
    await mount()
    await insertAndSelectMermaid()
    await activateMermaidTab()
    expect(diagramGroup()).toBeDefined()
    expect(panel()).toBeNull()
  })

  it('opens the shared panel, holding every control the chart used to carry', async () => {
    await openPanel()
    for (const selector of [
      '[role="group"][aria-label="View mode"]',
      '[role="group"][aria-label="Fit mode"]',
      '[role="group"][aria-label="Diagram alignment"]',
      'select[aria-label="Maximum diagram height"]',
      'select[aria-label="Diagram theme"]',
      'button[aria-label="Themed diagram background"]',
      'button[aria-label="Pan and zoom over the diagram"]',
      '[data-mermaid-width-section="true"]',
      'input[aria-label="Diagram width"]',
    ]) {
      expect([selector, inPanel(selector) !== null]).toEqual([selector, true])
    }
  })

  it('writes the theme to the node — the control exists on no other surface', async () => {
    await openPanel()
    expect(readNode((node) => node.getSettings().themeMode)).toBe('app')
    await setFieldValue(inPanel('select[aria-label="Diagram theme"]') as HTMLSelectElement, 'forest')
    expect(readNode((node) => node.getSettings().themeMode)).toBe('forest')
  })

  it('writes the maximum height to the node, and offers the pixel field once fixed', async () => {
    await openPanel()
    expect(readNode((node) => node.getSettings().maxHeight)).toBeUndefined()
    await setFieldValue(inPanel('select[aria-label="Maximum diagram height"]') as HTMLSelectElement, 'none')
    expect(readNode((node) => node.getSettings().maxHeight)).toBe('none')
    await setFieldValue(inPanel('select[aria-label="Maximum diagram height"]') as HTMLSelectElement, 'fixed')
    expect(readNode((node) => node.getSettings().maxHeight)).toBe(600)
    expect(inPanel('input[aria-label="Maximum diagram height in pixels"]')).not.toBeNull()
  })

  it('writes the background and the pan/zoom toggles to the node', async () => {
    await openPanel()
    expect(readNode((node) => node.getSettings().background)).toBe('transparent')
    await act(async () => {
      ;(inPanel('button[aria-label="Themed diagram background"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getSettings().background)).toBe('themed')

    expect(readNode((node) => node.getSettings().zoomPan)).toBe(true)
    await act(async () => {
      ;(inPanel('button[aria-label="Pan and zoom over the diagram"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getSettings().zoomPan)).toBe(false)
  })

  it('writes a width typed into the strip to the node, normalized', async () => {
    await openPanel()
    expect(readNode((node) => node.getWidth())).toBeUndefined()
    const field = inPanel('input[aria-label="Diagram width"]') as HTMLInputElement
    await setFieldValue(field, '420')
    await act(async () => {
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })
    // A bare number is pixels, and the node stores the normalized spelling.
    expect(readNode((node) => node.getWidth())).toBe('420px')
  })

  it('also reaches the width presets and the Fit-to-container reset', async () => {
    await openPanel()
    const presets = document.querySelector('[role="group"][aria-label="Width presets"]')
    expect(presets).not.toBeNull()
    const half = Array.from(presets!.querySelectorAll('button')).find(
      (button) => button.textContent === '50%',
    ) as HTMLButtonElement
    await act(async () => {
      half.click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getWidth())).toBe('50%')

    const reset = Array.from(panel()!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Fit to container',
    ) as HTMLButtonElement
    expect(reset).toBeDefined()
    await act(async () => {
      reset.click()
      await Promise.resolve()
    })
    expect(readNode((node) => node.getWidth())).toBeUndefined()
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
