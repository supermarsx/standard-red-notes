/**
 * @jest-environment node
 *
 * What the builder writes when it is asked to change a flowchart.
 *
 * Nearly every test here compares the WHOLE text after an edit with the whole
 * text it should be. That is deliberate: "an operation touches only the lines
 * it owns" is a statement about every other line, and the only assertion that
 * cannot miss one is equality of the entire text.
 *
 * Each edit goes through `applyMermaidFlowEdit`, so each is also judged: the
 * reading of the result has to be the reading before with exactly the asked
 * change applied. The judge here is the builder's own reading standing in for
 * mermaid's; `scripts/MermaidFlowEngineContract.mjs` runs the same operations
 * over the whole corpus with the installed library as the judge, and the exact
 * texts below were first produced by that run.
 *
 * The four ways the builder this replaces changed a diagram without saying so,
 * and the `linkStyle` failure, each have a describe of their own at the end.
 */
import { MERMAID_FLOW_CORPUS } from './MermaidFlowCorpus.fixture'
import { loadMermaidFlowGrammar, type MermaidFlowReading, parseMermaidFlowSource } from './MermaidFlowDoc'
import {
  addMermaidFlowGroup,
  addMermaidFlowLink,
  addMermaidFlowNode,
  deleteMermaidFlowNode,
  isMermaidFlowBracketShape,
  isMermaidFlowUndrawnShape,
  MERMAID_FLOW_BRACKET_SHAPES,
  MERMAID_FLOW_UNDRAWN_SHAPES,
  mermaidFlowArrow,
  type MermaidFlowBracketShape,
  mermaidFlowIdProblem,
  type MermaidFlowLinkEnds,
  mermaidFlowLinkLookOf,
  type MermaidFlowLinkStroke,
  moveMermaidFlowNode,
  nextMermaidFlowId,
  relabelMermaidFlowNode,
  removeMermaidFlowGroup,
  removeMermaidFlowLink,
  renameMermaidFlowNode,
  reshapeMermaidFlowNode,
  restyleMermaidFlowLink,
  retargetMermaidFlowLink,
  retitleMermaidFlowGroup,
  setMermaidFlowDirection,
} from './MermaidFlowEdits'
import {
  applyMermaidFlowEdit,
  inspectMermaidFlowchart,
  type MermaidFlowEdit,
  type MermaidFlowEditOutcome,
  type MermaidFlowReadResult,
} from './MermaidOracle'

beforeAll(() => loadMermaidFlowGrammar())

const src = (...lines: string[]): string => lines.join('\n')
const BACKSLASH = String.fromCharCode(92)
const BACKTICK = String.fromCharCode(96)

/** The builder's own reading standing in for mermaid's. */
const read = async (text: string): Promise<MermaidFlowReadResult> => {
  const { reading, problem } = parseMermaidFlowSource(text)
  return reading ? { ok: true, reading } : { ok: false, kind: 'rejected', message: problem?.message ?? 'unreadable' }
}

const readingOf = (source: string): MermaidFlowReading => {
  const { reading, problem } = parseMermaidFlowSource(source)
  if (!reading) {
    throw new Error(`a source this test needs read was refused: ${problem?.message}`)
  }
  return reading
}

/** The text after an edit that must be accepted. */
const edited = async (source: string, edit: MermaidFlowEdit): Promise<string> => {
  const outcome = await applyMermaidFlowEdit(source, edit, read)
  if (!outcome.ok) {
    throw new Error(`refused at "${outcome.stage}": ${outcome.reason} ${outcome.details.join(' | ')}`)
  }
  return outcome.text
}

/** The refusal of an edit that must be refused by the operation itself. */
const refusal = async (
  source: string,
  edit: MermaidFlowEdit,
): Promise<Extract<MermaidFlowEditOutcome, { ok: false }>> => {
  const outcome = await applyMermaidFlowEdit(source, edit, read)
  if (outcome.ok) {
    throw new Error(`accepted, and wrote: ${JSON.stringify(outcome.text)}`)
  }
  expect(outcome.stage).toBe('refused')
  return outcome
}

