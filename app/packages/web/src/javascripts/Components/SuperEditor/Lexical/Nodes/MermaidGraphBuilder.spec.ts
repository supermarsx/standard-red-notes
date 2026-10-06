/**
 * Unit tests for the Mermaid VISUAL builder's pure logic:
 *   - buildFlowchartSource() emits valid flowchart source, in every modelled
 *     node shape and link kind.
 *   - parseFlowchartSource() round-trips what it emits and rejects what it
 *     cannot represent.
 *   - SOURCE PRESERVATION: comments, YAML frontmatter, node shapes, link kinds
 *     and styling statements survive a visual edit. Every one of these was lost
 *     silently before, and the comment loss was pinned here as if it were
 *     intended.
 *   - analyzeMermaidSource() names the diagram type and the blocking lines, so
 *     a surface can refuse to touch what it cannot model.
 *   - the model mutators (append/remove/rename) keep the graph consistent —
 *     notably that a rename follows through to every link.
 */

import {
  analyzeMermaidSource,
  appendGraphEdge,
  appendGraphNode,
  buildFlowchartSource,
  createEmptyGraphModel,
  danglingExtras,
  detectMermaidDiagramType,
  edgeConnector,
  getTemplateSource,
  MERMAID_EDGE_KINDS,
  MERMAID_NODE_SHAPES,
  MERMAID_TEMPLATES,
  MermaidGraphModel,
  nextNodeId,
  parseFlowchartSource,
  removeGraphNode,
  renameGraphNode,
  sanitizeNodeId,
  shapeDelimiters,
} from './MermaidGraphBuilder'

/** Real newlines in fixture sources, built rather than escaped. */
const src = (...lines: string[]): string => lines.join('\n')

const sample: MermaidGraphModel = {
  direction: 'TD',
  nodes: [
    { id: 'A', label: 'Start' },
    { id: 'B', label: 'End' },
  ],
  edges: [{ from: 'A', to: 'B', label: 'yes' }],
}

describe('buildFlowchartSource', () => {
  it('emits a header, node declarations and edges', () => {
    const source = buildFlowchartSource(sample)
    const lines = source.split('\n')
    expect(lines[0]).toBe('graph TD')
    expect(source).toContain('A["Start"]')
    expect(source).toContain('B["End"]')
    expect(source).toContain('A -->|yes| B')
  })

  it('omits the label pipe when an edge has no label', () => {
    const source = buildFlowchartSource({ ...sample, edges: [{ from: 'A', to: 'B', label: '' }] })
    expect(source).toContain('A --> B')
    expect(source).not.toContain('-->|')
  })

  it('falls back to the id when a node label is empty', () => {
    const source = buildFlowchartSource({ direction: 'LR', nodes: [{ id: 'X', label: '' }], edges: [] })
    expect(source).toContain('X["X"]')
  })

  it('drops edges that reference unknown nodes so output always renders', () => {
    const source = buildFlowchartSource({
      direction: 'TD',
      nodes: [{ id: 'A', label: 'A' }],
      edges: [{ from: 'A', to: 'ZZZ', label: '' }],
    })
    expect(source).not.toContain('ZZZ')
  })

  it('sanitizes ids and escapes labels/edge labels', () => {
    const source = buildFlowchartSource({
      direction: 'TD',
      nodes: [{ id: 'a b', label: 'He said "hi"' }],
      edges: [],
    })
    expect(source).toContain('a_b["He said &quot;hi&quot;"]')
  })

  it('falls back to the default direction for a bad direction', () => {
    const source = buildFlowchartSource({
      direction: 'NOPE' as MermaidGraphModel['direction'],
      nodes: [],
      edges: [],
    })
    expect(source.split('\n')[0]).toBe('graph TD')
  })

  it('writes every modelled shape with its own delimiters', () => {
    for (const shape of MERMAID_NODE_SHAPES) {
      const { open, close } = shapeDelimiters(shape)
      const source = buildFlowchartSource({
        direction: 'TD',
        nodes: [{ id: 'N', label: 'Label', shape }],
        edges: [],
      })
      expect([shape, source]).toEqual([shape, src('graph TD', `  N${open}"Label"${close}`)])
    }
  })

  it('writes every modelled link kind with its own connector', () => {
    for (const kind of MERMAID_EDGE_KINDS) {
      const source = buildFlowchartSource({
        direction: 'TD',
        nodes: [
          { id: 'A', label: 'A' },
          { id: 'B', label: 'B' },
        ],
        edges: [{ from: 'A', to: 'B', label: '', kind }],
      })
      expect([kind, source.split('\n')[3]]).toEqual([kind, `  A ${edgeConnector(kind)} B`])
    }
  })

  it('re-emits the preamble before the header and the extras after the body', () => {
    const source = buildFlowchartSource({
      direction: 'TD',
      nodes: [{ id: 'A', label: 'A' }],
      edges: [],
      preamble: ['%% keep me'],
      extras: ['classDef hot fill:#f99'],
    })
    expect(source).toBe(src('%% keep me', 'graph TD', '  A["A"]', 'classDef hot fill:#f99'))
  })
})

