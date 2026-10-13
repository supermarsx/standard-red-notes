/** @jest-environment jsdom */

/**
 * The Build control on the Mermaid block itself.
 *
 * The visual builder had one way in: click the picture, which selects the
 * block, which makes a "Mermaid" tab appear on the editor toolbar, and press
 * "Builder" there. Nothing on the diagram said it existed, somebody typing the
 * diagram's text never selects the block at all, and a collapsed or floating
 * toolbar hides that tab's commands. The request for "a visual builder" came
 * twice from someone who already had one and could not find it.
 *
 * So this mounts a REAL MermaidNode inside a real Lexical editor, on the model
 * of MermaidNode.selection.spec.tsx, and asserts what a person can see and
 * press with NOTHING selected: the control is there, it is a glyph and a word,
 * it opens the builder on the real node, and it closes it again to wherever it
 * was opened from. And that a note which cannot be edited does not get it.
 *
 * jsdom has no layout, so whether it wraps or clips in a narrow column is a
 * question for a browser; it was looked at there.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  type LexicalEditor,
} from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, $isMermaidNode, MermaidNode } from './MermaidNode'
import { type MermaidViewMode } from './MermaidSettings'

const DIAGRAM_SVG =
  '<svg id="m-1" width="100%" style="max-width: 600px;" viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

const mermaidRender = jest.fn(async () => ({ svg: DIAGRAM_SVG }))

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    mermaidAPI: { reset: () => undefined },
    initialize: jest.fn(),
    render: (...args: unknown[]) => mermaidRender(...(args as [])),
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const FLOWCHART = 'graph TD\n  A --> B'

let editor: LexicalEditor | undefined
let mermaidKey = ''
let container: HTMLElement
let root: Root

function CaptureAndSeed({ source, viewMode }: { source: string; viewMode: MermaidViewMode }) {
  const [composerEditor] = useLexicalComposerContext()
  useEffect(() => {
    editor = composerEditor
    composerEditor.update(
      () => {
        const node = $createMermaidNode(source, 'app', viewMode)
        const before = $createParagraphNode().append($createTextNode('before the diagram'))
        $getRoot().clear().append(before, node)
        mermaidKey = node.getKey()
      },
      { discrete: true },
    )
  }, [composerEditor, source, viewMode])
  return null
}

const mount = async ({
  source = FLOWCHART,
  viewMode = 'split',
  editable = true,
}: { source?: string; viewMode?: MermaidViewMode; editable?: boolean } = {}) => {
  await act(async () => {
    root.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: 'mermaid-build-control',
            nodes: [MermaidNode],
            editable,
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
        createElement(CaptureAndSeed, { source, viewMode }),
      ),
    )
  })
}

beforeEach(() => {
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
  // `resetMocks: true` wipes a jest.fn's implementation before every test.
  mermaidRender.mockImplementation(async () => ({ svg: DIAGRAM_SVG }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor = undefined
  mermaidKey = ''
})

const topBar = () => container.querySelector('[data-mermaid-top-bar="true"]') as HTMLElement
const buildButton = () => container.querySelector('[data-mermaid-build-toggle="true"]') as HTMLButtonElement | null
const builderPane = () => container.querySelector('[data-mermaid-graphical]')
const sourcePane = () => container.querySelector('textarea[aria-label="Mermaid source"]')

const viewModeOfNode = (): MermaidViewMode | undefined => {
  let mode: MermaidViewMode | undefined
  editor?.getEditorState().read(() => {
    const node = $getNodeByKey(mermaidKey)
    mode = $isMermaidNode(node) ? node.getViewMode() : undefined
  })
  return mode
}

const codeOfNode = (): string | undefined => {
  let code: string | undefined
  editor?.getEditorState().read(() => {
    const node = $getNodeByKey(mermaidKey)
    code = $isMermaidNode(node) ? node.getCode() : undefined
  })
  return code
}

const press = async (button: HTMLElement | null) => {
  if (!button) {
    throw new Error('no Build control to press')
  }
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

describe('the Build control is on the diagram itself, with nothing selected', () => {
  it('is in the block’s own header, beside Templates and Reload', async () => {
    await mount()
    const button = buildButton()
    expect(button).not.toBeNull()
    expect(topBar().contains(button)).toBe(true)
    // The header keeps what it had.
    expect(topBar().textContent).toContain('Mermaid diagram')
    expect(topBar().querySelector('select[aria-label="Insert a template diagram"]')).not.toBeNull()
    expect(Array.from(topBar().querySelectorAll('button')).map((candidate) => candidate.textContent)).toEqual([
      'Build',
      'Reload',
    ])
  })

  it('needs no selection at all: the block has never been clicked', async () => {
    await mount()
    let nodeSelected = true
    editor?.getEditorState().read(() => {
      nodeSelected = $isNodeSelection($getSelection())
    })
    expect(nodeSelected).toBe(false)
    expect(buildButton()).not.toBeNull()
  })

  it('draws a glyph and a word, never the icon’s name as text', async () => {
    await mount()
    const button = buildButton() as HTMLButtonElement
    // An icon name that is in neither icon map renders `<label>draw</label>`
    // in place of the glyph; tsc cannot see it.
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.querySelector('label')).toBeNull()
    expect(button.textContent).toBe('Build')
    expect(button.getAttribute('title')).toContain('boxes and links')
  })

  it('says it is off while the diagram’s text is showing', async () => {
    await mount()
    expect(buildButton()?.getAttribute('aria-pressed')).toBe('false')
    expect(builderPane()).toBeNull()
    expect(sourcePane()).not.toBeNull()
  })
})

describe('pressing it opens the existing builder on the real node', () => {
  it('switches the node to the builder, and the builder is then on screen', async () => {
    await mount()
    expect(viewModeOfNode()).toBe('split')
    await press(buildButton())
    // The stored value the toolbar's own Source cluster writes — one setting,
    // reached from two places.
    expect(viewModeOfNode()).toBe('graphical')
    expect(builderPane()).not.toBeNull()
    expect(builderPane()?.getAttribute('data-mermaid-graphical')).toBe('true')
    expect(buildButton()?.getAttribute('aria-pressed')).toBe('true')
    expect(buildButton()?.getAttribute('title')).toContain('go back to the diagram’s text')
  })

  it('changes nothing about the diagram by being opened', async () => {
    await mount()
    await press(buildButton())
    expect(codeOfNode()).toBe(FLOWCHART)
  })

  it('closes again to the text it was opened from', async () => {
    await mount()
    await press(buildButton())
    await press(buildButton())
    expect(viewModeOfNode()).toBe('split')
    expect(builderPane()).toBeNull()
    expect(sourcePane()).not.toBeNull()
    expect(buildButton()?.getAttribute('aria-pressed')).toBe('false')
  })

  it.each(['code', 'preview', 'split'] as MermaidViewMode[])(
    'goes back to %s when that is where it was opened from',
    async (cameFrom) => {
      await mount({ viewMode: cameFrom })
      await press(buildButton())
      expect(viewModeOfNode()).toBe('graphical')
      await press(buildButton())
      expect(viewModeOfNode()).toBe(cameFrom)
    },
  )

  it('goes back to the split view from a diagram that was SAVED in the builder', async () => {
    // Nothing was "before" the builder in this session; the default is the answer.
    await mount({ viewMode: 'graphical' })
    expect(buildButton()?.getAttribute('aria-pressed')).toBe('true')
    await press(buildButton())
    expect(viewModeOfNode()).toBe('split')
  })

  it('follows the toolbar when the toolbar changes the mode instead', async () => {
    await mount()
    await act(async () => {
      editor?.update(() => {
        const node = $getNodeByKey(mermaidKey)
        if ($isMermaidNode(node)) {
          node.setViewMode('graphical')
        }
      })
      await Promise.resolve()
    })
    expect(buildButton()?.getAttribute('aria-pressed')).toBe('true')
    expect(builderPane()).not.toBeNull()
  })

  it('opens the builder on a diagram it cannot model, where the builder itself says so', async () => {
    await mount({ source: 'sequenceDiagram\n  U->>S: Request' })
    await press(buildButton())
    expect(viewModeOfNode()).toBe('graphical')
    // The existing builder's own refusal, not a silent nothing — and the text is
    // exactly what it was.
    expect(builderPane()?.getAttribute('data-mermaid-graphical')).toBe('blocked')
    expect(codeOfNode()).toBe('sequenceDiagram\n  U->>S: Request')
  })
})

describe('it does not disturb the editor’s selection', () => {
  it('is one of the block’s own controls: a click on it does not select the block', async () => {
    await mount()
    const button = buildButton() as HTMLButtonElement
    await act(async () => {
      const event = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(event, 'target', { value: button, configurable: true })
      editor?.dispatchCommand(CLICK_COMMAND, event)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    let nodeSelected = true
    editor?.getEditorState().read(() => {
      nodeSelected = $isNodeSelection($getSelection())
    })
    expect(nodeSelected).toBe(false)
  })
})

describe('a note that cannot be edited', () => {
  it('does not offer it: the builder is an editing surface, and the button writes to the note', async () => {
    await mount({ editable: false })
    expect(topBar()).not.toBeNull()
    expect(buildButton()).toBeNull()
    // The diagram and the rest of its header are still there.
    expect(topBar().textContent).toContain('Mermaid diagram')
    expect(Array.from(topBar().querySelectorAll('button')).map((candidate) => candidate.textContent)).toEqual([
      'Reload',
    ])
  })

  it('takes it away when a note is locked while open, and gives it back when unlocked', async () => {
    await mount()
    expect(buildButton()).not.toBeNull()
    await act(async () => {
      editor?.setEditable(false)
      await Promise.resolve()
    })
    expect(buildButton()).toBeNull()
    await act(async () => {
      editor?.setEditable(true)
      await Promise.resolve()
    })
    expect(buildButton()).not.toBeNull()
  })
})