const STARTER = src('graph TD', '  A[Start] --> B{Decision}', '  B -->|Yes| C[OK]', '  B -->|No| D[Rethink]')

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------
describe('giving a box other text', () => {
  it('replaces the label where it is written and nothing else', async () => {
    expect(await edited(STARTER, relabelMermaidFlowNode('A', 'Begin'))).toBe(
      src('graph TD', '  A[Begin] --> B{Decision}', '  B -->|Yes| C[OK]', '  B -->|No| D[Rethink]'),
    )
  })

  it('leaves plain text unquoted, and quotes text that would not survive unquoted', async () => {
    expect(await edited(STARTER, relabelMermaidFlowNode('B', 'Is it "ok"?'))).toBe(
      src('graph TD', '  A[Start] --> B{"Is it #quot;ok#quot;?"}', '  B -->|Yes| C[OK]', '  B -->|No| D[Rethink]'),
    )
    expect(await edited(src('flowchart LR', '  A[Start]'), relabelMermaidFlowNode('A', 'call(x) [now]'))).toBe(
      src('flowchart LR', '  A["call(x) [now]"]'),
    )
  })

  it('keeps a quoted label quoted and a markdown label markdown', async () => {
    expect(await edited(src('flowchart LR', '  A["Start"] --> B'), relabelMermaidFlowNode('A', 'Begin'))).toBe(
      src('flowchart LR', '  A["Begin"] --> B'),
    )
    const markdown = src('flowchart LR', `  A["${BACKTICK}**bold** text${BACKTICK}"] --> B`)
    expect(await edited(markdown, relabelMermaidFlowNode('A', 'now *this*'))).toBe(
      src('flowchart LR', `  A["${BACKTICK}now *this*${BACKTICK}"] --> B`),
    )
    expect((await refusal(markdown, relabelMermaidFlowNode('A', 'a ` b'))).reason).toBe(
      'A label written in markdown cannot contain a backtick.',
    )
  })

  it('gives a box that never had a label one, where the box is first written', async () => {
    expect(await edited(src('flowchart LR', '  A --> B', '  B --> C'), relabelMermaidFlowNode('B', 'End'))).toBe(
      src('flowchart LR', '  A --> B[End]', '  B --> C'),
    )
  })

  it('writes a blank label as a quoted space, which is how mermaid spells an empty one', async () => {
    const source = src('flowchart LR', '  A[Start] --> B')
    const text = await edited(source, relabelMermaidFlowNode('A', ''))
    expect(text).toBe(src('flowchart LR', '  A[" "] --> B'))
    expect(readingOf(text).nodes[0].text).toBe('')
  })

  it('declares a box that exists only because a style line names it', async () => {
    expect(
      await edited(src('flowchart LR', '  A --> B', '  style Z fill:#eee'), relabelMermaidFlowNode('Z', 'Zed')),
    ).toBe(src('flowchart LR', '  A --> B', '  Z[Zed]', '  style Z fill:#eee'))
  })

  it('refuses a box described with @{ … }, and says which line', async () => {
    const outcome = await refusal(
      src('flowchart TD', '  A@{ shape: cyl, label: "DB" } --> B'),
      relabelMermaidFlowNode('A', 'x'),
    )
    expect(outcome.reason).toBe(
      '"A" is described with @{ … }, which the builder does not edit; change its text in the code.',
    )
    expect(outcome.line).toBe(1)
  })

  it('refuses a box that is not there', async () => {
    expect((await refusal(STARTER, relabelMermaidFlowNode('Z', 'x'))).reason).toBe('There is no box called "Z".')
  })

  it('refuses text that would not be read as the text typed, before mermaid is asked', async () => {
    // Between quotes, text wrapped in backticks is a markdown string: mermaid
    // would drop the backticks and read the label as markdown. The operation
    // reads its own result and refuses; this never reaches the judge.
    const outcome = await refusal(src('flowchart LR', '  A[Start]'), relabelMermaidFlowNode('A', '`code`'))
    expect(outcome.reason).toMatch(/^The builder cannot do this without changing something else \(label of A: /)
  })
})

describe('drawing a box as another shape', () => {
  const brackets = Object.entries(MERMAID_FLOW_BRACKET_SHAPES) as [MermaidFlowBracketShape, readonly [string, string]][]

  it.each(brackets)('writes %s with its own brackets around the same label', async (shape, [open, close]) => {
    const text = await edited(src('flowchart LR', '  A[Start] --> B'), reshapeMermaidFlowNode('A', shape))
    expect(text).toBe(src('flowchart LR', `  A${open}Start${close} --> B`))
    expect(readingOf(text).nodes[0]).toMatchObject({ id: 'A', type: shape, text: 'Start' })
  })

  it('offers the fourteen shapes mermaid writes with brackets and draws', () => {
    expect(brackets).toHaveLength(14)
    expect(isMermaidFlowBracketShape('lean_left')).toBe(true)
    expect(isMermaidFlowBracketShape('cyl')).toBe(false)
    expect(isMermaidFlowBracketShape('toString')).toBe(false)
  })

  // Mermaid 11 reads `A(-x-)` as an ellipse and then cannot draw it: the whole
  // diagram becomes "No such shape: ellipse". Mermaid's READING of such a result
  // is exactly what was asked, so nothing downstream of the operation would stop
  // it; the operation is where it stops.
  it('never writes the ellipse, which mermaid reads and cannot draw', async () => {
    expect(isMermaidFlowBracketShape('ellipse')).toBe(false)
    expect(Object.keys(MERMAID_FLOW_UNDRAWN_SHAPES)).toEqual(['ellipse'])
    expect(['ellipse', 'round', 'toString', undefined].map(isMermaidFlowUndrawnShape)).toEqual([
      true,
      false,
      false,
      false,
    ])
    const asked = 'ellipse' as MermaidFlowBracketShape
    const reshaped = await refusal(src('flowchart LR', '  A[Start] --> B'), reshapeMermaidFlowNode('A', asked))
    expect(reshaped.reason).toBe(
      'Mermaid reads the shape "ellipse" and cannot draw it, so the builder does not set it.',
    )
    const added = await refusal(src('flowchart LR', '  A --> B'), addMermaidFlowNode({ label: 'Oval', shape: asked }))
    expect(added.reason).toBe('Mermaid reads the shape "ellipse" and cannot draw it, so the builder does not set it.')
    const unknown = await refusal(
      src('flowchart LR', '  A --> B'),
      reshapeMermaidFlowNode('A', 'constructor' as MermaidFlowBracketShape),
    )
    expect(unknown.reason).toBe('"constructor" is not a shape the builder sets.')
  })

  it('gives a box that is written as an ellipse another shape, which is the repair', async () => {
    const broken = src('flowchart LR', '  A(-Oval-) --> B')
    expect(readingOf(broken).nodes[0]).toMatchObject({ id: 'A', type: 'ellipse', text: 'Oval' })
    expect(await edited(broken, reshapeMermaidFlowNode('A', 'stadium'))).toBe(src('flowchart LR', '  A([Oval]) --> B'))
    // And its text can be changed where it stands: the builder does not make the diagram worse.
    expect(await edited(broken, relabelMermaidFlowNode('A', 'Egg'))).toBe(src('flowchart LR', '  A(-Egg-) --> B'))
  })

  it('quotes a label that is only safe between plain brackets', async () => {
    expect(await edited(src('flowchart TD', '  A[a/b c] --> B'), reshapeMermaidFlowNode('A', 'lean_right'))).toBe(
      src('flowchart TD', '  A[/"a/b c"/] --> B'),
    )
  })

  it('gives a box that was never drawn as anything brackets around its id', async () => {
    expect(await edited(src('flowchart LR', '  A --> B'), reshapeMermaidFlowNode('B', 'diamond'))).toBe(
      src('flowchart LR', '  A --> B{B}'),
    )
  })

  it('changes the LAST shape a box is given, because that is the one mermaid draws', async () => {
    const source = src('flowchart LR', '  A(Round) --> B', '  A[Box later]')
    expect(await edited(source, reshapeMermaidFlowNode('A', 'hexagon'))).toBe(
      src('flowchart LR', '  A(Round) --> B', '  A{{Box later}}'),
    )
  })

  it('refuses a box whose shape is set with @{ … }', async () => {
    const outcome = await refusal(src('flowchart TD', '  A@{ shape: cyl } --> B'), reshapeMermaidFlowNode('A', 'round'))
    expect(outcome.reason).toBe(
      '"A" is described with @{ … }, which the builder does not edit; change its shape in the code.',
    )
  })
})

describe('calling a box something else', () => {
  it('renames it in every statement that names it, and in no comment and no label', async () => {
    const source = src(
      'flowchart LR',
      '  A[One] --> B[A is here]',
      '  %% A is first',
      '  class A,B hot',
      '  style A fill:#eee',
      '  click A href "https://a.example"',
      '  classDef hot fill:#f96',
    )
    expect(await edited(source, renameMermaidFlowNode('A', 'First'))).toBe(
      src(
        'flowchart LR',
        '  First[One] --> B[A is here]',
        '  %% A is first',
        '  class First,B hot',
        '  style First fill:#eee',
        '  click First href "https://a.example"',
        '  classDef hot fill:#f96',
      ),
    )
  })

  it('makes the new name the box’s text when the box had no label of its own', async () => {
    const text = await edited(src('flowchart LR', '  A --> B'), renameMermaidFlowNode('A', 'Start'))
    expect(text).toBe(src('flowchart LR', '  Start --> B'))
    expect(readingOf(text).nodes[0]).toMatchObject({ id: 'Start', text: 'Start' })
  })

  it('puts a space after an arrow that an id starting with o or x would otherwise join', async () => {
    // `A---ok` is a link with a circle on its end to a box called k.
    expect(await edited(src('flowchart LR', '  A---B'), renameMermaidFlowNode('B', 'ok'))).toBe(
      src('flowchart LR', '  A--- ok'),
    )
  })

  it.each([
    ['', 'A box needs a name.'],
    ['my box', 'Use letters, digits and _ for a name, starting with a letter.'],
    ['2nd', 'Use letters, digits and _ for a name, starting with a letter.'],
    ['a-b', 'Use letters, digits and _ for a name, starting with a letter.'],
    ['end', '"end" is a word mermaid keeps for itself.'],
    ['subgraph', '"subgraph" is a word mermaid keeps for itself.'],
    ['x', '"x" is a word mermaid keeps for itself.'],
    ['L_A_B_0', '"L_A_B_0" is a name mermaid makes up for its own use.'],
    ['A', 'There is already a box called "A".'],
    ['g', 'There is already a group called "g".'],
    ['hot', '"hot" is already the name of a style.'],
  ])('refuses the name "%s"', async (name, reason) => {
    const source = src('flowchart LR', '  A --> B', '  subgraph g', '    C', '  end', '  classDef hot fill:#f96')
    expect((await refusal(source, renameMermaidFlowNode('B', name))).reason).toBe(reason)
  })

  it('does nothing when the name is the one it has', async () => {
    const source = src('flowchart LR', '  A --> B')
    expect(await edited(source, renameMermaidFlowNode('B', ' B '))).toBe(source)
  })
})

describe('adding a box', () => {
  it('writes it after the last box or link, before the lines that only style', async () => {
    const source = src('flowchart LR', '  A --> B', '  B --> C', '  classDef hot fill:#f96', '  class A hot')
    expect(await edited(source, addMermaidFlowNode({ label: 'New box' }))).toBe(
      src('flowchart LR', '  A --> B', '  B --> C', '  D[New box]', '  classDef hot fill:#f96', '  class A hot'),
    )
  })

  it('writes the shape asked for, and quotes a label that needs it', async () => {
    expect(
      await edited(src('flowchart LR', '  A --> B'), addMermaidFlowNode({ label: 'Is it (ok)?', shape: 'diamond' })),
    ).toBe(src('flowchart LR', '  A --> B', '  C{"Is it (ok)?"}'))
  })

  it('writes it inside a group, with the group’s own indentation', async () => {
    const source = src('flowchart TB', '  subgraph one [One]', '    a1 --> a2', '  end', '  c1 --> a2')
    const text = await edited(source, addMermaidFlowNode({ label: 'Inside', group: 'one' }))
    expect(text).toBe(
      src('flowchart TB', '  subgraph one [One]', '    a1 --> a2', '    A[Inside]', '  end', '  c1 --> a2'),
    )
    expect(readingOf(text).groups[0].nodes.sort()).toEqual(['A', 'a1', 'a2'])
  })

  it('writes it inside a group that has nothing in it yet', async () => {
    expect(
      await edited(
        src('flowchart TB', '  subgraph one [One]', '  end', '  c1'),
        addMermaidFlowNode({ label: 'Inside', group: 'one' }),
      ),
    ).toBe(src('flowchart TB', '  subgraph one [One]', '    A[Inside]', '  end', '  c1'))
  })

  it('writes a linked box as one line, straight after the last line that names the box it hangs from', async () => {
    expect(await edited(STARTER, addMermaidFlowNode({ label: 'Next', linkFrom: 'A' }))).toBe(
      src('graph TD', '  A[Start] --> B{Decision}', '  A --> E[Next]', '  B -->|Yes| C[OK]', '  B -->|No| D[Rethink]'),
    )
  })

  it('links it the other way round, with the link drawn and worded as asked', async () => {
    const source = src('graph TD', '  A[Start] --> B{Decision}', '  B -->|Yes| C[OK]')
    expect(
      await edited(
        source,
        addMermaidFlowNode({
          label: 'Before',
          linkTo: 'B',
          shape: 'round',
          linkLabel: 'then',
          look: { stroke: 'dotted', ends: 'arrow', length: 1 },
        }),
      ),
    ).toBe(src('graph TD', '  A[Start] --> B{Decision}', '  B -->|Yes| C[OK]', '  D(Before) -.->|then| B'))
  })

  it('puts a box linked from a grouped box in that box’s group', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a1 --> a2', '  end', '  c1 --> a2')
    const text = await edited(source, addMermaidFlowNode({ label: 'Three', linkFrom: 'a1' }))
    expect(text).toBe(
      src('flowchart TB', '  subgraph one', '    a1 --> a2', '    a1 --> A[Three]', '  end', '  c1 --> a2'),
    )
    expect(readingOf(text).groups[0].nodes.sort()).toEqual(['A', 'a1', 'a2'])
  })

  it('moves the numbers of the linkStyle lines when the new link lands before a styled one', async () => {
    const source = src('flowchart LR', '  A --> B', '  B --> C', '  linkStyle 1 stroke:#f00')
    const text = await edited(source, addMermaidFlowNode({ label: 'N', linkFrom: 'A' }))
    expect(text).toBe(src('flowchart LR', '  A --> B', '  A --> D[N]', '  B --> C', '  linkStyle 2 stroke:#f00'))
    expect(readingOf(text).edges.map((edge) => [edge.start, edge.end, edge.style])).toEqual([
      ['A', 'B', undefined],
      ['A', 'D', undefined],
      ['B', 'C', ['stroke:#f00', 'fill:none']],
    ])
  })

  it('keeps the text’s own line ending, and does not add one to a text that ends without', async () => {
    expect(await edited('flowchart LR\r\n  A --> B', addMermaidFlowNode({ label: 'C box', id: 'C' }))).toBe(
      'flowchart LR\r\n  A --> B\r\n  C[C box]',
    )
    expect(await edited('flowchart LR\n  A --> B\n', addMermaidFlowNode({ label: 'C box', id: 'C' }))).toBe(
      'flowchart LR\n  A --> B\n  C[C box]\n',
    )
  })

  it('starts a diagram that is only a header', async () => {
    expect(await edited('flowchart LR', addMermaidFlowNode({ label: 'First' }))).toBe('flowchart LR\n  A[First]')
  })

  it('names it with the next free letter, passing over names in use and names mermaid keeps', () => {
    expect(nextMermaidFlowId(readingOf(src('flowchart LR', '  A --> B', '  D')))).toBe('C')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').join(' & ')
    expect(nextMermaidFlowId(readingOf(src('flowchart LR', `  ${alphabet}`)))).toBe('A1')
    expect(nextMermaidFlowId(readingOf(src('flowchart LR', '  subgraph G1', '    A', '  end')), 'group')).toBe('G2')
    expect(mermaidFlowIdProblem('A', readingOf(src('flowchart LR', '  A')))).toBe('There is already a box called "A".')
    expect(mermaidFlowIdProblem('Fine_1', readingOf(src('flowchart LR', '  A')))).toBeNull()
  })

  it('refuses a name that is taken, a group that is not there, and a link from a box that is not there', async () => {
    expect((await refusal(STARTER, addMermaidFlowNode({ label: 'x', id: 'B' }))).reason).toBe(
      'There is already a box called "B".',
    )
    expect((await refusal(STARTER, addMermaidFlowNode({ label: 'x', group: 'nowhere' }))).reason).toBe(
      'There is no group called "nowhere".',
    )
    expect((await refusal(STARTER, addMermaidFlowNode({ label: 'x', linkFrom: 'Z' }))).reason).toBe(
      'There is no box called "Z".',
    )
  })
})

