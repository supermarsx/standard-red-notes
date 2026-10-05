/** @jest-environment jsdom */

/**
 * The half that would otherwise rot silently: what the Mermaid block actually
 * puts ON SCREEN, and what it no longer does.
 *
 * t119 — the user asked for the diagram's configuration NOT to be offered twice.
 * It had been mounted on the chart's own bar AND in the editor toolbar's Mermaid
 * section; the toolbar section is now its single home, and the chart container
 * mounts no configuration surface at all. "A panel nobody renders" and "a panel
 * that renders" are indistinguishable to tsc and to the panel's own unit tests,
 * so this file mounts a REAL LexicalComposer containing a REAL MermaidNode and
 * asserts the absence directly, in BOTH selection states.
 *
 * What survives on the chart is deliberately small: its own header (identity,
 * Templates, Reload — actions on the SOURCE, not configuration), the editing
 * panes, and the corner drag handle, which is still gated on the real Lexical
 * selection. The toolbar half — that every removed control is reachable there —
 * is asserted in Plugins/ToolbarPlugin/ToolbarPlugin.mermaidSection.spec.tsx.
 *
 * jsdom has no layout engine, so nothing here asserts geometry — every rect is
 * 0. "Does the diagram fit its container" was measured in headless Chrome; see
 * the header of MermaidSvgViewport.tsx.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $setSelection,
  CLICK_COMMAND,
  type LexicalEditor,
} from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, $isMermaidNode, MermaidNode } from './MermaidNode'

// Shaped like mermaid@11.16.1's real output: width="100%" + a max-width style +
// a viewBox.
const DIAGRAM_SVG =
  '<svg id="m-1" width="100%" style="max-width: 600px;" viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

const mermaidRender = jest.fn(async () => ({ svg: DIAGRAM_SVG }))

jest.mock('mermaid', () => ({
  __esModule: true,
  default: { initialize: jest.fn(), render: (...args: unknown[]) => mermaidRender(...(args as [])) },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let editor: LexicalEditor | undefined
let mermaidKey = ''
let container: HTMLElement
let root: Root

function CaptureAndSeed() {
  const [composerEditor] = useLexicalComposerContext()
  useEffect(() => {
    editor = composerEditor
    composerEditor.update(
      () => {
        const node = $createMermaidNode('graph TD\n  A --> B')
        const before = $createParagraphNode().append($createTextNode('before the diagram'))
        const after = $createParagraphNode().append($createTextNode('after the diagram'))
        $getRoot().clear().append(before, node, after)
        mermaidKey = node.getKey()
      },
      { discrete: true },
    )
  }, [composerEditor])
  return null
}

function Harness() {
  return createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: 'mermaid-selection',
        nodes: [MermaidNode],
        onError: (error: Error) => {
          throw error
        },
      },
    },
    createElement(RichTextPlugin, {
      contentEditable: createElement(ContentEditable, { 'aria-label': 'editor' }),
      placeholder: null,
      ErrorBoundary: LexicalErrorBoundary,
    }),
    createElement(CaptureAndSeed),
  )
}

beforeEach(async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
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

  // jest.config.js sets `resetMocks: true`, which wipes a jest.fn's
  // IMPLEMENTATION (not just its call history) before every test — including
  // the one given to jest.fn(...) at module scope. Without re-establishing it
  // here, mermaid.render() resolves to undefined from the second test onward,
  // the component lands in its error branch, and the preview (and with it the
  // resize handle) silently disappears.
  mermaidRender.mockImplementation(async () => ({ svg: DIAGRAM_SVG }))

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(Harness))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor = undefined
  mermaidKey = ''
})

const resizeHandle = () => container.querySelector('[data-mermaid-resize-handle="true"]')
const block = () => container.querySelector('[data-mermaid-block="true"]') as HTMLElement

const selectDiagram = () =>
  act(() => {
    editor?.update(
      () => {
        const selection = $createNodeSelection()
        selection.add(mermaidKey)
        $setSelection(selection)
      },
      { discrete: true },
    )
  })

const selectParagraphInstead = () =>
  act(() => {
    editor?.update(
      () => {
        $getRoot().getFirstChild()?.selectEnd()
      },
      { discrete: true },
    )
  })

/** The preview only exists once the debounced mermaid render has resolved. */
const settlePreview = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
}

describe('the Mermaid block really mounts inside a Lexical editor', () => {
  it('renders the block through the editor, not only in isolation', () => {
    expect(block()).not.toBeNull()
    expect(container.textContent).toContain('Mermaid diagram')
    expect(mermaidKey).not.toBe('')
  })
})

