/** @jest-environment jsdom */

/**
 * The half that would otherwise rot silently: that the Mermaid block's size
 * controls are actually ON SCREEN, and only while the block is the real Lexical
 * selection.
 *
 * MermaidBlockControls.spec.tsx drives the section's `visible` prop directly,
 * which proves the component's own branch and nothing about whether anything
 * ever sets it. `ToolbarPlugin.checklistGroup.spec.tsx:1-18` records a control
 * vanishing from the UI three times with green types and green unit tests, so
 * this file mounts a REAL LexicalComposer containing a REAL MermaidNode, moves
 * the real selection onto and off the node, and asserts the section appears and
 * disappears with it.
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
  $getRoot,
  $setSelection,
  CLICK_COMMAND,
  type LexicalEditor,
} from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, MermaidNode } from './MermaidNode'

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

const widthSection = () => container.querySelector('[data-mermaid-width-section="true"]')
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

describe('size controls appear only while the block is the real Lexical selection', () => {
  it('shows no width section with the caret in a paragraph', () => {
    expect(widthSection()).toBeNull()
  })

  it('shows the width section once the node itself is selected', async () => {
    await selectDiagram()
    expect(widthSection()).not.toBeNull()
    expect(container.querySelector('input[aria-label="Diagram width"]')).not.toBeNull()
  })

  it('hides it again when the selection moves to a paragraph', async () => {
    await selectDiagram()
    expect(widthSection()).not.toBeNull()
    await selectParagraphInstead()
    expect(widthSection()).toBeNull()
  })

  it('hides it when the selection is cleared entirely', async () => {
    await selectDiagram()
    await act(() => {
      editor?.update(() => $setSelection(null), { discrete: true })
    })
    expect(widthSection()).toBeNull()
  })

  const clickOn = async (target: Element | null) =>
    act(async () => {
      const event = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(event, 'target', { value: target, configurable: true })
      editor?.dispatchCommand(CLICK_COMMAND, event)
      // The handler defers setSelected to a macrotask so the nested update does
      // not run inside the command dispatch.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

  it('selects the block when CLICK_COMMAND lands inside it, which is how a user gets the controls', async () => {
    expect(widthSection()).toBeNull()
    await clickOn(block())
    expect(widthSection()).not.toBeNull()
  })

  it('ignores a CLICK_COMMAND that landed outside the block', async () => {
    await clickOn(document.body)
    expect(widthSection()).toBeNull()
  })

  /**
   * The block is full of real form fields. Turning a click on one of them into
   * a block selection would move the editor's selection and take back the focus
   * the user just asked for, so those clicks are left alone entirely.
   */
  describe('a click on one of the block’s own controls is left alone', () => {
    it('does not select the block when the mermaid source textarea is clicked', async () => {
      const textarea = container.querySelector('textarea[aria-label="Mermaid source"]')
      expect(textarea).not.toBeNull()
      await clickOn(textarea)
      expect(widthSection()).toBeNull()
    })

    it('does not select the block when the theme select is clicked', async () => {
      const select = container.querySelector('select[aria-label="Diagram theme"]')
      expect(select).not.toBeNull()
      await clickOn(select)
      expect(widthSection()).toBeNull()
    })

    it('does not select the block when a header button is clicked', async () => {
      const button = container.querySelector('button')
      expect(button).not.toBeNull()
      await clickOn(button)
      expect(widthSection()).toBeNull()
    })

    it('keeps the block selected when the width field itself is clicked', async () => {
      await selectDiagram()
      const field = container.querySelector('input[aria-label="Diagram width"]')
      expect(field).not.toBeNull()
      await clickOn(field)
      // Still selected: the click was ignored rather than toggling it off.
      expect(widthSection()).not.toBeNull()
    })

    it('does not toggle the selection off when the block is clicked a second time', async () => {
      await clickOn(block())
      expect(widthSection()).not.toBeNull()
      await clickOn(block())
      expect(widthSection()).not.toBeNull()
    })
  })
})

describe('the resize handle is gated on the same selection', () => {
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
})

describe('a width typed into the section reaches the node and the DOM', () => {
  const commitWidth = async (value: string) => {
    const input = container.querySelector('input[aria-label="Diagram width"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

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
    // Still the last good value — the junk reached neither the node nor the DOM.
    expect(block().style.width).toBe('50%')
    expect(block().getAttribute('style')).not.toContain('javascript')
  })

  it('clearing the field returns the block to fitting', async () => {
    await selectDiagram()
    await commitWidth('50%')
    expect(block().style.width).toBe('50%')
    await commitWidth('')
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