describe('taking a box out', () => {
  it('takes its links, its style lines and its place in the others with it, and renumbers what is left', async () => {
    const source = src(
      'flowchart LR',
      '  A[One] --> B[Two]',
      '  B --> C',
      '  C --> A',
      '  style B fill:#eee',
      '  class A,B hot',
      '  click B href "https://b.example"',
      '  linkStyle 2 stroke:#f00',
      '  classDef hot fill:#f96',
    )
    const text = await edited(source, deleteMermaidFlowNode('B'))
    expect(text).toBe(
      src(
        'flowchart LR',
        '  A[One]',
        '  C --> A',
        '  class A hot',
        '  linkStyle 0 stroke:#f00',
        '  classDef hot fill:#f96',
      ),
    )
    // The link that was number 2 is number 0 now, and still the red one.
    expect(readingOf(text).edges).toMatchObject([{ start: 'C', end: 'A', style: ['stroke:#f00', 'fill:none'] }])
  })

  it('closes a chain over the box that went, without linking its neighbours', async () => {
    const text = await edited(src('flowchart LR', '  A --> B --> C', '  D'), deleteMermaidFlowNode('B'))
    expect(text).toBe(src('flowchart LR', '  A & C', '  D'))
    expect(readingOf(text).edges).toEqual([])
  })

  it('takes it out of a fan and leaves the rest of the fan as it was', async () => {
    expect(await edited(src('flowchart LR', '  A & B --> C & D --> E'), deleteMermaidFlowNode('C'))).toBe(
      src('flowchart LR', '  A & B --> D --> E'),
    )
  })

  it('removes a line that was only that box', async () => {
    expect(await edited(src('flowchart LR', '  A --> B', '  C[Alone]'), deleteMermaidFlowNode('C'))).toBe(
      src('flowchart LR', '  A --> B'),
    )
  })
})

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
describe('how a link is written', () => {
  const strokes: MermaidFlowLinkStroke[] = ['normal', 'thick', 'dotted', 'invisible']
  const ends: MermaidFlowLinkEnds[] = [
    'none',
    'arrow',
    'circle',
    'cross',
    'both-arrows',
    'both-circles',
    'both-crosses',
  ]

  it('reads back as the look it was written from, for every stroke, end and length', () => {
    for (const stroke of strokes) {
      for (const end of stroke === 'invisible' ? (['none'] as MermaidFlowLinkEnds[]) : ends) {
        for (const length of [1, 2, 3]) {
          const arrow = mermaidFlowArrow({ stroke, ends: end, length })
          const edge = readingOf(src('flowchart LR', `  A ${arrow} B`)).edges[0]
          expect([arrow, mermaidFlowLinkLookOf(edge)]).toEqual([arrow, { stroke, ends: end, length }])
        }
      }
    }
  })

  it.each([
    ['normal', 'arrow', 1, '-->'],
    ['normal', 'none', 1, '---'],
    ['normal', 'arrow', 2, '--->'],
    ['normal', 'circle', 1, '--o'],
    ['normal', 'both-arrows', 1, '<-->'],
    ['normal', 'both-crosses', 1, 'x--x'],
    ['thick', 'arrow', 1, '==>'],
    ['thick', 'none', 1, '==='],
    ['dotted', 'arrow', 1, '-.->'],
    ['dotted', 'none', 2, '-..-'],
    ['dotted', 'both-circles', 1, 'o-.-o'],
    ['invisible', 'none', 1, '~~~'],
  ] as [MermaidFlowLinkStroke, MermaidFlowLinkEnds, number, string][])(
    '%s, %s, length %i is %s',
    (stroke, end, length, arrow) => {
      expect(mermaidFlowArrow({ stroke, ends: end, length })).toBe(arrow)
    },
  )

  it('does not describe a link drawn in a way it has no word for', () => {
    expect(mermaidFlowLinkLookOf({ type: 'INVALID', stroke: 'INVALID', length: undefined })).toBeNull()
  })
})