/**
 * t119 — the de-duplication, asserted where it has to hold: on a REAL block
 * inside a REAL editor, in BOTH selection states. Checking only the unselected
 * state would pass over a panel that merely became selection-gated, which is
 * exactly the half-measure the user did not ask for.
 */
describe('the chart container offers no configuration surface at all', () => {
  /** Every control the shared panel renders, by the name it is reachable under. */
  const CONFIGURATION_IN_THE_PANEL = [
    '[data-mermaid-settings]',
    '[data-mermaid-width-section="true"]',
    '[role="group"][aria-label="View mode"]',
    '[role="group"][aria-label="Fit mode"]',
    '[role="group"][aria-label="Diagram alignment"]',
    '[aria-label="Maximum diagram height"]',
    '[aria-label="Diagram theme"]',
    '[aria-label="Diagram background"]',
    '[aria-label="Pan and zoom over the diagram"]',
    '[aria-label="Diagram width"]',
  ]

  const expectNoConfiguration = () => {
    for (const selector of CONFIGURATION_IN_THE_PANEL) {
      expect([selector, container.querySelector(selector) === null]).toEqual([selector, true])
    }
  }

  it('renders none of it with the caret in a paragraph', () => {
    expect(block()).not.toBeNull()
    expectNoConfiguration()
  })

  it('renders none of it with the diagram itself selected either', async () => {
    await selectDiagram()
    expect(block()).not.toBeNull()
    expectNoConfiguration()
  })

  it('still renders none of it once the preview has settled', async () => {
    await settlePreview()
    await selectDiagram()
    expect(container.querySelector('[data-mermaid-svg-host="true"] svg')).not.toBeNull()
    expectNoConfiguration()
  })

  /** What the chart DOES keep: its identity and the two source actions. */
  it('keeps its own header — identity, Templates and Reload', () => {
    const topBar = container.querySelector('[data-mermaid-top-bar="true"]')
    expect(topBar).not.toBeNull()
    expect(topBar!.textContent).toContain('Mermaid diagram')
    expect(topBar!.querySelector('select[aria-label="Insert a template diagram"]')).not.toBeNull()
    expect(Array.from(topBar!.querySelectorAll('button')).some((button) => button.textContent === 'Reload')).toBe(true)
  })

  it('keeps the source textarea, so a diagram is still editable in place', () => {
    expect(container.querySelector('textarea[aria-label="Mermaid source"]')).not.toBeNull()
  })
})

describe('the corner drag handle is the one selected-only control left on the chart', () => {
  it('renders no handle over an unselected diagram', async () => {
    await settlePreview()
    expect(container.querySelector('[data-mermaid-svg-host="true"]')).not.toBeNull()
    expect(resizeHandle()).toBeNull()
  })

  it('renders a handle over the selected diagram', async () => {
    await settlePreview()
    // The claim below is only meaningful if the preview actually rendered.
    expect(container.querySelector('[data-mermaid-svg-host="true"] svg')).not.toBeNull()
    await selectDiagram()
    expect(resizeHandle()).not.toBeNull()
  })

  it('takes the handle away again when the selection moves to a paragraph', async () => {
    await settlePreview()
    await selectDiagram()
    expect(resizeHandle()).not.toBeNull()
    await selectParagraphInstead()
    expect(resizeHandle()).toBeNull()
  })

  it('takes it away when the selection is cleared entirely', async () => {
    await settlePreview()
    await selectDiagram()
    await act(() => {
      editor?.update(() => $setSelection(null), { discrete: true })
    })
    expect(resizeHandle()).toBeNull()
  })

  /**
   * It is a corner AFFORDANCE, not a button in a control panel — which is what
   * makes it survivable after the panel was removed, and what the user should be
   * told it is. A `<button>` carrying a visible label would be a fourth control
   * surface by another name.
   */
  it('is an edge affordance — a presentational grab point, not a labelled button', async () => {
    await settlePreview()
    await selectDiagram()
    const handle = resizeHandle() as HTMLElement
    expect(handle).not.toBeNull()
    expect(handle.tagName).toBe('SPAN')
    expect(handle.getAttribute('role')).toBe('presentation')
    expect(handle.querySelector('button')).toBeNull()
    expect(handle.textContent).toBe('')
    expect(handle.style.cursor).toBe('nwse-resize')
  })
})

