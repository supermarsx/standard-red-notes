/** @jest-environment jsdom */

/**
 * THE VISUAL BUILDER, asserted where it has to hold: a REAL LexicalComposer
 * containing a REAL MermaidNode in `graphical` view mode, driven through the
 * DOM, with the node's own source read back out of the editor afterwards.
 *
 * Why not the pure logic alone: `MermaidGraphBuilder.spec.ts` can be entirely
 * green while this pane renders nothing at all. It has happened on this toolbar
 * twice, and the defect this file was written for is the same family — the
 * `graphical` mode rendered a form with NO diagram beside it, so "building a
 * chart visually" showed the user no chart. tsc cannot see that, and neither can
 * a test that only checks a component mounted.
 *
 * So every assertion here is on rendered DOM or on the node's committed source:
 *
 *   1. the builder AND the live diagram are both on screen in `graphical` mode;
 *   2. each visual action writes the source it claims to;
 *   3. a hand-written source survives a visual edit — comments, shapes, styling;
 *   4. a diagram the builder cannot model gets NO editing control whatsoever,
 *      and cannot be destroyed without an explicit confirmation;
 *   5. the round trip runs the OTHER way too — a source edit reaches the form.
 *
 * jsdom has no layout engine, so nothing here asserts geometry.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $getNodeByKey, $getRoot, type LexicalEditor } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, $isMermaidNode, MermaidNode } from './MermaidNode'
import { MERMAID_NODE_SHAPES, MERMAID_EDGE_KINDS, MERMAID_NODE_SHAPE_LABELS } from './MermaidGraphBuilder'

/** Real newlines in fixture sources, built rather than escaped. */
const src = (...lines: string[]): string => lines.join('\n')

/**
 * Carries a marker id nothing else in the tree can own, so "the diagram is on
 * screen" cannot be satisfied by one of the pane's own `Icon` glyphs — which are
 * `<svg>` elements too, and which made a naive `querySelector('svg')` probe
 * report a preview that was never rendered.
 */
const DIAGRAM_SVG =
  '<svg id="srn-rendered-diagram" width="100%" style="max-width: 600px;" viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

// Typed with its real arguments (`id`, `source`), so the assertion that the
// diagram rendered is the diagram the node HOLDS can read the second one.
const mermaidRender = jest.fn(async (..._args: unknown[]) => ({ svg: DIAGRAM_SVG }))
const mermaidInitialize = jest.fn()

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    initialize: (...args: unknown[]) => mermaidInitialize(...(args as [])),
    render: (...args: unknown[]) => mermaidRender(...(args as [])),
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let editor: LexicalEditor | undefined
let mermaidKey = ''
let container: HTMLElement
let root: Root
let seedSource = ''

