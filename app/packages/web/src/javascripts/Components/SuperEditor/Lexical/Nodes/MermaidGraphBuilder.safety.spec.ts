/**
 * @jest-environment node
 *
 * The visual builder regenerates a diagram's source from its own model, so
 * anything it MISREADS is rewritten wrong the next time anything is touched.
 * Each case below changed a diagram's meaning with no edit asked for and
 * nothing said, and each was reproduced in the running app (container build,
 * stock Firefox 157, real pointer and key input) before it was fixed here:
 *
 *   `A[/Input/] --> B[\Output\]`     slanted boxes became rectangles with slashes in their text
 *   `A(((Stop)))`                    a double circle became a circle labelled "(Stop)"
 *   `A[Start]` … `A[Renamed later]`  the label went back to "Start"
 *   renaming B to `A2` beside an A   `A --> B`, `C --> A` became `A2 --> A2`, `C --> A2`
 *   removing a link above a numbered `linkStyle`   mermaid stopped drawing the diagram at all
 *
 * What a source MEANS is mermaid's to say, and `scripts/MermaidContract.mjs`
 * asks the real parser, before and after a round trip, for every source in its
 * corpus. This file pins the builder's own decisions: what it refuses and in
 * what words, and what its operations write.
 */
import {
  analyzeMermaidSource,
  buildFlowchartSource,
  commitGraphNodeId,
  MERMAID_TEMPLATES,
  type MermaidGraphModel,
  removeGraphEdge,
  removeGraphNode,
  templateReplacesUserWork,
} from './MermaidGraphBuilder'

const src = (...lines: string[]): string => lines.join('\n')
const BACKSLASH = String.fromCharCode(92)

const modelOf = (source: string): MermaidGraphModel => {
  const { model, blockers } = analyzeMermaidSource(source)
  if (!model) {
    throw new Error('the builder refused a source this test needs it to model: ' + blockers.join(' | '))
  }
  return model
}

describe('a shape the builder does not model is refused, not redrawn as a box', () => {
  const REFUSED: [string, string, string][] = [
    ['a parallelogram', `A[/Input/] --> B`, 'a slanted box or trapezoid'],
    ['the other parallelogram', `A[${BACKSLASH}Output${BACKSLASH}] --> B`, 'a slanted box or trapezoid'],
    ['a trapezoid', `A[/Trap${BACKSLASH}] --> B`, 'a slanted box or trapezoid'],
    ['the other trapezoid', `A[${BACKSLASH}Trap/] --> B`, 'a slanted box or trapezoid'],
    ['a double circle', 'A(((Stop))) --> B', 'a double circle'],
    ['an ellipse', 'A(-Oval-) --> B', 'an ellipse'],
    ['a box with properties', 'A[|borders:lt|Text] --> B', 'a box with properties'],
    ['a flag', 'A>Flag] --> B', 'a flag-shaped box'],
  ]

  it.each(REFUSED)('%s, on the left of a link', (_name, line, shape) => {
    const analysis = analyzeMermaidSource(src('flowchart LR', '  ' + line))
    expect(analysis.model).toBeNull()
    expect(analysis.blockers).toEqual([
      `line 2: node A is ${shape}, a shape the builder does not model — it would be redrawn as a plain box`,
    ])
  })

  it.each(REFUSED)('%s, on the right of a link', (_name, line, shape) => {
    const mirrored = 'B --> ' + line.replace(' --> B', '')
    const analysis = analyzeMermaidSource(src('flowchart LR', '  ' + mirrored))
    expect(analysis.model).toBeNull()
    expect(analysis.blockers[0]).toContain(`node A is ${shape}`)
  })

  it.each(REFUSED)('%s, declared on a line of its own', (_name, line, shape) => {
    const analysis = analyzeMermaidSource(src('flowchart LR', '  ' + line.replace(' --> B', ''), '  A --> B'))
    expect(analysis.model).toBeNull()
    expect(analysis.blockers[0]).toContain(`line 2: node A is ${shape}`)
  })

  it('names both nodes when both ends of a link are refused', () => {
    const analysis = analyzeMermaidSource(src('flowchart TD', `  A[/Input/] --> B[${BACKSLASH}Output${BACKSLASH}]`))
    expect(analysis.blockers).toHaveLength(2)
    expect(analysis.blockers[0]).toContain('node A')
    expect(analysis.blockers[1]).toContain('node B')
  })

  it('still models a QUOTED label that merely starts like one of them', () => {
    // `["` opens a box and nothing else — and it is the form the builder writes.
    const model = modelOf(
      src(
        'flowchart LR',
        '  A["/path/to/file/"] --> B["(optional)"]',
        '  C(("(c)")) --> D("-dashed-")',
        '  E[">= 3"] --> F["|x|"]',
      ),
    )
    expect(model.nodes.map((node) => [node.id, node.shape, node.label])).toEqual([
      ['A', 'rect', '/path/to/file/'],
      ['B', 'rect', '(optional)'],
      ['C', 'circle', '(c)'],
      ['D', 'round', '-dashed-'],
      ['E', 'rect', '>= 3'],
      ['F', 'rect', '|x|'],
    ])
  })

  it('still models every shape it always did', () => {
    const model = modelOf(
      src(
        'flowchart LR',
        '  A[Box] --> B(Round)',
        '  C([Pill]) --> D[[Sub]]',
        '  E[(Db)] --> F((Circle))',
        '  G{Ask} --> H{{Hex}}',
      ),
    )
    expect(model.nodes.map((node) => node.shape)).toEqual([
      'rect',
      'round',
      'stadium',
      'subroutine',
      'cylinder',
      'circle',
      'rhombus',
      'hexagon',
    ])
  })
})