describe('a click inside the block selects it, which is how the toolbar section is reached', () => {
  const clickOn = async (target: Element | null) =>
    act(async () => {
      const event = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(event, 'target', { value: target, configurable: true })
      editor?.dispatchCommand(CLICK_COMMAND, event)
      // The handler defers setSelected to a macrotask so the nested update does
      // not run inside the command dispatch.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

  /**
   * The handle is the only DOM evidence of the selection left on the chart, and
   * it needs the preview, so every probe below settles it first.
   */
  const selected = () => resizeHandle() !== null

  it('selects the block when CLICK_COMMAND lands inside it', async () => {
    await settlePreview()
    expect(selected()).toBe(false)
    await clickOn(block())
    expect(selected()).toBe(true)
  })

  it('ignores a CLICK_COMMAND that landed outside the block', async () => {
    await settlePreview()
    await clickOn(document.body)
    expect(selected()).toBe(false)
  })

  /**
   * The block still owns real form fields — the source textarea, the Templates
   * select, Reload. Turning a click on one of them into a block selection would
   * move the editor's selection and take back the focus the user just asked for,
   * so those clicks are left alone entirely.
   */
  describe('a click on one of the block’s own controls is left alone', () => {
    it('does not select the block when the mermaid source textarea is clicked', async () => {
      await settlePreview()
      const textarea = container.querySelector('textarea[aria-label="Mermaid source"]')
      expect(textarea).not.toBeNull()
      await clickOn(textarea)
      expect(selected()).toBe(false)
    })

    it('does not select the block when the Templates select is clicked', async () => {
      await settlePreview()
      const select = container.querySelector('select[aria-label="Insert a template diagram"]')
      expect(select).not.toBeNull()
      await clickOn(select)
      expect(selected()).toBe(false)
    })

    it('does not select the block when a header button is clicked', async () => {
      await settlePreview()
      const button = container.querySelector('button')
      expect(button).not.toBeNull()
      await clickOn(button)
      expect(selected()).toBe(false)
    })

    it('keeps the block selected when the Templates select is clicked while selected', async () => {
      await settlePreview()
      await selectDiagram()
      const select = container.querySelector('select[aria-label="Insert a template diagram"]')
      expect(select).not.toBeNull()
      await clickOn(select)
      // Still selected: the click was ignored rather than toggling it off.
      expect(selected()).toBe(true)
    })

    it('does not toggle the selection off when the block is clicked a second time', async () => {
      await settlePreview()
      await clickOn(block())
      expect(selected()).toBe(true)
      await clickOn(block())
      expect(selected()).toBe(true)
    })
  })
})

/**
 * The width FIELD now lives only on the toolbar surface (its field→node half is
 * asserted there, through the real popover). What is unique to this file, and
 * what the removal could still have broken, is the other half: that a width
 * stored on the node reaches the block's own style — so it is driven here
 * through the node's own setter rather than through a control.
 */
describe('a width on the node reaches the DOM, with no control on the chart to set it', () => {
  const setOnNode = async (apply: (node: MermaidNode) => void) => {
    await act(async () => {
      editor?.update(
        () => {
          const node = $getNodeByKey(mermaidKey)
          if ($isMermaidNode(node)) {
            apply(node)
          }
        },
        { discrete: true },
      )
    })
  }

  const commitWidth = (value: string | undefined) => setOnNode((node) => node.setWidth(value))

  it('starts with NO inline width and NO stored width — fitting is the default', () => {
    expect(block().style.width).toBe('')
    // Node getters call getLatest(), which needs an active editor state, so the
    // values must be captured INSIDE the read, not after it returns.
    let isMermaid = false
    let storedWidth: string | undefined
    let storedHeight: number | undefined
    editor?.getEditorState().read(() => {
      const candidate = $getRoot().getChildren()[1]
      isMermaid = candidate instanceof MermaidNode
      if (candidate instanceof MermaidNode) {
        storedWidth = candidate.getWidth()
        storedHeight = candidate.getHeight()
      }
    })
    expect(isMermaid).toBe(true)
    expect(storedWidth).toBeUndefined()
    expect(storedHeight).toBeUndefined()
  })

  it('applies a committed percentage to the block and persists it on the node', async () => {
    await selectDiagram()
    await commitWidth('50%')
    expect(block().style.width).toBe('50%')
    let stored: string | undefined
    editor?.getEditorState().read(() => {
      const node = $getRoot().getChildren()[1]
      stored = node instanceof MermaidNode ? node.getWidth() : 'not-a-mermaid-node'
    })
    expect(stored).toBe('50%')
  })

  it('round-trips that width through exportJSON', async () => {
    await selectDiagram()
    await commitWidth('420px')
    let json: unknown
    editor?.getEditorState().read(() => {
      const node = $getRoot().getChildren()[1]
      json = node instanceof MermaidNode ? node.exportJSON() : null
    })
    expect(json).toMatchObject({ type: 'mermaid', width: '420px' })
  })

  it('never puts a malformed entry into the style attribute', async () => {
    await selectDiagram()
    await commitWidth('50%')
    expect(block().style.width).toBe('50%')
    await commitWidth('javascript:alert(1)')
    // The setter normalizes: junk becomes "no stored width" (the field's own
    // keep-the-last-good-value behaviour is the FIELD's, and lives with it), and
    // either way it never reaches the attribute.
    expect(block().style.width).toBe('')
    expect(block().getAttribute('style')).not.toContain('javascript')
  })

  it('clearing the stored width returns the block to fitting', async () => {
    await selectDiagram()
    await commitWidth('50%')
    expect(block().style.width).toBe('50%')
    await commitWidth(undefined)
    expect(block().style.width).toBe('')
    let stored: string | undefined = 'unset'
    editor?.getEditorState().read(() => {
      const node = $getRoot().getChildren()[1]
      stored = node instanceof MermaidNode ? node.getWidth() : 'not-a-mermaid-node'
    })
    expect(stored).toBeUndefined()
  })

  it('caps a pixel width at 100% of the column so a note can never scroll sideways', async () => {
    await selectDiagram()
    await commitWidth('4000px')
    expect(block().style.width).toBe('4000px')
    expect(block().style.maxWidth).toBe('100%')
  })
})

/**
 * THE SETTINGS STILL DRIVE THE CHART (t119). With the configuration panel gone
 * from the container, every write now arrives from the toolbar — i.e. from
 * OUTSIDE this component, through the node. That makes the node→chart direction
 * the load-bearing one, and it is the direction a removal could silently break:
 * if the chart only ever re-read a setting because its own control re-rendered
 * it, a toolbar-only write would change nothing on screen.
 *
 * So each case below writes the setting on the node, with no control on the
 * chart to click, and asserts the rendered viewport changed.
 */
describe('a setting written on the node still reaches the rendered chart', () => {
  const setOnNode = async (apply: (node: MermaidNode) => void) => {
    await act(async () => {
      editor?.update(
        () => {
          const node = $getNodeByKey(mermaidKey)
          if ($isMermaidNode(node)) {
            apply(node)
          }
        },
        { discrete: true },
      )
    })
  }

  const viewport = () => container.querySelector('[data-mermaid-viewport="true"]')

  it('starts on the defaults the shared module declares', async () => {
    await settlePreview()
    expect(viewport()).not.toBeNull()
    expect(viewport()!.getAttribute('data-mermaid-fit-mode')).toBe('fitWidth')
    let stored = { themeMode: '', maxHeight: undefined as unknown }
    editor?.getEditorState().read(() => {
      const node = $getNodeByKey(mermaidKey)
      if ($isMermaidNode(node)) {
        stored = { themeMode: node.getSettings().themeMode, maxHeight: node.getSettings().maxHeight }
      }
    })
    expect(stored.themeMode).toBe('app')
    expect(stored.maxHeight).toBeUndefined()
  })

  it('a fit mode written on the node lands on the viewport', async () => {
    await settlePreview()
    await setOnNode((node) => node.setSettings({ fitMode: 'actual' }))
    await settlePreview()
    expect(viewport()).not.toBeNull()
    expect(viewport()!.getAttribute('data-mermaid-fit-mode')).toBe('actual')
  })

  it('turning pan/zoom off on the node removes the zoom cluster from the chart', async () => {
    await settlePreview()
    expect(container.querySelector('[data-mermaid-viewport-controls="true"]')).not.toBeNull()
    await setOnNode((node) => node.setSettings({ zoomPan: false }))
    await settlePreview()
    expect(container.querySelector('[data-mermaid-viewport-controls="true"]')).toBeNull()
    expect(viewport()!.getAttribute('data-mermaid-zoom-pan')).toBe('false')
  })

  it('an alignment written on the node lands on the block’s own margins', async () => {
    expect(block().style.marginLeft).toBe('')
    await setOnNode((node) => node.setSettings({ alignment: 'right' }))
    expect(block().style.marginLeft).toBe('auto')
    // jsdom may serialize the zero with or without a unit; what matters is that
    // the right margin did NOT also become auto, which is what centres a block.
    expect(['0', '0px']).toContain(block().style.marginRight)
  })

  it('a view mode written on the node changes which panes the chart shows', async () => {
    expect(container.querySelector('textarea[aria-label="Mermaid source"]')).not.toBeNull()
    await setOnNode((node) => node.setViewMode('preview'))
    expect(container.querySelector('textarea[aria-label="Mermaid source"]')).toBeNull()
    await setOnNode((node) => node.setViewMode('code'))
    expect(container.querySelector('textarea[aria-label="Mermaid source"]')).not.toBeNull()
  })
})