function CaptureAndSeed() {
  const [composerEditor] = useLexicalComposerContext()
  useEffect(() => {
    editor = composerEditor
    composerEditor.update(
      () => {
        const node = $createMermaidNode(seedSource, 'app', 'graphical')
        $getRoot().clear().append(node)
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
        namespace: 'mermaid-visual-builder',
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

/** Mounts the editor on a given source. Each test states the diagram it is about. */
const mountWith = async (source: string) => {
  seedSource = source
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  await act(async () => {
    await Promise.resolve()
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
  // jest.config.js sets `resetMocks: true`, which wipes a jest.fn's
  // IMPLEMENTATION before every test. Without this the render resolves to
  // undefined from the second test on, the component lands in its error branch,
  // and the preview silently disappears — which is exactly what this file
  // exists to catch, so it must not be caused here.
  mermaidRender.mockImplementation(async () => ({ svg: DIAGRAM_SVG }))
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  editor = undefined
  mermaidKey = ''
})

/** The source the NODE now holds — not the form's local draft. */
const committedSource = (): string => {
  let source = ''
  editor?.getEditorState().read(() => {
    const node = $getNodeByKey(mermaidKey)
    if ($isMermaidNode(node)) {
      source = node.getCode()
    }
  })
  return source
}

const builder = () => container.querySelector('[data-mermaid-graphical="true"]')
const blockedBuilder = () => container.querySelector('[data-mermaid-graphical="blocked"]')
const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`)
const buttonSaying = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((candidate) => (candidate.textContent ?? '').includes(text))

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

/**
 * Changes a select the way a user does. React's value tracker treats a direct
 * `.value` write as its own, so the change event is dropped and `onChange` never
 * fires — a silent false green.
 */
const choose = async (element: Element | null, value: string) => {
  expect(element).not.toBeNull()
  const select = element as HTMLSelectElement
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (!setter) {
    throw new Error('no native value setter on HTMLSelectElement — the probe would be unfailable')
  }
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

const typeInto = async (element: Element | null, value: string) => {
  expect(element).not.toBeNull()
  const field = element as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) {
    throw new Error('no native value setter on HTMLInputElement — the probe would be unfailable')
  }
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

/** The preview only exists once the debounced mermaid render has resolved. */
const settlePreview = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
}

describe('the visual builder puts both halves on screen', () => {
  /**
   * THE defect. `graphical` was the one view mode with no preview branch at all,
   * so the pane that exists to build a chart visually showed no chart. A test
   * that the component mounted would have passed throughout.
   */
  it('shows the builder AND the live diagram beside it', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B'))
    await settlePreview()

    expect(builder()).not.toBeNull()
    expect(container.querySelector('[data-mermaid-viewport="true"]')).not.toBeNull()
    expect(container.querySelector('#srn-rendered-diagram')).not.toBeNull()
    // And the diagram that was rendered is the diagram the node holds.
    expect(mermaidRender).toHaveBeenCalled()
    expect(String(mermaidRender.mock.calls[mermaidRender.mock.calls.length - 1][1])).toContain('A --> B')
  })

  it('offers every editing control the form claims to have', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B'))
    for (const label of [
      'Flowchart direction',
      'Node 1 id',
      'Node 1 label',
      'Node 1 shape',
      'Remove node 1',
      'Edge 1 from',
      'Edge 1 style',
      'Edge 1 to',
      'Edge 1 label',
      'Remove edge 1',
    ]) {
      expect([label, byLabel(label) !== null]).toEqual([label, true])
    }
    expect(buttonSaying('Add node')).toBeTruthy()
    expect(buttonSaying('Add link')).toBeTruthy()
  })

  /**
   * An unmapped `Icon type` falls through to a `<label>` holding its own NAME as
   * literal text, and both tsc (the prop admits any string) and an Icon-mocking
   * spec are blind to it. So the probe is the fallthrough itself: no label in
   * this pane may hold a glyph name, and the glyphs that should be here have to
   * have resolved to real `<svg>` elements.
   *
   * Searching the pane's TEXT for the names would be wrong in both directions —
   * "link" is this pane's own word for an edge, so it is present legitimately,
   * and the fallthrough label is what actually proves the miss.
   */
  it('resolves every glyph it renders, with no icon name falling through as text', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B'))
    const labelTexts = Array.from(container.querySelectorAll('label')).map((label) => label.textContent)
    for (const iconName of ['close', 'warning', 'add', 'link', 'arrow-right', 'tune']) {
      expect([iconName, labelTexts.includes(iconName)]).toEqual([iconName, false])
    }
    // Two remove buttons (one node, one edge... two nodes and one edge here), so
    // every one of them resolved to a glyph rather than a label.
    const removeButtons = Array.from(container.querySelectorAll('button[aria-label^="Remove "]'))
    expect(removeButtons.length).toBe(3)
    for (const button of removeButtons) {
      expect([button.getAttribute('aria-label'), button.querySelector('svg') !== null]).toEqual([
        button.getAttribute('aria-label'),
        true,
      ])
      expect(button.textContent).toBe('')
    }
  })

  it('resolves the warning glyph on the blocked state too', async () => {
    await mountWith(src('sequenceDiagram', '  U->>S: Request'))
    const banner = container.querySelector('[data-mermaid-graphical="blocked"]')
    expect(banner).not.toBeNull()
    expect(banner!.querySelector('svg')).not.toBeNull()
    expect(Array.from(banner!.querySelectorAll('label')).map((label) => label.textContent)).not.toContain('warning')
  })
})

describe('each visual action writes the source it claims to', () => {
  it('adds a node', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    await click(buttonSaying('Add node'))
    expect(committedSource()).toBe(src('graph TD', '  A["Start"]', '  B["B"]'))
    // And the new row is on screen, so the form reflects what it wrote.
    expect(byLabel('Node 2 id')).not.toBeNull()
  })

  it('adds a link between the two most recent nodes', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]'))
    await click(buttonSaying('Add link'))
    expect(committedSource()).toContain('A --> B')
    expect(byLabel('Edge 1 from')).not.toBeNull()
  })

  it('changes a node label', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    await typeInto(byLabel('Node 1 label'), 'Kick off')
    expect(committedSource()).toContain('A["Kick off"]')
  })

  it('changes a node shape to each modelled shape', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    for (const shape of MERMAID_NODE_SHAPES) {
      await choose(byLabel('Node 1 shape'), shape)
      expect([shape, (byLabel('Node 1 shape') as HTMLSelectElement).value]).toEqual([shape, shape])
    }
    // The last one chosen is in the source, in mermaid's own delimiters.
    await choose(byLabel('Node 1 shape'), 'rhombus')
    expect(committedSource()).toContain('A{"Start"}')
  })

  it('changes a link style to each modelled kind', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B'))
    const connectors: Record<string, string> = { arrow: '-->', open: '---', dotted: '-.->', thick: '==>' }
    for (const kind of MERMAID_EDGE_KINDS) {
      await choose(byLabel('Edge 1 style'), kind)
      expect([kind, committedSource().includes(`A ${connectors[kind]} B`)]).toEqual([kind, true])
    }
  })

  it('changes the direction', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    await choose(byLabel('Flowchart direction'), 'LR')
    expect(committedSource().split('\n')[0]).toBe('graph LR')
  })

  it('removes a node and the links that touched it', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B'))
    await click(byLabel('Remove node 1'))
    const source = committedSource()
    expect(source).not.toContain('A["Start"]')
    expect(source).not.toContain('-->')
    expect(source).toContain('B["End"]')
  })

  it('removes a link without touching its nodes', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B'))
    await click(byLabel('Remove edge 1'))
    const source = committedSource()
    expect(source).toContain('A["Start"]')
    expect(source).toContain('B["End"]')
    expect(source).not.toContain('-->')
  })

  /**
   * Renaming a node used to leave its links pointing at an id that no longer
   * existed, and generation drops unknown links — so correcting a name DELETED
   * the connections, on screen, with nothing to say so.
   */
  it('keeps a link when its node is renamed', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A -->|go| B'))
    await typeInto(byLabel('Node 1 id'), 'Kickoff')
    const source = committedSource()
    expect(source).toContain('Kickoff["Start"]')
    expect(source).toContain('Kickoff -->|go| B')
  })
})

describe('a visual edit never silently destroys hand-written source', () => {
  /**
   * The reported case, end to end. Before this work, ONE click on "Add node"
   * over this exact source produced
   *   graph TD / A["Start"] / B["Decide"] / C["C"] / A --> B
   * — the comment gone, the decision rhombus flattened to a box, and no warning
   * anywhere, because the parse had "succeeded".
   */
  it('keeps a comment and a decision shape through an Add node', async () => {
    await mountWith(src('%% quarterly plan — do not delete', 'graph TD', '  A["Start"]', '  B{"Decide"}', '  A --> B'))
    await click(buttonSaying('Add node'))
    const source = committedSource()
    expect(source).toContain('%% quarterly plan — do not delete')
    expect(source).toContain('B{"Decide"}')
    expect(source).toContain('C["C"]')
    expect(source).toContain('A --> B')
  })

  it('keeps YAML frontmatter through a visual edit', async () => {
    await mountWith(src('---', 'title: Release flow', '---', 'graph TD', '  A["Start"]'))
    await click(buttonSaying('Add node'))
    expect(committedSource().startsWith(src('---', 'title: Release flow', '---', 'graph TD'))).toBe(true)
  })

  it('keeps styling statements, and SHOWS the user what it is keeping', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B', 'classDef hot fill:#f99', 'class A hot'))
    const preserved = container.querySelector('[data-mermaid-preserved="true"]')
    expect(preserved).not.toBeNull()
    expect(preserved!.textContent).toContain('classDef hot fill:#f99')
    expect(preserved!.textContent).toContain('class A hot')

    await click(buttonSaying('Add node'))
    const source = committedSource()
    expect(source).toContain('classDef hot fill:#f99')
    expect(source).toContain('class A hot')
  })

  it('says so when a preserved line is left pointing at a node that is gone', async () => {
    await mountWith(src('graph TD', '  A["Start"]', '  B["End"]', '  A --> B', 'class A hot'))
    expect(container.querySelector('[data-mermaid-dangling="true"]')).toBeNull()
    await click(byLabel('Remove node 1'))
    expect(container.querySelector('[data-mermaid-dangling="true"]')).not.toBeNull()
    // Reported, never rewritten.
    expect(committedSource()).toContain('class A hot')
  })
})

describe('what the builder cannot model, it refuses to touch', () => {
  const SEQUENCE = src('sequenceDiagram', '  participant U as User', '  participant S as Server', '  U->>S: Request')

  it('renders no editing control at all over a sequence diagram', async () => {
    await mountWith(SEQUENCE)
    expect(builder()).toBeNull()
    expect(blockedBuilder()).not.toBeNull()
    // Not one control that could write the source exists in this state. The
    // builder used to render the full form seeded from an EMPTY model, so one
    // click replaced the whole diagram.
    expect(buttonSaying('Add node')).toBeUndefined()
    expect(buttonSaying('Add link')).toBeUndefined()
    expect(byLabel('Flowchart direction')).toBeNull()
    expect(byLabel('Node 1 id')).toBeNull()
  })

  it('names the diagram type and what it supports, in the UI', async () => {
    await mountWith(SEQUENCE)
    const text = blockedBuilder()!.textContent ?? ''
    expect(text).toContain('sequence diagram')
    expect(text).toContain('flowchart')
    const blockers = container.querySelector('[data-mermaid-blockers="true"]')
    expect(blockers!.textContent).toContain('the builder models flowcharts')
  })

  it('names the blocking LINE for a flowchart it cannot fully read', async () => {
    await mountWith(src('graph TD', '  subgraph Backend', '    A --> B', '  end'))
    expect(blockedBuilder()).not.toBeNull()
    const blockers = container.querySelector('[data-mermaid-blockers="true"]')
    expect(blockers!.textContent).toContain('line 2')
    expect(blockers!.textContent).toContain('subgraph')
  })

  it('cannot replace the diagram without an explicit confirmation', async () => {
    await mountWith(SEQUENCE)
    await click(buttonSaying('Replace it with a new flowchart'))
    // Step one changes NOTHING. It only asks.
    expect(committedSource()).toBe(SEQUENCE)
    expect(container.textContent).toContain('discards the current source')

    // And the way out is offered beside the way through.
    await click(buttonSaying('Keep my diagram'))
    expect(committedSource()).toBe(SEQUENCE)
    expect(blockedBuilder()).not.toBeNull()
  })

  it('replaces only on the confirmed second action', async () => {
    await mountWith(SEQUENCE)
    await click(buttonSaying('Replace it with a new flowchart'))
    await click(buttonSaying('Discard and start a flowchart'))
    expect(committedSource()).toBe(src('graph TD', '  A["A"]'))
    // And the form is now live on the new flowchart.
    expect(builder()).not.toBeNull()
    expect(byLabel('Node 1 id')).not.toBeNull()
  })

  it('still renders the diagram beside the refusal, so the user can see it', async () => {
    await mountWith(SEQUENCE)
    await settlePreview()
    expect(container.querySelector('#srn-rendered-diagram')).not.toBeNull()
  })
})

describe('the round trip runs both ways', () => {
  it('reflects a source edit made outside the builder', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    expect(byLabel('Node 2 id')).toBeNull()

    await act(async () => {
      editor?.update(
        () => {
          const node = $getNodeByKey(mermaidKey)
          if ($isMermaidNode(node)) {
            node.setCode(src('graph LR', '  A["Start"]', '  Z{"Ship?"}', '  A -.->|maybe| Z'))
          }
        },
        { discrete: true },
      )
      await Promise.resolve()
    })

    expect((byLabel('Flowchart direction') as HTMLSelectElement).value).toBe('LR')
    expect((byLabel('Node 2 id') as HTMLInputElement).value).toBe('Z')
    expect((byLabel('Node 2 label') as HTMLInputElement).value).toBe('Ship?')
    expect((byLabel('Node 2 shape') as HTMLSelectElement).value).toBe('rhombus')
    expect((byLabel('Edge 1 style') as HTMLSelectElement).value).toBe('dotted')
    expect((byLabel('Edge 1 label') as HTMLInputElement).value).toBe('maybe')
  })

  it('blocks when a source edit turns the diagram into one it cannot model', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    expect(builder()).not.toBeNull()
    await act(async () => {
      editor?.update(
        () => {
          const node = $getNodeByKey(mermaidKey)
          if ($isMermaidNode(node)) {
            node.setCode(src('gantt', '  title Roadmap'))
          }
        },
        { discrete: true },
      )
      await Promise.resolve()
    })
    expect(builder()).toBeNull()
    expect(blockedBuilder()!.textContent).toContain('Gantt chart')
  })

  it('names every modelled shape in the picker, from the shared list', async () => {
    await mountWith(src('graph TD', '  A["Start"]'))
    const options = Array.from((byLabel('Node 1 shape') as HTMLSelectElement).options)
    expect(options.map((option) => option.value)).toEqual([...MERMAID_NODE_SHAPES])
    expect(options.map((option) => option.textContent)).toEqual(
      MERMAID_NODE_SHAPES.map((shape) => MERMAID_NODE_SHAPE_LABELS[shape]),
    )
  })
})