describe('the last thing a source says about a node wins, as it does in mermaid', () => {
  it('takes the later label', () => {
    const model = modelOf(src('flowchart LR', '  A[Start] --> B', '  A[Renamed later]'))
    expect(model.nodes[0]).toEqual({ id: 'A', label: 'Renamed later', shape: 'rect' })
    expect(buildFlowchartSource(model)).toContain('A["Renamed later"]')
  })

  it('takes the later shape with it, even back to a plain box', () => {
    const model = modelOf(src('flowchart LR', '  A(Round) --> B', '  A[Box later]'))
    expect(model.nodes[0]).toEqual({ id: 'A', label: 'Box later', shape: 'rect' })
  })

  it('takes the later of two declarations of the same shape family', () => {
    const model = modelOf(src('flowchart LR', '  A[x]', '  A --> B', '  B{y}', '  B{{z}}'))
    expect(model.nodes[1]).toEqual({ id: 'B', label: 'z', shape: 'hexagon' })
  })

  it('is left alone by a bare reference, before or after', () => {
    const model = modelOf(src('flowchart LR', '  A --> B', '  A[Start]', '  A --> C', '  A'))
    expect(model.nodes[0]).toEqual({ id: 'A', label: 'Start', shape: 'rect' })
  })
})

describe('a numbered linkStyle moves with the link it names', () => {
  const STYLED = src(
    'flowchart LR',
    '  A --> B',
    '  B --> C',
    '  C --> D',
    '  linkStyle 1 stroke:#f00',
    '  linkStyle 0,2 stroke-width:4px',
  )

  it('drops by one when an earlier link is removed, and leaves a list without the removed one', () => {
    const next = removeGraphEdge(modelOf(STYLED), 0)
    expect(next.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['B>C', 'C>D'])
    expect(next.extras).toEqual(['  linkStyle 0 stroke:#f00', '  linkStyle 1 stroke-width:4px'])
  })

  it('stays put when a later link is removed', () => {
    const next = removeGraphEdge(modelOf(STYLED), 2)
    expect(next.extras).toEqual(['  linkStyle 1 stroke:#f00', '  linkStyle 0 stroke-width:4px'])
  })

  it('goes with the link when that link is all it styled', () => {
    const next = removeGraphEdge(modelOf(STYLED), 1)
    expect(next.extras).toEqual(['  linkStyle 0,1 stroke-width:4px'])
  })

  it('never names a link that is not there afterwards', () => {
    const model = modelOf(STYLED)
    for (let index = 0; index < model.edges.length; index++) {
      const next = removeGraphEdge(model, index)
      const named = (next.extras ?? []).flatMap((line) =>
        (/linkStyle\s+([\d,]+)/.exec(line)?.[1] ?? '').split(',').map(Number),
      )
      expect(named.every((position) => position >= 0 && position < next.edges.length)).toBe(true)
    }
  })

  it('touches nothing but the numbers', () => {
    const model = modelOf(
      src(
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  linkStyle 1 interpolate basis stroke:#f00,stroke-width:2px',
        '  linkStyle default stroke:#333',
        '  class A hot',
        '  %% a comment',
      ),
    )
    expect(removeGraphEdge(model, 0).extras).toEqual([
      '  linkStyle 0 interpolate basis stroke:#f00,stroke-width:2px',
      '  linkStyle default stroke:#333',
      '  class A hot',
      '  %% a comment',
    ])
  })

  it('is a no-op for a link that is not there', () => {
    const model = modelOf(STYLED)
    expect(removeGraphEdge(model, 7)).toBe(model)
    expect(removeGraphEdge(model, -1)).toBe(model)
  })

  it('is renumbered once per link a removed NODE takes with it', () => {
    // B touches links 0 and 1; the styled link C --> D moves from 2 to 0.
    const model = modelOf(
      src(
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  C --> D',
        '  linkStyle 2 stroke:#f00',
        '  linkStyle 0 stroke:#00f',
      ),
    )
    const next = removeGraphNode(model, 1)
    expect(next.nodes.map((node) => node.id)).toEqual(['A', 'C', 'D'])
    expect(next.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['C>D'])
    expect(next.extras).toEqual(['  linkStyle 0 stroke:#f00'])
  })

  it('blocks the builder on a linkStyle it could not keep in step', () => {
    // A space inside the list: mermaid itself rejects it, and the builder must
    // not carry a statement it cannot renumber.
    const analysis = analyzeMermaidSource(src('flowchart LR', '  A --> B', '  B --> C', '  linkStyle 0, 1 stroke:#f00'))
    expect(analysis.model).toBeNull()
    expect(analysis.blockers).toEqual([
      'line 4: a linkStyle the builder cannot keep in step with its links: linkStyle 0, 1 stroke:#f00',
    ])
  })
})