describe('linking two boxes', () => {
  it('writes the link after the last line that names either box', async () => {
    const source = src('flowchart LR', '  A --> B', '  B --> C', '  classDef hot fill:#f96')
    expect(await edited(source, addMermaidFlowLink('C', 'A'))).toBe(
      src('flowchart LR', '  A --> B', '  B --> C', '  C --> A', '  classDef hot fill:#f96'),
    )
  })

  it('draws and words it as asked', async () => {
    expect(
      await edited(
        src('flowchart LR', '  A --> B', '  B --> C'),
        addMermaidFlowLink('A', 'C', { look: { stroke: 'thick', ends: 'both-arrows', length: 2 }, label: 'both ways' }),
      ),
    ).toBe(src('flowchart LR', '  A --> B', '  B --> C', '  A <===>|both ways| C'))
  })

  it('writes a link between two boxes of one group inside that group', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a1 --> a2', '    a3', '  end', '  c1 --> a2')
    const text = await edited(source, addMermaidFlowLink('a1', 'a3'))
    expect(text).toBe(
      src('flowchart TB', '  subgraph one', '    a1 --> a2', '    a3', '    a1 --> a3', '  end', '  c1 --> a2'),
    )
  })

  it('writes a link between boxes of different groups outside both, so that neither box changes group', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a1', '  end', '  subgraph two', '    b1', '  end', '  z')
    const text = await edited(source, addMermaidFlowLink('a1', 'b1'))
    expect(text).toBe(
      src(
        'flowchart TB',
        '  subgraph one',
        '    a1',
        '  end',
        '  subgraph two',
        '    b1',
        '  end',
        '  a1 --> b1',
        '  z',
      ),
    )
    expect(readingOf(text).groups.map((group) => [group.id, group.nodes])).toEqual([
      ['one', ['a1']],
      ['two', ['b1']],
    ])
  })

  it('moves the numbers of the linkStyle lines past the new link', async () => {
    const source = src(
      'flowchart LR',
      '  A --> B',
      '  C --> D',
      '  linkStyle 1 stroke:#f00',
      '  linkStyle 0,1 stroke-width:2px',
    )
    expect(await edited(source, addMermaidFlowLink('A', 'B'))).toBe(
      src(
        'flowchart LR',
        '  A --> B',
        '  A --> B',
        '  C --> D',
        '  linkStyle 2 stroke:#f00',
        '  linkStyle 0,2 stroke-width:2px',
      ),
    )
  })

  it('refuses a box that is not there', async () => {
    expect((await refusal(STARTER, addMermaidFlowLink('A', 'Z'))).reason).toBe('There is no box called "Z".')
  })
})

