/**
 * @jest-environment node
 *
 * Mermaid as the judge of a builder edit.
 *
 * What is pinned here is the judge's own behaviour, with mermaid faked: the
 * one adapter that reads mermaid's flowchart database (and refuses a database
 * of another shape rather than reading it loosely), the turn it takes in the
 * runtime's queue, what counts as "the same reading", and that an edit is kept
 * only when it passes every stage — the text of a refused edit never comes
 * back.
 *
 * Whether the REAL library's database is the shape the adapter expects is not
 * something a fake can say. `scripts/MermaidFlowEngineContract.mjs` runs the
 * same adapter against the installed mermaid.
 */
import {
  applyMermaidFlowEdit,
  inspectMermaidFlowchart,
  judgeMermaidFlowReading,
  type MermaidFlowEdit,
  type MermaidFlowExpectation,
  type MermaidFlowReadResult,
  mermaidFlowReadingFromDatabase,
  readMermaidFlowchart,
  UnfamiliarMermaidDatabase,
} from './MermaidOracle'
import { renderMermaidDiagram } from './MermaidRuntime'
import { type MermaidFlowReading, parseMermaidFlowSource } from './MermaidSourceDoc'

const src = (...lines: string[]): string => lines.join('\n')

// ---------------------------------------------------------------------------
// A database shaped like mermaid 11's FlowDB after parsing
//   flowchart LR
//     A[One] e1@-->|go| B
//     subgraph g [Group]
//       C
//     end
//     click A href "https://example.com" "tip"
//     linkStyle default stroke:#999
// ---------------------------------------------------------------------------
const flowDatabase = (): Record<string, unknown> => {
  const vertices = new Map<string, Record<string, unknown>>([
    [
      'A',
      {
        id: 'A',
        labelType: 'text',
        domId: 'flowchart-A-0',
        styles: [],
        classes: ['clickable'],
        text: 'One',
        type: 'square',
        props: {},
        link: 'https://example.com',
      },
    ],
    ['B', { id: 'B', labelType: 'text', domId: 'flowchart-B-1', styles: [], classes: [], text: 'B', props: {} }],
    [
      'C',
      { id: 'C', labelType: 'text', domId: 'flowchart-C-2', styles: ['fill:#eee'], classes: [], text: 'C', props: {} },
    ],
  ])
  const edges: Record<string, unknown>[] & { defaultStyle?: string[]; defaultInterpolate?: string } = [
    {
      start: 'A',
      end: 'B',
      type: 'arrow_point',
      text: 'go',
      labelType: 'text',
      classes: [],
      isUserDefinedId: true,
      interpolate: undefined,
      stroke: 'normal',
      length: 1,
      id: 'e1',
      animate: true,
    },
    {
      start: 'B',
      end: 'C',
      type: 'arrow_open',
      text: '',
      labelType: 'text',
      classes: [],
      isUserDefinedId: false,
      stroke: 'dotted',
      length: 2,
      id: 'L_B_C_0',
      style: ['stroke:#f00', 'fill:none'],
    },
  ]
  edges.defaultStyle = ['stroke:#999']
  const subGraphs = [{ id: 'g', nodes: ['C'], title: 'Group', classes: [], dir: undefined, labelType: 'text' }]
  const classes = new Map([['hot', { id: 'hot', styles: ['fill:#f96'], textStyles: [] }]])
  return {
    getVertices: () => vertices,
    getEdges: () => edges,
    getSubGraphs: () => subGraphs,
    getClasses: () => classes,
    getDirection: () => 'LR',
    getAccTitle: () => 'A title',
    getAccDescription: () => '',
    tooltips: new Map([['A', 'tip']]),
  }
}