describe('parseFlowchartSource', () => {
  it('round-trips the source produced by buildFlowchartSource', () => {
    const parsed = parseFlowchartSource(buildFlowchartSource(sample))
    expect(parsed).not.toBeNull()
    expect(parsed!.direction).toBe('TD')
    expect(parsed!.nodes).toEqual([
      { id: 'A', label: 'Start', shape: 'rect' },
      { id: 'B', label: 'End', shape: 'rect' },
    ])
    expect(parsed!.edges).toEqual([{ from: 'A', to: 'B', label: 'yes', kind: 'arrow' }])
  })

  it('accepts the `flowchart` keyword and TB direction alias', () => {
    const parsed = parseFlowchartSource(src('flowchart TB', '  A[One]', '  A --> B'))
    expect(parsed).not.toBeNull()
    expect(parsed!.direction).toBe('TD')
    expect(parsed!.nodes.map((n) => n.id)).toEqual(['A', 'B'])
  })

  it('parses edge labels', () => {
    const parsed = parseFlowchartSource(src('graph LR', '  A --> |maybe| B'))
    expect(parsed!.edges).toEqual([{ from: 'A', to: 'B', label: 'maybe', kind: 'arrow' }])
  })

  it('returns null for a sequence diagram', () => {
    expect(parseFlowchartSource(src('sequenceDiagram', '  A->>B: hi'))).toBeNull()
  })

  it('returns null when there is no graph header', () => {
    expect(parseFlowchartSource('A --> B')).toBeNull()
  })

  it('returns null for non-string input', () => {
    expect(parseFlowchartSource(undefined as unknown as string)).toBeNull()
  })

  it('reads past comments and blank lines, and KEEPS the comment', () => {
    const parsed = parseFlowchartSource(src('graph TD', '', '  %% a comment', '  A --> B'))
    expect(parsed).not.toBeNull()
    expect(parsed!.nodes.map((n) => n.id)).toEqual(['A', 'B'])
    // The comment used to be DROPPED here, and this file used to assert that as
    // intended behaviour. Regenerating the source then deleted it with no
    // warning at all, because the parse had "succeeded".
    expect(parsed!.extras).toEqual(['  %% a comment'])
    expect(buildFlowchartSource(parsed!)).toContain('%% a comment')
  })

  /**
   * A four-dash link contains a three-dash one starting one character later, and
   * `--->` contains `-->`. Reading either OUT would silently shorten someone's
   * arrow, so both ends of a candidate connector are guarded.
   *
   * The assertion is on the MESSAGE, not just on null, and that is the point:
   * the operand check rejects these lines anyway, so asserting null alone passes
   * with both guards deleted. Only the specific answer distinguishes "this link
   * form is not modelled" from "something on this line is unreadable", and only
   * the specific answer proves the guard ran.
   */
  it('refuses a link longer than any it models, and says which link it was', () => {
    const cases: [string, string][] = [
      ['  A ---- B', '----'],
      ['  A ---> B', '--->'],
      ['  A ----> B', '---->'],
      ['  A ===> B', '===>'],
      ['  A -..-> B', '-..->'],
    ]
    for (const [line, run] of cases) {
      const analysis = analyzeMermaidSource(src('graph TD', line))
      expect([line, analysis.model]).toEqual([line, null])
      expect([line, analysis.blockers]).toEqual([
        line,
        [`line 2: the link ${run} is a length or style the builder does not model`],
      ])
    }
  })

  it('still reads the links it does model, unshortened', () => {
    for (const kind of MERMAID_EDGE_KINDS) {
      const connector = edgeConnector(kind)
      const parsed = parseFlowchartSource(src('graph TD', `  A ${connector} B`))
      expect([kind, parsed?.edges]).toEqual([kind, [{ from: 'A', to: 'B', label: '', kind }]])
    }
  })

  it('does not split on an arrow inside a label', () => {
    const parsed = parseFlowchartSource(src('graph TD', '  A["ship --> done"] --> B'))
    expect(parsed).not.toBeNull()
    expect(parsed!.nodes.map((n) => n.label)).toEqual(['ship --> done', 'B'])
    expect(parsed!.edges).toEqual([{ from: 'A', to: 'B', label: '', kind: 'arrow' }])
  })
})