describe('taking a link out', () => {
  it('leaves the two boxes, with everything they were written with', async () => {
    expect(await edited(src('flowchart LR', '  A[Start] --> B[End]'), removeMermaidFlowLink(0))).toBe(
      src('flowchart LR', '  A[Start] & B[End]'),
    )
  })

  it('removes the whole line when both boxes are written elsewhere', async () => {
    expect(await edited(src('flowchart LR', '  A[Start] --> B[End]', '  A --> B'), removeMermaidFlowLink(1))).toBe(
      src('flowchart LR', '  A[Start] --> B[End]'),
    )
  })

  it('cuts a chain in two', async () => {
    const chain = src('flowchart LR', '  A --> B --> C')
    expect(await edited(chain, removeMermaidFlowLink(0))).toBe(src('flowchart LR', '  A', '  B --> C'))
    expect(await edited(chain, removeMermaidFlowLink(1))).toBe(src('flowchart LR', '  A --> B', '  C'))
  })

  it('takes one link out of a fan and keeps the box it went to in its place', async () => {
    const fan = src('flowchart TD', '  A --> B & C')
    expect(await edited(fan, removeMermaidFlowLink(0))).toBe(src('flowchart TD', '  A & B', '  A --> C'))
    expect(await edited(fan, removeMermaidFlowLink(1))).toBe(src('flowchart TD', '  A --> B', '  C'))
    // …and does not keep a box that is written elsewhere.
    expect(await edited(src('flowchart TD', '  B', '  C', '  A --> B & C'), removeMermaidFlowLink(0))).toBe(
      src('flowchart TD', '  B', '  C', '  A --> C'),
    )
  })

  it('takes one link out of a fan on both sides, keeping the others in mermaid’s order', async () => {
    const text = await edited(src('flowchart LR', '  A & B --> C & D'), removeMermaidFlowLink(1))
    expect(readingOf(text).edges.map((edge) => edge.start + edge.end)).toEqual(['AC', 'BC', 'BD'])
    expect(readingOf(text).nodes.map((node) => node.id)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('takes one of several statements on a line and leaves the others on it', async () => {
    expect(await edited('graph TD; A-->B; B-->C', removeMermaidFlowLink(0))).toBe('graph TD; A; B-->C')
  })

  it('takes a named link’s own statement with it, which would otherwise start making a box', async () => {
    const source = src('flowchart LR', '  A e1@--> B', '  e1@{ animate: true }', '  B --> C')
    const text = await edited(source, removeMermaidFlowLink(0))
    expect(text).toBe(src('flowchart LR', '  A', '  B --> C'))
    expect(readingOf(text).nodes.map((node) => node.id)).toEqual(['A', 'B', 'C'])
  })

  it('refuses a link number that does not exist', async () => {
    expect((await refusal(STARTER, removeMermaidFlowLink(3))).reason).toBe('There is no link number 3.')
    expect((await refusal(STARTER, removeMermaidFlowLink(-1))).reason).toBe('There is no link number -1.')
  })
})

describe('pointing a link at another box', () => {
  it('changes the name where the link is written', async () => {
    expect(
      await edited(
        src('flowchart LR', '  A[Start] --> B', '  B --> C', '  C --> D'),
        retargetMermaidFlowLink(0, { to: 'C' }),
      ),
    ).toBe(src('flowchart LR', '  A[Start] --> C', '  B --> C', '  C --> D'))
  })

  it('keeps the box it left, with its label, when that was the only place it was written', async () => {
    expect(
      await edited(src('flowchart LR', '  A --> B[End]', '  C --> D'), retargetMermaidFlowLink(0, { from: 'C' })),
    ).toBe(src('flowchart LR', '  A', '  C --> B[End]', '  C --> D'))
  })

  it('takes one link of a fan and writes it on a line of its own', async () => {
    const text = await edited(src('flowchart TD', '  A --> B & C', '  D'), retargetMermaidFlowLink(1, { to: 'D' }))
    expect(text).toBe(src('flowchart TD', '  A --> B', '  C', '  A --> D', '  D'))
    expect(readingOf(text).edges.map((edge) => edge.start + edge.end)).toEqual(['AB', 'AD'])
  })

  it('refuses to pull a box into the group the link is written in', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a1 --> a2', '  end', '  z')
    const outcome = await refusal(source, retargetMermaidFlowLink(0, { to: 'z' }))
    expect(outcome.reason).toBe('This link is written inside a group "z" is not in; remove it and add a new one.')
    expect(outcome.line).toBe(2)
  })
})

describe('changing how a link is drawn, or what it says', () => {
  const source = src('flowchart LR', '  A --> B', '  B -->|maybe| C')

  it('rewrites the arrow in place', async () => {
    expect(await edited(source, restyleMermaidFlowLink(0, { stroke: 'dotted' }))).toBe(
      src('flowchart LR', '  A -.-> B', '  B -->|maybe| C'),
    )
    expect(await edited(source, restyleMermaidFlowLink(0, { length: 3, ends: 'circle' }))).toBe(
      src('flowchart LR', '  A ----o B', '  B -->|maybe| C'),
    )
  })

  it('keeps the link’s text when only the arrow changes', async () => {
    expect(await edited(source, restyleMermaidFlowLink(1, { stroke: 'thick', ends: 'none' }))).toBe(
      src('flowchart LR', '  A --> B', '  B ===|maybe| C'),
    )
  })

  it('replaces the text where it is written, between pipes or inside the arrow', async () => {
    expect(await edited(source, restyleMermaidFlowLink(1, { label: 'surely' }))).toBe(
      src('flowchart LR', '  A --> B', '  B -->|surely| C'),
    )
    expect(await edited(src('flowchart LR', '  A -- yes --> B'), restyleMermaidFlowLink(0, { label: 'no way' }))).toBe(
      src('flowchart LR', '  A -- no way --> B'),
    )
  })

  it('moves text that cannot be written inside an arrow between pipes', async () => {
    // A dash inside `-- … -->` would end the text.
    expect(await edited(src('flowchart LR', '  A -- yes --> B'), restyleMermaidFlowLink(0, { label: 'a-b' }))).toBe(
      src('flowchart LR', '  A -->|a-b| B'),
    )
  })

  it('gives a link text, and takes it away', async () => {
    expect(await edited(source, restyleMermaidFlowLink(0, { label: 'go' }))).toBe(
      src('flowchart LR', '  A -->|go| B', '  B -->|maybe| C'),
    )
    expect(await edited(source, restyleMermaidFlowLink(1, { label: '' }))).toBe(
      src('flowchart LR', '  A --> B', '  B --> C'),
    )
    expect(await edited(src('flowchart LR', '  A -- yes --> B'), restyleMermaidFlowLink(0, { label: ' ' }))).toBe(
      src('flowchart LR', '  A --> B'),
    )
  })

  it('quotes link text that needs it', async () => {
    const text = await edited(source, restyleMermaidFlowLink(0, { label: 'a | "b"' }))
    expect(text).toBe(src('flowchart LR', '  A -->|"a | #quot;b#quot;"| B', '  B -->|maybe| C'))
  })

  it('writes one link of a fan on a line of its own, and leaves the others drawn as they were', async () => {
    const text = await edited(src('flowchart TD', '  A --> B & C'), restyleMermaidFlowLink(1, { stroke: 'thick' }))
    expect(text).toBe(src('flowchart TD', '  A --> B', '  A ==> C'))
    expect(readingOf(text).edges.map((edge) => edge.stroke)).toEqual(['normal', 'thick'])
  })

  it('keeps the id a link is written with', async () => {
    expect(
      await edited(
        src('flowchart LR', '  A e1@--> B', '  e1@{ animate: true }'),
        restyleMermaidFlowLink(0, { stroke: 'dotted' }),
      ),
    ).toBe(src('flowchart LR', '  A e1@-.-> B', '  e1@{ animate: true }'))
  })

  it('draws an invisible link with no heads, whatever was asked', async () => {
    expect(await edited(source, restyleMermaidFlowLink(0, { stroke: 'invisible', ends: 'arrow' }))).toBe(
      src('flowchart LR', '  A ~~~ B', '  B -->|maybe| C'),
    )
  })
})

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
describe('putting boxes in a new group', () => {
  it('writes the group after the boxes and names them in it; no line moves', async () => {
    const source = src('flowchart LR', '  A --> B', '  B --> C', '  classDef hot fill:#f96')
    const text = await edited(source, addMermaidFlowGroup({ title: 'First two', members: ['A', 'B'] }))
    expect(text).toBe(
      src(
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  subgraph G1[First two]',
        '    A',
        '    B',
        '  end',
        '  classDef hot fill:#f96',
      ),
    )
    expect(readingOf(text).groups).toMatchObject([{ id: 'G1', title: 'First two', nodes: ['A', 'B'] }])
  })

  it('writes a group of boxes that are in a group inside that group', async () => {
    const source = src('flowchart TB', '  subgraph outer [Outer]', '    a --> b', '    c', '  end')
    const text = await edited(source, addMermaidFlowGroup({ title: 'Inner', members: ['a', 'b'], id: 'inner' }))
    expect(text).toBe(
      src(
        'flowchart TB',
        '  subgraph outer [Outer]',
        '    a --> b',
        '    c',
        '    subgraph inner[Inner]',
        '      a',
        '      b',
        '    end',
        '  end',
      ),
    )
    expect(readingOf(text).groups.map((group) => [group.id, [...group.nodes].sort()])).toEqual([
      ['inner', ['a', 'b']],
      ['outer', ['c', 'inner']],
    ])
  })

  it('makes an empty group', async () => {
    expect(await edited(src('flowchart LR', '  A --> B'), addMermaidFlowGroup({ title: 'Later', members: [] }))).toBe(
      src('flowchart LR', '  A --> B', '  subgraph G1[Later]', '  end'),
    )
  })

  it('refuses boxes that are not together now', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a', '  end', '  b')
    expect((await refusal(source, addMermaidFlowGroup({ title: 'Both', members: ['a', 'b'] }))).reason).toBe(
      'These boxes are in different groups; a new group can only hold boxes that are together now.',
    )
  })

  it('refuses when a group that has no name of its own would be renamed by it', async () => {
    // Mermaid calls these subGraph0 and subGraph1 by counting; one more group
    // before them and they are subGraph1 and subGraph2.
    const source = src(
      'flowchart TB',
      '  subgraph "Phase one"',
      '    a --> b',
      '  end',
      '  subgraph Phase two',
      '    c',
      '  end',
    )
    const outcome = await refusal(source, addMermaidFlowGroup({ title: 'New', members: ['a'] }))
    expect(outcome.reason).toBe(
      'A group here has no name of its own, so mermaid names it by counting the groups; adding or removing a group would rename it. Give that group a name in the code first.',
    )
    expect(outcome.line).toBe(1)
  })
})

describe('taking a group away', () => {
  it('removes its two lines and what styled it, and leaves what was inside exactly where it is', async () => {
    const source = src(
      'flowchart TB',
      '  subgraph one [Title]',
      '    direction LR',
      '    a1 --> a2',
      '  end',
      '  c1 --> a2',
      '  style one fill:#eee',
    )
    const text = await edited(source, removeMermaidFlowGroup('one'))
    expect(text).toBe(src('flowchart TB', '    a1 --> a2', '  c1 --> a2'))
    expect(readingOf(text).groups).toEqual([])
  })

  it('hands what was inside to the group around it', async () => {
    const source = src(
      'flowchart TB',
      '  subgraph outer',
      '    subgraph inner',
      '      a --> b',
      '    end',
      '    c',
      '  end',
    )
    const text = await edited(source, removeMermaidFlowGroup('inner'))
    expect(text).toBe(src('flowchart TB', '  subgraph outer', '      a --> b', '    c', '  end'))
    expect(readingOf(text).groups.map((group) => [group.id, [...group.nodes].sort()])).toEqual([
      ['outer', ['a', 'b', 'c']],
    ])
  })

  it('refuses a group a link goes to', async () => {
    const outcome = await refusal(
      src('flowchart TB', '  subgraph one', '    a', '  end', '  one --> z'),
      removeMermaidFlowGroup('one'),
    )
    expect(outcome.reason).toBe('A link goes to or from the group "one"; remove that link first.')
    expect(outcome.line).toBe(4)
  })

  it('refuses when a box would fall into another group that also names it', async () => {
    const source = src(
      'flowchart TB',
      '  subgraph first',
      '    a --> b',
      '  end',
      '  subgraph second',
      '    b --> c',
      '  end',
    )
    expect((await refusal(source, removeMermaidFlowGroup('first'))).reason).toBe(
      'The builder cannot do this without changing something else (boxes in group second: expected ["c"], the result would read ["b","c"]).',
    )
  })

  it('refuses a group that is not there', async () => {
    expect((await refusal(STARTER, removeMermaidFlowGroup('one'))).reason).toBe('There is no group called "one".')
  })
})

describe('giving a group another title', () => {
  it('replaces a title written in brackets', async () => {
    expect(
      await edited(
        src('flowchart TB', '  subgraph one [Title here]', '    a', '  end'),
        retitleMermaidFlowGroup('one', 'Another'),
      ),
    ).toBe(src('flowchart TB', '  subgraph one [Another]', '    a', '  end'))
  })

  it('gives a group that is only an id a title in brackets, and keeps the id', async () => {
    const text = await edited(
      src('flowchart TB', '  subgraph one', '    a', '  end'),
      retitleMermaidFlowGroup('one', 'Has a title now'),
    )
    expect(text).toBe(src('flowchart TB', '  subgraph one[Has a title now]', '    a', '  end'))
    expect(readingOf(text).groups).toMatchObject([{ id: 'one', title: 'Has a title now' }])
  })

  it('writes out the id mermaid made for a group named only by its title, so the group stays the same group', async () => {
    const text = await edited(
      src('flowchart TB', '  subgraph "Phase one"', '    a', '  end'),
      retitleMermaidFlowGroup('subGraph0', 'Phase 1'),
    )
    expect(text).toBe(src('flowchart TB', '  subgraph subGraph0[Phase 1]', '    a', '  end'))
    expect(readingOf(text).groups).toMatchObject([{ id: 'subGraph0', title: 'Phase 1' }])
  })
})

describe('moving a box between groups', () => {
  it('names a box that is in no group inside the group: one new line', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a', '  end', '  b --> a')
    const text = await edited(source, moveMermaidFlowNode('b', 'one'))
    expect(text).toBe(src('flowchart TB', '  subgraph one', '    a', '    b', '  end', '  b --> a'))
    expect(readingOf(text).groups[0].nodes.sort()).toEqual(['a', 'b'])
  })

  it('takes a box out of its group: its links are written again after the group, where they name it', async () => {
    const source = src(
      'flowchart TB',
      '  subgraph one [One]',
      '    a1[First] --> a2',
      '    a2 --> a3',
      '  end',
      '  c1 --> a2',
      '  linkStyle 1 stroke:#f00',
    )
    const text = await edited(source, moveMermaidFlowNode('a2', null))
    expect(text).toBe(
      src(
        'flowchart TB',
        '  subgraph one [One]',
        '    a1[First]',
        '    a3',
        '  end',
        '  a1 --> a2',
        '  a2 --> a3',
        '  c1 --> a2',
        '  linkStyle 1 stroke:#f00',
      ),
    )
    const reading = readingOf(text)
    expect(reading.groups[0].nodes.sort()).toEqual(['a1', 'a3'])
    // The red link is still the one from a2 to a3.
    expect(reading.edges.filter((edge) => edge.style).map((edge) => edge.start + edge.end)).toEqual(['a2a3'])
  })

  it('declares a box that has no links after the group it left, with the label it had', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a1', '    a2[Second]', '  end')
    const text = await edited(source, moveMermaidFlowNode('a2', null))
    expect(text).toBe(src('flowchart TB', '  subgraph one', '    a1', '  end', '  a2[Second]'))
    expect(readingOf(text).nodes[1]).toMatchObject({ id: 'a2', text: 'Second' })
  })

  it('moves a box from one group to another', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a1 --> a2', '  end', '  subgraph two', '    b1', '  end')
    const text = await edited(source, moveMermaidFlowNode('a2', 'two'))
    expect(text).toBe(
      src(
        'flowchart TB',
        '  subgraph one',
        '    a1',
        '  end',
        '  subgraph two',
        '    b1',
        '    a2',
        '  end',
        '  a1 --> a2',
      ),
    )
    expect(readingOf(text).groups.map((group) => [group.id, [...group.nodes].sort()])).toEqual([
      ['one', ['a1']],
      ['two', ['a2', 'b1']],
    ])
  })

  it('keeps a link’s style with the link when moving it changes its number', async () => {
    const source = src(
      'flowchart TB',
      '  subgraph one',
      '    a1 --> a2',
      '    a1 --> a3',
      '  end',
      '  linkStyle 0 stroke:#f00',
      '  linkStyle 1 stroke:#0f0',
    )
    const text = await edited(source, moveMermaidFlowNode('a2', null))
    const styled = readingOf(text).edges.map((edge) => [edge.start + edge.end, edge.style?.[0]])
    expect(styled).toEqual([
      ['a1a3', 'stroke:#0f0'],
      ['a1a2', 'stroke:#f00'],
    ])
  })

  it('does nothing when the box is already there', async () => {
    const source = src('flowchart TB', '  subgraph one', '    a', '  end')
    expect(await edited(source, moveMermaidFlowNode('a', 'one'))).toBe(source)
  })

  it('refuses a box that another group also names', async () => {
    const source = src(
      'flowchart TB',
      '  subgraph first',
      '    a --> b',
      '  end',
      '  subgraph second',
      '    b --> c',
      '  end',
    )
    const outcome = await refusal(source, moveMermaidFlowNode('b', null))
    expect(outcome.reason).toBe('"b" is also written inside another group; move it in the code.')
    expect(outcome.line).toBe(5)
  })
})