describe('the one adapter that reads mermaid’s flowchart database', () => {
  it('reads boxes, links, groups and named styles into the reading the builder compares', () => {
    expect(mermaidFlowReadingFromDatabase(flowDatabase())).toEqual({
      direction: 'LR',
      nodes: [
        // `domId` is derived from a counter and is not meaning; `props: {}` says nothing.
        {
          id: 'A',
          text: 'One',
          type: 'square',
          labelType: 'text',
          classes: ['clickable'],
          styles: [],
          extra: { link: 'https://example.com' },
        },
        { id: 'B', text: 'B', type: undefined, labelType: 'text', classes: [], styles: [] },
        { id: 'C', text: 'C', type: undefined, labelType: 'text', classes: [], styles: ['fill:#eee'] },
      ],
      edges: [
        {
          start: 'A',
          end: 'B',
          type: 'arrow_point',
          stroke: 'normal',
          length: 1,
          text: 'go',
          labelType: 'text',
          // An id the text itself gave is kept …
          id: 'e1',
          classes: [],
          style: undefined,
          interpolate: undefined,
          extra: { animate: true },
        },
        {
          start: 'B',
          end: 'C',
          type: 'arrow_open',
          stroke: 'dotted',
          length: 2,
          text: '',
          labelType: 'text',
          // … and one mermaid generated from the ends is not.
          id: undefined,
          classes: [],
          style: ['stroke:#f00', 'fill:none'],
          interpolate: undefined,
        },
      ],
      groups: [{ id: 'g', title: 'Group', nodes: ['C'], dir: undefined, labelType: 'text', classes: [] }],
      classes: [{ id: 'hot', styles: ['fill:#f96'], textStyles: [] }],
      defaultLinkStyle: ['stroke:#999'],
      defaultInterpolate: undefined,
      extra: { accTitle: 'A title', tooltips: [['A', 'tip']] },
    })
  })

  it('copies what it reads, so a later parse cannot change a reading already taken', () => {
    const database = flowDatabase()
    const reading = mermaidFlowReadingFromDatabase(database)
    ;(database.getVertices as () => Map<string, { classes: string[] }>)().get('A')?.classes.push('later')
    expect(reading.nodes[0].classes).toEqual(['clickable'])
  })

  const broken: [string, (database: Record<string, unknown>) => void, RegExp][] = [
    ['no getVertices', (database) => delete database.getVertices, /it has no getVertices\(\)/],
    ['no getEdges', (database) => delete database.getEdges, /it has no getEdges\(\)/],
    ['no getSubGraphs', (database) => delete database.getSubGraphs, /it has no getSubGraphs\(\)/],
    ['no getClasses', (database) => delete database.getClasses, /it has no getClasses\(\)/],
    ['no getDirection', (database) => delete database.getDirection, /it has no getDirection\(\)/],
    [
      'boxes in a plain object',
      (database) => (database.getVertices = () => ({})),
      /getVertices\(\) does not return a Map/,
    ],
    ['links in a Map', (database) => (database.getEdges = () => new Map()), /getEdges\(\) does not return a list/],
    [
      'groups in a Map',
      (database) => (database.getSubGraphs = () => new Map()),
      /getSubGraphs\(\) does not return a list/,
    ],
    ['named styles in a list', (database) => (database.getClasses = () => []), /getClasses\(\) does not return a Map/],
    [
      'a box filed under another id',
      (database) => (database.getVertices = () => new Map([['Z', { id: 'A', text: 'A', labelType: 'text' }]])),
      /a box is not filed under its own id/,
    ],
    [
      'a box with no text',
      (database) => (database.getVertices = () => new Map([['A', { id: 'A', labelType: 'text' }]])),
      /the text of A is not text/,
    ],
    [
      'a link whose start is a box object',
      (database) => (database.getEdges = () => [{ start: { id: 'A' }, end: 'B', text: '', labelType: 'text' }]),
      /the start of link 0 is not text/,
    ],
    [
      'a link with a length that is not a number',
      (database) => (database.getEdges = () => [{ start: 'A', end: 'B', text: '', labelType: 'text', length: '1' }]),
      /the length of link 0 is not a number/,
    ],
    [
      'a group whose members are objects',
      (database) => (database.getSubGraphs = () => [{ id: 'g', title: '', labelType: 'text', nodes: [{ id: 'C' }] }]),
      /the boxes of group g is not a list of strings/,
    ],
  ]

  it.each(broken)('refuses a database with %s, by name', (_name, damage, expected) => {
    const database = flowDatabase()
    damage(database)
    expect(() => mermaidFlowReadingFromDatabase(database)).toThrow(UnfamiliarMermaidDatabase)
    expect(() => mermaidFlowReadingFromDatabase(database)).toThrow(expected)
  })

  it('refuses nothing at all', () => {
    expect(() => mermaidFlowReadingFromDatabase(undefined)).toThrow(/there is none/)
  })
})