/**
 * THE preservation contract. Every case here is a thing a visual edit used to
 * destroy with no warning, so each one asserts the FULL round trip: parse the
 * user's source, regenerate it, and find the content still in it.
 */
describe('a visual edit preserves what the builder does not model', () => {
  const roundTrip = (source: string): string => {
    const parsed = parseFlowchartSource(source)
    expect(parsed).not.toBeNull()
    return buildFlowchartSource(parsed!)
  }

  it('keeps a leading comment', () => {
    expect(roundTrip(src('%% quarterly plan — do not delete', 'graph TD', '  A["Start"]'))).toContain(
      '%% quarterly plan — do not delete',
    )
  })

  it('keeps YAML frontmatter verbatim, including its title and config', () => {
    const source = src('---', 'title: Release flow', 'config:', '  theme: forest', '---', 'graph TD', '  A["Start"]')
    const regenerated = roundTrip(source)
    expect(regenerated.startsWith(src('---', 'title: Release flow', 'config:', '  theme: forest', '---'))).toBe(true)
  })

  it('keeps every node shape instead of flattening it to a box', () => {
    for (const shape of MERMAID_NODE_SHAPES) {
      const { open, close } = shapeDelimiters(shape)
      const source = src('graph TD', `  N${open}Decide${close}`)
      expect([shape, roundTrip(source)]).toEqual([shape, src('graph TD', `  N${open}"Decide"${close}`)])
    }
  })

  it('keeps every link kind instead of normalizing it to a plain arrow', () => {
    for (const kind of MERMAID_EDGE_KINDS) {
      const connector = edgeConnector(kind)
      const source = src('graph TD', `  A ${connector} B`)
      expect([kind, roundTrip(source).includes(`A ${connector} B`)]).toEqual([kind, true])
    }
  })

  it('keeps classDef / class / style / linkStyle / click statements', () => {
    const source = src(
      'graph TD',
      '  A["Start"]',
      '  B["End"]',
      '  A --> B',
      'classDef hot fill:#f99,stroke:#900',
      'class A hot',
      'style B stroke-width:4px',
      'linkStyle 0 stroke:#09f',
      'click A "https://example.com" "Open"',
    )
    const regenerated = roundTrip(source)
    for (const kept of [
      'classDef hot fill:#f99,stroke:#900',
      'class A hot',
      'style B stroke-width:4px',
      'linkStyle 0 stroke:#09f',
      'click A "https://example.com" "Open"',
    ]) {
      expect(regenerated).toContain(kept)
    }
  })

  it('reports the preserved lines that now point at a node that is gone', () => {
    const parsed = parseFlowchartSource(src('graph TD', '  A["Start"]', '  B["End"]', 'class A hot', 'class B cold'))!
    expect(danglingExtras(parsed)).toEqual([])
    const withoutA = removeGraphNode(parsed, 0)
    expect(danglingExtras(withoutA)).toEqual(['class A hot'])
    // Reported, never rewritten: guessing inside someone's styling is worse than
    // leaving it exactly as they wrote it.
    expect(buildFlowchartSource(withoutA)).toContain('class A hot')
  })
})