describe('committing a typed node id', () => {
  const model = modelOf(src('graph TD', '  A["Start"]', '  B["End"]', '  C["Other"]', '  A --> B', '  C --> A'))

  it('renames the node and every link that named it', () => {
    const outcome = commitGraphNodeId(model, 1, 'A2')
    expect(outcome.refusal).toBeNull()
    expect(buildFlowchartSource(outcome.model)).toBe(
      src('graph TD', '  A["Start"]', '  A2["End"]', '  C["Other"]', '  A --> A2', '  C --> A'),
    )
  })

  it('refuses an id another node has, and changes nothing', () => {
    const outcome = commitGraphNodeId(model, 1, 'A')
    expect(outcome.model).toBe(model)
    expect(outcome.refusal).toBe(
      'Another node is already called A, and two nodes with one id are one node. This one is still B.',
    )
  })

  it('compares ids as they will be written', () => {
    const hyphenated = modelOf(src('graph TD', '  a_b["One"]', '  B["Two"]', '  a_b --> B'))
    expect(commitGraphNodeId(hyphenated, 1, 'a-b').refusal).toContain('already called a_b')
    expect(commitGraphNodeId(hyphenated, 1, ' a b ').refusal).toContain('already called a_b')
  })

  it.each(['', '   ', '\t'])('refuses the empty id %j', (typed) => {
    const outcome = commitGraphNodeId(model, 2, typed)
    expect(outcome.model).toBe(model)
    expect(outcome.refusal).toBe('A node needs an id, so this one is still C.')
  })

  it('writes the sanitised id', () => {
    const outcome = commitGraphNodeId(model, 1, 'my node')
    expect(outcome.refusal).toBeNull()
    expect(outcome.model.nodes[1].id).toBe('my_node')
    expect(outcome.model.edges[0]).toMatchObject({ from: 'A', to: 'my_node' })
  })

  it('is a no-op, not a refusal, for the id the node already has', () => {
    expect(commitGraphNodeId(model, 1, 'B')).toEqual({ model, refusal: null })
    expect(commitGraphNodeId(model, 1, ' B ')).toEqual({ model, refusal: null })
    expect(commitGraphNodeId(model, 9, 'Z')).toEqual({ model, refusal: null })
  })
})

describe('whether a template would replace somebody’s work', () => {
  const STARTER = 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[Rethink]'

  it('would not, over nothing', () => {
    expect(templateReplacesUserWork('')).toBe(false)
    expect(templateReplacesUserWork('  \n\t')).toBe(false)
  })

  it('would not, over a template exactly as inserted', () => {
    for (const template of MERMAID_TEMPLATES) {
      expect(templateReplacesUserWork(template.source)).toBe(false)
      expect(templateReplacesUserWork('\n' + template.source + '\n')).toBe(false)
    }
  })

  it('would not, over a starter the caller names', () => {
    expect(templateReplacesUserWork(STARTER)).toBe(true)
    expect(templateReplacesUserWork(STARTER, [STARTER])).toBe(false)
  })

  it('would, over anything else — one character is somebody’s work', () => {
    expect(templateReplacesUserWork('graph TD\n  X --> Y')).toBe(true)
    expect(templateReplacesUserWork(MERMAID_TEMPLATES[0].source + '\n  CEO --> ENG')).toBe(true)
    expect(templateReplacesUserWork(STARTER.replace('Rethink', 'Rethink it'), [STARTER])).toBe(true)
  })
})