// ---------------------------------------------------------------------------
// The turn it takes in the runtime's queue
// ---------------------------------------------------------------------------
let calls: string[] = []
let initialized: Record<string, unknown>[] = []
let held: { release: () => void } | null = null
let holdNextRender = false
let nextDiagram: () => { type: string; db: unknown } = () => ({ type: 'flowchart-v2', db: flowDatabase() })

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    mermaidAPI: {
      reset: () => {
        calls.push('reset')
      },
      getDiagramFromText: async (text: string) => {
        calls.push(`read ${text}`)
        return nextDiagram()
      },
    },
    initialize: (config: Record<string, unknown>) => {
      calls.push(`initialize ${String(config.theme)}`)
      initialized.push(config)
    },
    parse: async () => ({ diagramType: 'flowchart-v2', config: {} }),
    render: async (id: string) => {
      calls.push(`render ${id} start`)
      if (holdNextRender) {
        holdNextRender = false
        await new Promise<void>((release) => {
          held = { release }
        })
      }
      calls.push(`render ${id} end`)
      return { svg: `<svg id="${id}"></svg>` }
    },
  },
}))

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  calls = []
  initialized = []
  held = null
  holdNextRender = false
  nextDiagram = () => ({ type: 'flowchart-v2', db: flowDatabase() })
})