describe('analyzeMermaidSource names the diagram and why it cannot be built', () => {
  it('identifies each diagram family by its opening keyword', () => {
    const cases: [string, string][] = [
      ['graph TD', 'flowchart'],
      ['flowchart LR', 'flowchart'],
      ['sequenceDiagram', 'sequence'],
      ['classDiagram', 'class'],
      ['stateDiagram-v2', 'state'],
      ['erDiagram', 'er'],
      ['gantt', 'gantt'],
      ['pie showData', 'pie'],
      ['journey', 'journey'],
      ['gitGraph', 'gitGraph'],
      ['mindmap', 'mindmap'],
      ['timeline', 'timeline'],
      ['quadrantChart', 'quadrant'],
      ['C4Context', 'c4'],
      ['wat', 'unknown'],
    ]
    for (const [source, expected] of cases) {
      expect([source, detectMermaidDiagramType(source)]).toEqual([source, expected])
    }
  })

  it('looks past frontmatter and comments for the keyword', () => {
    expect(detectMermaidDiagramType(src('---', 'title: X', '---', '%% note', 'sequenceDiagram'))).toBe('sequence')
  })

  it('refuses a sequence diagram and says so in words a user can read', () => {
    const analysis = analyzeMermaidSource(src('sequenceDiagram', '  A->>B: hi'))
    expect(analysis.model).toBeNull()
    expect(analysis.type).toBe('sequence')
    expect(analysis.blockers).toEqual(['this is a sequence diagram, and the builder models flowcharts'])
  })

  it('refuses a flowchart with a subgraph, naming the line', () => {
    const analysis = analyzeMermaidSource(src('graph TD', '  subgraph Backend', '    A --> B', '  end'))
    expect(analysis.type).toBe('flowchart')
    expect(analysis.model).toBeNull()
    expect(analysis.blockers.join(' ')).toContain('line 2')
    expect(analysis.blockers.join(' ')).toContain('subgraph')
  })

  it('treats an empty block as a fresh flowchart rather than a failure', () => {
    const analysis = analyzeMermaidSource('   ')
    expect(analysis.type).toBe('flowchart')
    expect(analysis.model).toEqual(createEmptyGraphModel())
    expect(analysis.blockers).toEqual([])
  })

  it('refuses a header with content it would otherwise swallow', () => {
    expect(analyzeMermaidSource(src('graph TD A --> B')).model).toBeNull()
  })
})

