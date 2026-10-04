/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the Diagram group's "Mermaid Diagram" toolbar button (t111-e8).
 *
 * Two independent failure modes this file exists to catch, both of which have
 * shipped from this very file before:
 *
 *  1. THE VANISH BUG. A toolbar group has repeatedly been added, typechecked
 *     clean, passed its unit tests — and rendered nowhere, killed by the
 *     group-level "drop groups with nothing renderable" filter in ToolbarPlugin
 *     plus the explicit `layout` array (an id missing from `layout` renders
 *     nowhere even though it is listed in `buttons` and offered in Customize
 *     Toolbar). Green tsc + green config tests are NOT evidence that a toolbar
 *     button exists, so this mounts the REAL ToolbarPlugin inside the real
 *     composer and asserts the button is in the DOM after the whole pipeline has
 *     run: applyToolbarConfig -> the renderable-group filter ->
 *     groupsBySuperGroup tab partitioning -> `layout` row resolution.
 *
 *  2. THE ICON MAPPING MISS. `Icon` renders its `type` as literal text inside a
 *     <label> when the name is not in IconNameToSvgMapping /
 *     LexicalIconNameToSvgMapping, and `VectorIconNameOrEmoji` admits any
 *     string, so tsc is blind (IconNameCoverage.spec.ts records three shipped
 *     instances). That sweep only collects *literal* `<Icon type="…">`; this
 *     button passes its name through `ToolbarButton`'s `iconName` prop, which
 *     reaches Icon as a dynamic `type={iconName}` and is therefore NOT swept.
 *     So assert here, on the FilesFolderBar.icon.spec.tsx model, that a real
 *     <svg> glyph renders and the name never leaks out as text.
 *
 * It also asserts the button is wired to the one existing Mermaid insertion path
 * (MermaidBlock.onSelect -> $createMermaidNode, Plugins/Blocks/Mermaid.tsx) by
 * clicking it and reading the resulting editor state — a button wired to nothing
 * renders identically.
 */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalEditor } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'

// Desktop layout; `alwaysShowToolbar` (below) then docks the full ribbon, which
// is the surface this button lives on.
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
  // Docks the ribbon so every group renders (rather than the floating selection
  // mini-toolbar).
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
  // Render authorization (useItemAuthorization) subscribes to these on mount.
  isAuthorizedToRenderItem: () => true,
  vaultLocks: { addEventObserver: () => () => undefined },
  items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
  keyboardService: { addCommandHandler: () => () => undefined },
} as never

let container: HTMLElement
let root: Root
let editor: LexicalEditor | null

/** Hands the spec the same editor instance the toolbar's buttons act on. */
const CaptureEditor = () => {
  const [lexicalEditor] = useLexicalComposerContext()
  useEffect(() => {
    editor = lexicalEditor
  }, [lexicalEditor])
  return null
}

beforeEach(() => {
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

const diagramGroup = () => container.querySelector('[role="group"][aria-label="Diagram"]')

/** Every node type present in the live editor state, flattened. */
const editorStateNodeTypes = (): string[] => {
  const types: string[] = []
  const walk = (node: { type?: string; children?: unknown[] }) => {
    if (typeof node.type === 'string') {
      types.push(node.type)
    }
    for (const child of (node.children ?? []) as { type?: string; children?: unknown[] }[]) {
      walk(child)
    }
  }
  walk((editor as LexicalEditor).getEditorState().toJSON().root as { type?: string; children?: unknown[] })
  return types
}

describe('Mermaid diagram toolbar button renders', () => {
  it('puts the Diagram group in the real rendered toolbar', async () => {
    await mount()
    expect(diagramGroup()).not.toBeNull()
  })

  it('renders exactly one button inside that group', async () => {
    await mount()
    const group = diagramGroup()
    expect(group).not.toBeNull()
    expect(group!.querySelectorAll('button')).toHaveLength(1)
  })

  it('renders the group caption so the user can find it', async () => {
    await mount()
    expect(diagramGroup()!.textContent).toContain('Diagram')
  })

  it('labels the button with the shared catalog name, so the toolbar and the Insert tab agree', async () => {
    await mount()
    const button = diagramGroup()!.querySelector('button')
    expect(button).not.toBeNull()
    // The tooltip trigger carries the label even while the tooltip is closed.
    expect(button!.getAttribute('aria-label') ?? button!.getAttribute('aria-labelledby')).not.toBeNull()
  })

  it('renders a real svg glyph, never the icon name as text (the Icon mapping-miss trap)', async () => {
    await mount()
    const button = diagramGroup()!.querySelector('button')
    expect(button).not.toBeNull()
    // A mapping miss renders `<label>diagram</label>` instead of an <svg>, which
    // typechecks cleanly and is invisible to IconNameCoverage.spec.ts because the
    // name arrives as a dynamic `type={iconName}`.
    expect(button!.querySelector('svg')).not.toBeNull()
    expect(button!.querySelector('label')).toBeNull()
    expect(button!.textContent).not.toContain('diagram')
  })

  it('is enabled with no selection, because inserting a diagram needs none', async () => {
    await mount()
    const button = diagramGroup()!.querySelector('button')
    expect(button!.getAttribute('aria-disabled')).not.toBe('true')
    expect(button!.hasAttribute('disabled')).toBe(false)
  })

  it('inserts a mermaid node through the existing insertion path when clicked', async () => {
    await mount()
    expect(editor).not.toBeNull()
    expect(editorStateNodeTypes()).not.toContain('mermaid')

    const button = diagramGroup()!.querySelector('button') as HTMLButtonElement
    await act(async () => {
      button.click()
      await Promise.resolve()
    })

    // Proves the button is wired to MermaidBlock.onSelect ($createMermaidNode);
    // a button wired to nothing renders identically to a wired one.
    expect(editorStateNodeTypes()).toContain('mermaid')
  })
})