describe('turning the diagram', () => {
  it('replaces the direction in the header', async () => {
    expect(await edited(src('graph TD', '  A --> B'), setMermaidFlowDirection('LR'))).toBe(src('graph LR', '  A --> B'))
    expect(await edited('graph TD; A-->B', setMermaidFlowDirection('BT'))).toBe('graph BT; A-->B')
  })

  it('writes one into a header that has none', async () => {
    expect(await edited(src('flowchart', '  A --> B'), setMermaidFlowDirection('RL'))).toBe(
      src('flowchart RL', '  A --> B'),
    )
  })
})

// ---------------------------------------------------------------------------
// What no operation may touch
// ---------------------------------------------------------------------------
describe('everything an operation does not own stays byte for byte', () => {
  const battery = (reading: MermaidFlowReading): [string, MermaidFlowEdit][] => {
    const ids = reading.nodes.map((node) => node.id)
    const first = ids[0]
    const last = ids[ids.length - 1]
    return [
      ['relabel', relabelMermaidFlowNode(first, 'Other text')],
      ['reshape', reshapeMermaidFlowNode(first, 'stadium')],
      ['rename', renameMermaidFlowNode(first, 'Renamed')],
      ['add a box', addMermaidFlowNode({ label: 'New' })],
      ['add a linked box', addMermaidFlowNode({ label: 'Next', linkFrom: last })],
      ['link', addMermaidFlowLink(first, last)],
      ['unlink', removeMermaidFlowLink(0)],
      ['retarget', retargetMermaidFlowLink(0, { to: last })],
      ['restyle', restyleMermaidFlowLink(0, { stroke: 'thick', label: 'x' })],
      ['delete', deleteMermaidFlowNode(last)],
      ['group', addMermaidFlowGroup({ title: 'G', members: [first] })],
      ['direction', setMermaidFlowDirection('RL')],
    ]
  }
  /**
   * Everything mermaid throws away before parsing — and so everything an edit
   * has no business reading, let alone writing. Each without the line ending
   * after it: taking the last line of a text away takes the line ending before
   * it, which for a comment on the line above is the one mermaid counts as the
   * comment's own.
   */
  const kept = (text: string): string[] =>
    parseMermaidFlowSource(text)
      .pieces.filter((piece) => piece.kind === 'frontmatter' || piece.kind === 'directive' || piece.kind === 'comment')
      .map((piece) => piece.text.replace(/(?:\r\n|\n|\r)$/, ''))

  const sources = MERMAID_FLOW_CORPUS.filter((entry) =>
    [
      'configuration the app does not honour',
      'a whole pipeline',
      'a whole pipeline, Windows line endings',
      'frontmatter title and config',
      'init directive',
      'comment mid-body',
      'two init directives and a wrap',
      'a comment at the very end and one at the start',
    ].includes(entry.name),
  )

  it('covers the texts it means to', () => {
    expect(sources).toHaveLength(8)
  })

  it.each(sources.map((entry) => [entry.name, entry.source]))(
    'the frontmatter, the directives and every comment of "%s" survive every operation',
    async (_name, source) => {
      const before = kept(source)
      expect(before.length).toBeGreaterThan(0)
      let accepted = 0
      for (const [, edit] of battery(readingOf(source))) {
        const outcome = await applyMermaidFlowEdit(source, edit, read)
        if (outcome.ok) {
          accepted++
          expect(kept(outcome.text)).toEqual(before)
        } else {
          expect(outcome.stage).toBe('refused')
        }
      }
      // Most of the battery, or this has stopped testing anything.
      expect(accepted).toBeGreaterThanOrEqual(9)
    },
  )

  it('leaves configuration the app does not honour in the text, exactly as it was written', async () => {
    const source =
      MERMAID_FLOW_CORPUS.find((entry) => entry.name === 'configuration the app does not honour')?.source ?? ''
    const text = await edited(source, addMermaidFlowNode({ label: 'New', linkFrom: 'C' }))
    const head = source.slice(0, source.indexOf('flowchart LR'))
    expect(head).toContain('themeCSS: ".node rect { fill: red }"')
    expect(head).toContain('fontFamily: "Comic Sans MS"')
    expect(head).toContain('htmlLabels: false')
    expect(head).toContain('actorFontFamily: monospace')
    expect(text.startsWith(head)).toBe(true)
    expect(text).toBe(source + '\n  C --> D[New]')
  })

  it('a text an edit was made to can be edited again', async () => {
    let text = STARTER
    const steps: MermaidFlowEdit[] = [
      addMermaidFlowNode({ label: 'Ship it', linkFrom: 'C' }),
      relabelMermaidFlowNode('E', 'Shipped'),
      addMermaidFlowGroup({ title: 'Happy path', members: ['C', 'E'] }),
      restyleMermaidFlowLink(3, { stroke: 'thick' }),
      renameMermaidFlowNode('D', 'Rework'),
      removeMermaidFlowLink(2),
      moveMermaidFlowNode('E', null),
    ]
    for (const step of steps) {
      text = await edited(text, step)
      expect((await inspectMermaidFlowchart(text, read)).ok).toBe(true)
    }
    expect(text).toBe(
      src(
        'graph TD',
        '  A[Start] --> B{Decision}',
        '  B -->|Yes| C[OK]',
        '  E[Shipped]',
        '  B ==>|No| Rework[Rethink]',
        '  subgraph G1[Happy path]',
        '    C',
        '  end',
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// The four silent corruptions, and the linkStyle failure
// ---------------------------------------------------------------------------
describe('corruption 1 — a slanted box or a trapezoid is not redrawn as a plain box', () => {
  const source = src(
    'flowchart TD',
    `  A[/Input/] --> B[${BACKSLASH}Output${BACKSLASH}]`,
    `  C[/Wide${BACKSLASH}] --> D[${BACKSLASH}Narrow/]`,
  )
  const shapes = (text: string) => readingOf(text).nodes.map((node) => [node.id, node.type, node.text])
  const slanted = [
    ['A', 'lean_right', 'Input'],
    ['B', 'lean_left', 'Output'],
    ['C', 'trapezoid', 'Wide'],
    ['D', 'inv_trapezoid', 'Narrow'],
  ]

  it('reads all four for what they are', () => {
    expect(shapes(source)).toEqual(slanted)
  })

  it.each([
    ['adding a box', addMermaidFlowNode({ label: 'New', id: 'N' })],
    ['adding a linked box', addMermaidFlowNode({ label: 'New', id: 'N', linkFrom: 'A' })],
    ['linking', addMermaidFlowLink('A', 'D')],
    ['taking a link out', removeMermaidFlowLink(0)],
    ['restyling a link', restyleMermaidFlowLink(1, { stroke: 'dotted' })],
    ['grouping', addMermaidFlowGroup({ title: 'G', members: ['A', 'B'] })],
    ['turning the diagram', setMermaidFlowDirection('LR')],
  ] as [string, MermaidFlowEdit][])(
    '%s leaves every one of them the shape and the text it had',
    async (_name, edit) => {
      const text = await edited(source, edit)
      expect(shapes(text).filter(([id]) => id !== 'N')).toEqual(slanted)
    },
  )

  it('giving one of them other text keeps its slashes', async () => {
    expect(await edited(source, relabelMermaidFlowNode('B', 'Out'))).toBe(
      src(
        'flowchart TD',
        `  A[/Input/] --> B[${BACKSLASH}Out${BACKSLASH}]`,
        `  C[/Wide${BACKSLASH}] --> D[${BACKSLASH}Narrow/]`,
      ),
    )
  })
})

describe('corruption 2 — a double circle is not redrawn as a circle labelled "(Stop)"', () => {
  const source = src('flowchart LR', '  A(((Stop))) --> B')

  it('reads it as a double circle labelled Stop', () => {
    expect(readingOf(source).nodes[0]).toMatchObject({ type: 'doublecircle', text: 'Stop' })
  })

  it('keeps it through an edit to anything else, and through its own relabel', async () => {
    expect(await edited(source, addMermaidFlowNode({ label: 'Next', linkFrom: 'B' }))).toBe(
      src('flowchart LR', '  A(((Stop))) --> B', '  B --> C[Next]'),
    )
    expect(await edited(source, relabelMermaidFlowNode('A', 'Halt'))).toBe(src('flowchart LR', '  A(((Halt))) --> B'))
    expect(await edited(source, removeMermaidFlowLink(0))).toBe(src('flowchart LR', '  A(((Stop))) & B'))
  })
})

describe('corruption 3 — a label given twice does not revert to the first', () => {
  const source = src('flowchart LR', '  A[Start] --> B', '  A[Renamed later]')

  it('reads the later label, as mermaid does', () => {
    expect(readingOf(source).nodes[0].text).toBe('Renamed later')
  })

  it('keeps the later label through an edit to anything else', async () => {
    const text = await edited(source, addMermaidFlowNode({ label: 'New', linkFrom: 'B' }))
    expect(text).toBe(src('flowchart LR', '  A[Start] --> B', '  B --> C[New]', '  A[Renamed later]'))
    expect(readingOf(text).nodes[0].text).toBe('Renamed later')
  })

  it('edits the label that counts, and leaves the earlier one as it was written', async () => {
    const text = await edited(source, relabelMermaidFlowNode('A', 'Final'))
    expect(text).toBe(src('flowchart LR', '  A[Start] --> B', '  A[Final]'))
    expect(readingOf(text).nodes[0].text).toBe('Final')
  })
})

describe('corruption 4 — renaming a box never passes through another box’s name', () => {
  const source = src('flowchart LR', '  A --> B', '  C --> A')

  it('renames B to A2 in one step: A keeps its links', async () => {
    const text = await edited(source, renameMermaidFlowNode('B', 'A2'))
    expect(text).toBe(src('flowchart LR', '  A --> A2', '  C --> A'))
    expect(readingOf(text).edges.map((edge) => [edge.start, edge.end])).toEqual([
      ['A', 'A2'],
      ['C', 'A'],
    ])
  })

  it('refuses to rename B to A, which would merge the two, and leaves the text alone', async () => {
    const outcome = await applyMermaidFlowEdit(source, renameMermaidFlowNode('B', 'A'), read)
    expect(outcome).toEqual({
      ok: false,
      stage: 'refused',
      reason: 'There is already a box called "A".',
      line: undefined,
      details: [],
    })
  })
})

describe('the linkStyle failure — a link that goes takes its number with it, and every other link keeps its style', () => {
  const source = src(
    'flowchart LR',
    '  A --> B',
    '  B --> C',
    '  C --> D',
    '  linkStyle 1 stroke:#f00',
    '  linkStyle 0,2 stroke:#0f0',
  )
  /** Each link as "ends colour", which is what has to survive whatever the numbers become. */
  const colours = (text: string) =>
    readingOf(text).edges.map((edge) => `${edge.start}${edge.end} ${edge.style?.[0] ?? 'unstyled'}`)

  it('starts with the middle link red and the others green', () => {
    expect(colours(source)).toEqual(['AB stroke:#0f0', 'BC stroke:#f00', 'CD stroke:#0f0'])
  })

  it('taking the first link out renumbers both lines', async () => {
    const text = await edited(source, removeMermaidFlowLink(0))
    expect(text).toBe(
      src('flowchart LR', '  A', '  B --> C', '  C --> D', '  linkStyle 0 stroke:#f00', '  linkStyle 1 stroke:#0f0'),
    )
    expect(colours(text)).toEqual(['BC stroke:#f00', 'CD stroke:#0f0'])
  })

  it('taking the styled link out removes the line that styled only it', async () => {
    const text = await edited(source, removeMermaidFlowLink(1))
    expect(text).toBe(src('flowchart LR', '  A --> B', '  C --> D', '  linkStyle 0,1 stroke:#0f0'))
    expect(colours(text)).toEqual(['AB stroke:#0f0', 'CD stroke:#0f0'])
  })

  it('taking a box out renumbers past every link it took with it', async () => {
    const text = await edited(source, deleteMermaidFlowNode('B'))
    expect(text).toBe(src('flowchart LR', '  A', '  C --> D', '  linkStyle 0 stroke:#0f0'))
    expect(colours(text)).toEqual(['CD stroke:#0f0'])
  })

  it.each([
    ['removing link 0', removeMermaidFlowLink(0), ['BC stroke:#f00', 'CD stroke:#0f0']],
    ['removing link 2', removeMermaidFlowLink(2), ['AB stroke:#0f0', 'BC stroke:#f00']],
    ['deleting A', deleteMermaidFlowNode('A'), ['BC stroke:#f00', 'CD stroke:#0f0']],
    ['deleting C', deleteMermaidFlowNode('C'), ['AB stroke:#0f0']],
    ['deleting D', deleteMermaidFlowNode('D'), ['AB stroke:#0f0', 'BC stroke:#f00']],
    [
      'adding a link before them',
      addMermaidFlowNode({ label: 'N', id: 'N', linkFrom: 'A' }),
      ['AB stroke:#0f0', 'AN unstyled', 'BC stroke:#f00', 'CD stroke:#0f0'],
    ],
  ] as [string, MermaidFlowEdit, string[]][])(
    '%s leaves every surviving link the colour it had',
    async (_name, edit, expected) => {
      expect(colours(await edited(source, edit))).toEqual(expected)
    },
  )

  it('never leaves a linkStyle naming a link that is not there, which is what stopped the diagram drawing', async () => {
    for (const edit of [
      removeMermaidFlowLink(0),
      removeMermaidFlowLink(1),
      removeMermaidFlowLink(2),
      deleteMermaidFlowNode('B'),
    ]) {
      const text = await edited(source, edit)
      const count = readingOf(text).edges.length
      const numbers = [...text.matchAll(/linkStyle ([0-9,]+)/g)].flatMap((match) => match[1].split(',').map(Number))
      expect(numbers.every((number) => number < count)).toBe(true)
    }
  })
})