describe('model mutators', () => {
  const two = (): MermaidGraphModel =>
    parseFlowchartSource(src('graph TD', '  A["Start"]', '  B["End"]', '  A -->|go| B'))!

  it('appendGraphNode adds a node with a free id and leaves the rest alone', () => {
    const next = appendGraphNode(two())
    expect(next.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C'])
    expect(next.edges).toEqual(two().edges)
  })

  it('appendGraphEdge links the two most recent nodes', () => {
    const next = appendGraphEdge(appendGraphNode(two()))
    expect(next.edges[next.edges.length - 1]).toEqual({ from: 'B', to: 'C', label: '', kind: 'arrow' })
  })

  it('appendGraphEdge is a no-op with no nodes', () => {
    const empty = createEmptyGraphModel()
    expect(appendGraphEdge(empty)).toEqual(empty)
  })

  it('appendGraphEdge self-links the only node rather than inventing one', () => {
    const one = appendGraphNode(createEmptyGraphModel())
    expect(appendGraphEdge(one).edges).toEqual([{ from: 'A', to: 'A', label: '', kind: 'arrow' }])
  })

  /**
   * THE silent deletion: renaming a node used to change only the node, leaving
   * every link pointing at an id that no longer existed — and generation drops
   * unknown links. So correcting a name deleted the connections, with nothing
   * on screen to say so.
   */
  it('renameGraphNode follows the rename through every link', () => {
    const renamed = renameGraphNode(two(), 0, 'Start')
    expect(renamed.edges).toEqual([{ from: 'Start', to: 'B', label: 'go', kind: 'arrow' }])
    expect(buildFlowchartSource(renamed)).toContain('Start -->|go| B')
  })

  it('renameGraphNode is a no-op for an index that is not there', () => {
    const model = two()
    expect(renameGraphNode(model, 9, 'Z')).toBe(model)
  })

  it('removeGraphNode drops the node and every link that touched it', () => {
    const next = removeGraphNode(two(), 0)
    expect(next.nodes.map((n) => n.id)).toEqual(['B'])
    expect(next.edges).toEqual([])
  })
})

describe('nextNodeId', () => {
  it('returns A for an empty list', () => {
    expect(nextNodeId([])).toBe('A')
  })

  it('skips taken ids', () => {
    expect(
      nextNodeId([
        { id: 'A', label: '' },
        { id: 'B', label: '' },
      ]),
    ).toBe('C')
  })

  it('wraps past Z into A1, B1, ...', () => {
    const nodes = Array.from({ length: 26 }, (_, i) => ({ id: String.fromCharCode(65 + i), label: '' }))
    expect(nextNodeId(nodes)).toBe('A1')
  })
})

describe('sanitizeNodeId', () => {
  it('replaces non-identifier characters with underscores', () => {
    expect(sanitizeNodeId('a-b c')).toBe('a_b_c')
  })

  it('falls back to n for an empty/invalid id', () => {
    expect(sanitizeNodeId('   ')).toBe('n')
    expect(sanitizeNodeId('')).toBe('n')
  })
})

describe('createEmptyGraphModel', () => {
  it('produces an empty TD model that preserves nothing, because there is nothing', () => {
    expect(createEmptyGraphModel()).toEqual({ direction: 'TD', nodes: [], edges: [], preamble: [], extras: [] })
  })
})

describe('MERMAID_TEMPLATES', () => {
  it('includes the required starter diagrams', () => {
    const ids = MERMAID_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(
      expect.arrayContaining(['org-chart', 'shareholders', 'process-workflow', 'flowchart', 'sequence']),
    )
  })

  it('every template has a non-empty source and label', () => {
    for (const t of MERMAID_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.source.length).toBeGreaterThan(0)
    }
  })

  it('flowchart templates parse back into a graph model', () => {
    expect(parseFlowchartSource(getTemplateSource('org-chart')!)).not.toBeNull()
    expect(parseFlowchartSource(getTemplateSource('flowchart')!)).not.toBeNull()
  })

  /**
   * The templates are the fastest way to reach the builder, so they are also the
   * fastest way to lose a shape. `process-workflow` and `flowchart` both carry a
   * decision rhombus, which the builder used to flatten on the first click.
   */
  it('keeps the decision shapes in the templates that have them', () => {
    for (const id of ['process-workflow', 'flowchart']) {
      const parsed = parseFlowchartSource(getTemplateSource(id)!)!
      expect([id, parsed.nodes.some((node) => node.shape === 'rhombus')]).toEqual([id, true])
      expect([id, buildFlowchartSource(parsed)]).toEqual([id, expect.stringContaining('{"')])
    }
  })

  it('getTemplateSource returns undefined for an unknown id', () => {
    expect(getTemplateSource('nope')).toBeUndefined()
  })
})
