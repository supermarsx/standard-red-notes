/**
 * Unit tests for the Mermaid GRAPHICAL builder pure logic:
 *   - buildFlowchartSource() emits valid `graph <dir>` flowchart source.
 *   - parseFlowchartSource() round-trips the source it emits and rejects
 *     non-flowchart diagrams.
 *   - nextNodeId() / sanitizeNodeId() behave for id generation/cleanup.
 *   - MERMAID_TEMPLATES are well-formed.
 */

import {
  buildFlowchartSource,
  createEmptyGraphModel,
  getTemplateSource,
  MERMAID_TEMPLATES,
  MermaidGraphModel,
  nextNodeId,
  parseFlowchartSource,
  sanitizeNodeId,
} from './MermaidGraphBuilder'

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
    const src = buildFlowchartSource(sample)
    const lines = src.split('\n')
    expect(lines[0]).toBe('graph TD')
    expect(src).toContain('A["Start"]')
    expect(src).toContain('B["End"]')
    expect(src).toContain('A -->|yes| B')
  })

  it('omits the label pipe when an edge has no label', () => {
    const src = buildFlowchartSource({ ...sample, edges: [{ from: 'A', to: 'B', label: '' }] })
    expect(src).toContain('A --> B')
    expect(src).not.toContain('-->|')
  })

  it('falls back to the id when a node label is empty', () => {
    const src = buildFlowchartSource({ direction: 'LR', nodes: [{ id: 'X', label: '' }], edges: [] })
    expect(src).toContain('X["X"]')
  })

  it('drops edges that reference unknown nodes so output always renders', () => {
    const src = buildFlowchartSource({
      direction: 'TD',
      nodes: [{ id: 'A', label: 'A' }],
      edges: [{ from: 'A', to: 'ZZZ', label: '' }],
    })
    expect(src).not.toContain('ZZZ')
  })

  it('sanitizes ids and escapes labels/edge labels', () => {
    const src = buildFlowchartSource({
      direction: 'TD',
      nodes: [{ id: 'a b', label: 'He said "hi"' }],
      edges: [],
    })
    expect(src).toContain('a_b["He said &quot;hi&quot;"]')
  })

  it('falls back to the default direction for a bad direction', () => {
    const src = buildFlowchartSource({
      direction: 'XX' as MermaidGraphModel['direction'],
      nodes: [],
      edges: [],
    })
    expect(src.split('\n')[0]).toBe('graph TD')
  })
})

describe('parseFlowchartSource', () => {
  it('round-trips the source produced by buildFlowchartSource', () => {
    const src = buildFlowchartSource(sample)
    const parsed = parseFlowchartSource(src)
    expect(parsed).not.toBeNull()
    expect(parsed!.direction).toBe('TD')
    expect(parsed!.nodes).toEqual([
      { id: 'A', label: 'Start' },
      { id: 'B', label: 'End' },
    ])
    expect(parsed!.edges).toEqual([{ from: 'A', to: 'B', label: 'yes' }])
  })

  it('accepts the `flowchart` keyword and TB direction alias', () => {
    const parsed = parseFlowchartSource('flowchart TB\n  A[One]\n  A --> B')
    expect(parsed).not.toBeNull()
    expect(parsed!.direction).toBe('TD')
    expect(parsed!.nodes.map((n) => n.id)).toEqual(['A', 'B'])
  })

  it('parses edge labels', () => {
    const parsed = parseFlowchartSource('graph LR\n  A --> |maybe| B')
    expect(parsed!.edges).toEqual([{ from: 'A', to: 'B', label: 'maybe' }])
  })

  it('returns null for a sequence diagram', () => {
    expect(parseFlowchartSource('sequenceDiagram\n  A->>B: hi')).toBeNull()
  })

  it('returns null when there is no graph header', () => {
    expect(parseFlowchartSource('A --> B')).toBeNull()
  })

  it('returns null for non-string input', () => {
    expect(parseFlowchartSource(undefined as unknown as string)).toBeNull()
  })

  it('ignores comments and blank lines', () => {
    const parsed = parseFlowchartSource('graph TD\n\n  %% a comment\n  A --> B')
    expect(parsed).not.toBeNull()
    expect(parsed!.nodes.map((n) => n.id)).toEqual(['A', 'B'])
  })
})

describe('nextNodeId', () => {
  it('returns A for an empty list', () => {
    expect(nextNodeId([])).toBe('A')
  })

  it('skips taken ids', () => {
    expect(nextNodeId([{ id: 'A', label: '' }, { id: 'B', label: '' }])).toBe('C')
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
  it('produces an empty TD model', () => {
    expect(createEmptyGraphModel()).toEqual({ direction: 'TD', nodes: [], edges: [] })
  })
})

describe('MERMAID_TEMPLATES', () => {
  it('includes the required starter diagrams', () => {
    const ids = MERMAID_TEMPLATES.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['org-chart', 'shareholders', 'process-workflow', 'flowchart', 'sequence']))
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

  it('getTemplateSource returns undefined for an unknown id', () => {
    expect(getTemplateSource('nope')).toBeUndefined()
  })
})