describe('asking mermaid what a text means', () => {
  it('configures mermaid for itself first — strict, with the app’s locked keys — and then parses', async () => {
    const result = await readMermaidFlowchart('TEXT')
    expect(calls).toEqual(['reset', 'initialize undefined', 'read TEXT'])
    expect(initialized[0]).toMatchObject({ startOnLoad: false, securityLevel: 'strict' })
    expect(initialized[0].secure).toEqual(expect.arrayContaining(['securityLevel', 'maxEdges']))
    // No theme and no palette: what a text means does not depend on what it is drawn with.
    expect(initialized[0].theme).toBeUndefined()
    expect(initialized[0].themeVariables).toBeUndefined()
    expect(result.ok && result.reading.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C'])
  })

  it('waits its turn behind a render, and does not reconfigure mermaid under it', async () => {
    holdNextRender = true
    const render = renderMermaidDiagram({
      id: 'mermaid-1-0',
      text: 'flowchart LR\n  A --> B',
      theme: { theme: 'forest' },
      fontFamily: 'Georgia, serif',
      measureIn: undefined,
    })
    const reading = readMermaidFlowchart('TEXT')
    await settle()
    // The render is in flight, configured as forest. Nothing of the read has happened.
    expect(calls).toEqual(['reset', 'initialize forest', 'render mermaid-1-0 start'])
    held?.release()
    await render
    await reading
    expect(calls).toEqual([
      'reset',
      'initialize forest',
      'render mermaid-1-0 start',
      'render mermaid-1-0 end',
      'reset',
      'initialize undefined',
      'read TEXT',
    ])
  })

  it('says so when the text is another kind of diagram', async () => {
    nextDiagram = () => ({ type: 'sequence', db: {} })
    expect(await readMermaidFlowchart('TEXT')).toEqual({
      ok: false,
      kind: 'not-flowchart',
      diagramType: 'sequence',
      message: 'This is a sequence diagram, not a flowchart.',
    })
  })

  it('passes on mermaid’s own words when mermaid cannot parse the text, and does not throw', async () => {
    nextDiagram = () => {
      throw new Error('Parse error on line 2:\n...A -->\n-----^\nExpecting something')
    }
    expect(await readMermaidFlowchart('TEXT')).toEqual({
      ok: false,
      kind: 'rejected',
      message: 'Parse error on line 2:\n...A -->\n-----^\nExpecting something',
    })
  })

  it('says the database is unfamiliar rather than reading it as an empty diagram', async () => {
    nextDiagram = () => ({ type: 'flowchart-v2', db: { getVertices: () => new Map() } })
    const result = await readMermaidFlowchart('TEXT')
    expect(result).toMatchObject({ ok: false, kind: 'unfamiliar' })
    expect(!result.ok && result.message).toMatch(/not the one the builder was written against: it has no getEdges\(\)/)
  })

  it('lets the next reading through after one that failed', async () => {
    nextDiagram = () => {
      throw new Error('broken')
    }
    await readMermaidFlowchart('FIRST')
    nextDiagram = () => ({ type: 'flowchart-v2', db: flowDatabase() })
    expect((await readMermaidFlowchart('SECOND')).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What counts as the reading that was asked for
// ---------------------------------------------------------------------------
const readingOf = (source: string): MermaidFlowReading => {
  const { reading, problem } = parseMermaidFlowSource(source)
  if (!reading) {
    throw new Error(`a source this test needs read was refused: ${problem?.message}`)
  }
  return reading
}

const BASE = src('flowchart LR', '  A[One] -->|go| B', '  B --> C', '  subgraph g [Group]', '    C', '    D', '  end')

const expecting = (
  reading: MermaidFlowReading,
  extras: Partial<MermaidFlowExpectation> = {},
): MermaidFlowExpectation => ({
  reading,
  created: [],
  relabelled: [],
  reordered: [],
  ...extras,
})

describe('judging what mermaid reads after an edit', () => {
  it('finds no fault in the very reading that was expected', () => {
    expect(judgeMermaidFlowReading(expecting(readingOf(BASE)), readingOf(BASE))).toEqual([])
  })

  it.each([
    ['a box that is gone', BASE.replace('    D\n', ''), /^boxes: /],
    ['a box with another label', BASE.replace('One', 'Two'), /^label of A: /],
    ['a box with another shape', BASE.replace('A[One]', 'A(One)'), /^shape of A: /],
    ['a quoted label where a plain one was', BASE.replace('A[One]', 'A["One"]'), /^label kind of A: /],
    ['a box with a class it did not have', BASE.replace('| B', '| B:::hot'), /^classes of B: /],
    ['a box with a style it did not have', BASE + '\n  style B fill:#eee', /^styles of B: /],
    ['one link fewer', BASE.replace('  B --> C\n', ''), /^number of links: /],
    ['a link that ends elsewhere', BASE.replace('B --> C', 'B --> D'), /^ends of link 1: /],
    ['a link drawn differently', BASE.replace('B --> C', 'B ==> C'), /^line of link 1 \(B to C\): /],
    ['a longer link', BASE.replace('B --> C', 'B ---> C'), /^line of link 1 \(B to C\): /],
    ['a link with other text', BASE.replace('|go|', '|stop|'), /^text of link 0 \(A to B\): /],
    ['a link that gained an id', BASE.replace('B --> C', 'B e1@--> C'), /^id of link 1 \(B to C\): /],
    ['a link that gained a style', BASE + '\n  linkStyle 1 stroke:#f00', /^style of link 1 \(B to C\): /],
    [
      'the same links in another order',
      BASE.replace('  A[One] -->|go| B\n  B --> C', '  B --> C\n  A[One] -->|go| B'),
      /^ends of link 0: /,
    ],
    ['a group that is gone', src('flowchart LR', '  A[One] -->|go| B', '  B --> C', '  D'), /^groups: /],
    ['a group with another box in it', BASE.replace('    D\n', '    D\n    A\n'), /^boxes in group g: /],
    ['a group with another title', BASE.replace('Group', 'Other'), /^title of group g: /],
    ['a group with a direction', BASE.replace('    C\n', '    direction TB\n    C\n'), /^direction of group g: /],
    ['another direction', BASE.replace('LR', 'TB'), /^direction: /],
    ['a named style', BASE + '\n  classDef hot fill:#f96', /^named styles: /],
    ['a default link style', BASE + '\n  linkStyle default stroke:#999', /^default link style: /],
  ])('names %s', (_name, other, expected) => {
    const faults = judgeMermaidFlowReading(expecting(readingOf(BASE)), readingOf(other))
    expect(faults.filter((fault) => expected.test(fault))).not.toEqual([])
  })

  it('names a tooltip or an accessibility text that changed', () => {
    const before = readingOf(BASE)
    const titled: MermaidFlowReading = { ...before, extra: { accTitle: 'A title' } }
    expect(judgeMermaidFlowReading(expecting(before), titled).map((fault) => fault.split(':')[0])).toEqual([
      'tooltips and accessibility text',
    ])
    expect(judgeMermaidFlowReading(expecting(titled), titled)).toEqual([])
  })

  it('holds every untouched box to its place in mermaid’s order', () => {
    const moved = BASE.replace('flowchart LR', 'flowchart LR\n  C')
    const faults = judgeMermaidFlowReading(expecting(readingOf(BASE)), readingOf(moved))
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatch(/^order of the boxes: /)
    // … unless the edit said that box may move.
    expect(judgeMermaidFlowReading(expecting(readingOf(BASE), { reordered: ['C'] }), readingOf(moved))).toEqual([])
  })

  it('compares the members of a group as a set', () => {
    const swapped = BASE.replace('    C\n    D\n', '    D\n    C\n')
    expect(readingOf(swapped).groups[0].nodes).not.toEqual(readingOf(BASE).groups[0].nodes)
    expect(judgeMermaidFlowReading(expecting(readingOf(BASE)), readingOf(swapped))).toEqual([])
  })

  it('compares a text the edit set as a person reads it, and every other text character for character', () => {
    const typed = readingOf(src('flowchart LR', '  A["Tom & Jerry"] -->|"a < b"| B'))
    const kept: MermaidFlowReading = {
      ...typed,
      nodes: [{ ...typed.nodes[0], text: 'Tom &amp; Jerry' }, typed.nodes[1]],
      edges: [{ ...typed.edges[0], text: 'a &lt; b' }],
    }
    const relabelled = expecting(typed, {
      relabelled: [
        { kind: 'node', id: 'A' },
        { kind: 'edge', index: 0 },
      ],
    })
    expect(judgeMermaidFlowReading(relabelled, kept)).toEqual([])
    expect(judgeMermaidFlowReading(expecting(typed), kept).map((fault) => fault.split(':')[0])).toEqual([
      'label of A',
      'text of link 0 (A to B)',
    ])
    // A label mermaid would cut short is a fault even for a text the edit set.
    const cut: MermaidFlowReading = { ...typed, nodes: [{ ...typed.nodes[0], text: 'Tom' }, typed.nodes[1]] }
    expect(judgeMermaidFlowReading(relabelled, cut).map((fault) => fault.split(':')[0])).toEqual(['label of A'])
  })

  it('holds an untouched element to everything mermaid carries for it, and a new one only to what the edit decides', () => {
    const before = readingOf(BASE)
    const withLink: MermaidFlowReading = {
      ...before,
      nodes: before.nodes.map((node) => (node.id === 'B' ? { ...node, extra: { link: 'https://example.com' } } : node)),
    }
    expect(judgeMermaidFlowReading(expecting(before), withLink).map((fault) => fault.split(':')[0])).toEqual([
      'everything else about B',
    ])
    expect(judgeMermaidFlowReading(expecting(before, { created: [{ kind: 'node', id: 'B' }] }), withLink)).toEqual([])
    const curved: MermaidFlowReading = {
      ...before,
      edges: [before.edges[0], { ...before.edges[1], interpolate: 'basis', extra: { animate: true } }],
    }
    expect(judgeMermaidFlowReading(expecting(before), curved).map((fault) => fault.split(':')[0])).toEqual([
      'curve of link 1 (B to C)',
      'everything else about link 1 (B to C)',
    ])
    expect(judgeMermaidFlowReading(expecting(before, { created: [{ kind: 'edge', index: 1 }] }), curved)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// An edit, from text to text, with a stand-in for mermaid
// ---------------------------------------------------------------------------

/** The builder's own reading standing in for mermaid's: the stages are what is under test, not the library. */
const read = async (text: string): Promise<MermaidFlowReadResult> => {
  const { reading, problem } = parseMermaidFlowSource(text)
  return reading
    ? { ok: true, reading }
    : { ok: false, kind: 'rejected', message: `Parse error on line ${(problem?.line ?? 0) + 1}:\n${problem?.message}` }
}

const SIMPLE = src('flowchart LR', '  A --> B')

/** An edit that appends a box and says so. */
const appendBox =
  (line: string, id: string, text = id): MermaidFlowEdit =>
  (document, reading) => ({
    ok: true,
    text: document.source + '\n' + line,
    expectation: {
      reading: {
        ...reading,
        nodes: [...reading.nodes, { id, text, type: 'square', labelType: 'text', classes: [], styles: [] }],
      },
      created: [{ kind: 'node', id }],
      relabelled: [{ kind: 'node', id }],
      reordered: [id],
    },
  })

describe('making an edit', () => {
  it('returns the new text and mermaid’s reading of it when mermaid reads what was asked', async () => {
    const outcome = await applyMermaidFlowEdit(SIMPLE, appendBox('  C[Three]', 'C', 'Three'), read)
    expect(outcome).toMatchObject({ ok: true, text: SIMPLE + '\n  C[Three]' })
    expect(outcome.ok && outcome.reading.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C'])
  })

  it('refuses when mermaid cannot read the diagram as it is', async () => {
    const outcome = await applyMermaidFlowEdit(src('flowchart LR', '  A -->'), appendBox('  C[Three]', 'C'), read)
    expect(outcome).toEqual({
      ok: false,
      stage: 'unreadable',
      reason: 'Parse error on line 2:',
      line: undefined,
      details: ['Parse error on line 2:\nMermaid does not expect the text to end here.'],
    })
  })

  it('refuses when the builder does not read the diagram the way mermaid does', async () => {
    const disagreeing = async (text: string): Promise<MermaidFlowReadResult> => {
      const result = await read(text)
      return result.ok ? { ok: true, reading: { ...result.reading, nodes: result.reading.nodes.slice(1) } } : result
    }
    const outcome = await applyMermaidFlowEdit(SIMPLE, appendBox('  C[Three]', 'C'), disagreeing)
    expect(outcome).toMatchObject({ ok: false, stage: 'not-understood' })
    expect(!outcome.ok && outcome.details[0]).toMatch(/^boxes: the builder reads \["A","B"\], mermaid reads \["B"\]/)
  })

  it('refuses when the builder cannot read a text mermaid can, and says which line', async () => {
    // Stand-in for a grammar the builder's copy does not have: mermaid reads it, the document does not.
    const lenient = async (): Promise<MermaidFlowReadResult> => ({ ok: true, reading: readingOf(SIMPLE) })
    const outcome = await applyMermaidFlowEdit(
      src('flowchart LR', '  A --> B', '  C[open'),
      appendBox('  D', 'D'),
      lenient,
    )
    expect(outcome).toMatchObject({ ok: false, stage: 'not-understood', line: 2 })
  })

  it('passes on the edit’s own refusal, with its line', async () => {
    const refusing: MermaidFlowEdit = () => ({ ok: false, reason: 'That id is already a box.', line: 1 })
    expect(await applyMermaidFlowEdit(SIMPLE, refusing, read)).toEqual({
      ok: false,
      stage: 'refused',
      reason: 'That id is already a box.',
      line: 1,
      details: [],
    })
  })

  it('refuses a result mermaid cannot read', async () => {
    const outcome = await applyMermaidFlowEdit(SIMPLE, appendBox('  C[Three', 'C'), read)
    expect(outcome).toMatchObject({ ok: false, stage: 'rejected' })
    expect(!outcome.ok && outcome.reason).toMatch(/^Mermaid would not accept the result: Parse error on line 3:/)
  })

  it('refuses a result mermaid reads as something else', async () => {
    // The edit says it adds C. What it writes relabels A instead.
    const outcome = await applyMermaidFlowEdit(SIMPLE, appendBox('  A[Three]', 'C', 'Three'), read)
    expect(outcome).toMatchObject({ ok: false, stage: 'changed-meaning' })
    expect(!outcome.ok && outcome.details.map((fault) => fault.split(':')[0])).toEqual(['boxes'])
  })

  it('never hands back the text of an edit it did not accept', async () => {
    const outcomes = [
      await applyMermaidFlowEdit(SIMPLE, appendBox('  C[Three', 'C'), read),
      await applyMermaidFlowEdit(SIMPLE, appendBox('  A[Three]', 'C', 'Three'), read),
      await applyMermaidFlowEdit(SIMPLE, () => ({ ok: false, reason: 'no' }), read),
    ]
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false)
      expect('text' in outcome).toBe(false)
    }
  })

  it('does not ask mermaid about a result that is the text it started from', async () => {
    let asked = 0
    const counting = async (text: string): Promise<MermaidFlowReadResult> => {
      asked++
      return read(text)
    }
    const unchanged: MermaidFlowEdit = (document, reading) => ({
      ok: true,
      text: document.source,
      expectation: { reading, created: [], relabelled: [], reordered: [] },
    })
    expect(await applyMermaidFlowEdit(SIMPLE, unchanged, counting)).toMatchObject({ ok: true, text: SIMPLE })
    expect(asked).toBe(1)
  })
})

describe('inspecting a text before the builder opens on it', () => {
  it('hands back both readings of a text they agree on', async () => {
    const inspection = await inspectMermaidFlowchart(SIMPLE, read)
    expect(inspection.ok && [inspection.reading.edges.length, inspection.document.statements.length]).toEqual([1, 1])
  })

  it('still hands back mermaid’s reading of a text the builder will not edit, so it can be shown', async () => {
    const lenient = async (): Promise<MermaidFlowReadResult> => ({ ok: true, reading: readingOf(SIMPLE) })
    const inspection = await inspectMermaidFlowchart(src('flowchart LR', '  A --> B', '  C[open'), lenient)
    expect(inspection).toMatchObject({ ok: false, stage: 'not-understood', line: 2 })
    expect(!inspection.ok && inspection.reading?.nodes.map((node) => node.id)).toEqual(['A', 'B'])
  })
})
