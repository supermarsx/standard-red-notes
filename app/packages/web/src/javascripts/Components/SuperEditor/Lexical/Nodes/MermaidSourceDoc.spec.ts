/**
 * @jest-environment node
 *
 * The lossless document under a flowchart's text.
 *
 * Two different things are pinned here, and they are evidence of different
 * things:
 *
 *   1. PRINTING. Whatever text goes in comes out, byte for byte: the corpus,
 *      and every text that is one character short of a corpus entry — most of
 *      which are no longer valid mermaid. A builder that edits by replacing a
 *      few characters is only as safe as that property.
 *   2. WHERE THINGS ARE. For texts whose structure is plain to a reader, the
 *      spans the document reports are sliced back out of the source and
 *      compared with the characters a person would point at.
 *
 * What a text MEANS to mermaid is not decided here. This file can only say what
 * this module reads; `scripts/MermaidFlowEngineContract.mjs` asks the installed
 * library the same question about the same corpus and fails when the answers
 * differ.
 */
import { MERMAID_FLOW_COMMON_FORMS, MERMAID_FLOW_CORPUS } from './MermaidFlowCorpus.fixture'
import {
  compareMermaidFlowReadings,
  type MermaidFlowDocument,
  type MermaidFlowGroupStatement,
  type MermaidFlowReading,
  type MermaidFlowVertexStatement,
  type MermaidSourceSpan,
  mermaidSourceLineAt,
  parseMermaidFlowSource,
  plainMermaidLabel,
  printMermaidFlowDocument,
  unhandledMermaidFlowProductions,
} from './MermaidSourceDoc'

const src = (...lines: string[]): string => lines.join('\n')
const BACKSLASH = String.fromCharCode(92)

const cut = (document: MermaidFlowDocument, span: MermaidSourceSpan): string =>
  document.source.slice(span.start, span.end)

const read = (source: string): MermaidFlowDocument => {
  const document = parseMermaidFlowSource(source)
  if (document.problem) {
    throw new Error(`a source this test needs read was refused: ${document.problem.kind}: ${document.problem.message}`)
  }
  return document
}

const vertexStatement = (document: MermaidFlowDocument, index: number): MermaidFlowVertexStatement => {
  const statement = document.statements[index]
  if (statement.kind !== 'vertex') {
    throw new Error(`statement ${index} is a ${statement.kind} statement`)
  }
  return statement
}

const groupStatement = (document: MermaidFlowDocument, index: number): MermaidFlowGroupStatement => {
  const statement = document.statements[index]
  if (statement.kind !== 'group') {
    throw new Error(`statement ${index} is a ${statement.kind} statement`)
  }
  return statement
}

/** The first way the pieces fail to cover `source` exactly, or null. */
const coverageFault = (document: MermaidFlowDocument, source: string): string | null => {
  let cursor = 0
  for (const piece of document.pieces) {
    if (piece.start !== cursor) {
      return `a piece starts at ${piece.start} where ${cursor} was expected`
    }
    if (piece.end < piece.start) {
      return `a piece ends before it starts, at ${piece.start}`
    }
    if (source.slice(piece.start, piece.end) !== piece.text) {
      return `the piece at ${piece.start} does not carry its own characters`
    }
    cursor = piece.end
  }
  return cursor === source.length ? null : `the pieces stop at ${cursor} of ${source.length}`
}

describe('printing a document gives back the text it was read from', () => {
  it.each(MERMAID_FLOW_CORPUS.map((entry) => [entry.name, entry.source]))('%s', (_name, source) => {
    const document = parseMermaidFlowSource(source)
    expect(printMermaidFlowDocument(document)).toBe(source)
    expect(coverageFault(document, source)).toBeNull()
  })

  it('for every text that is one character short of a corpus entry, read or not', () => {
    let texts = 0
    let read = 0
    let refused = 0
    const faults: string[] = []
    for (const { name, source } of MERMAID_FLOW_CORPUS) {
      for (let index = 0; index < source.length; index++) {
        const text = source.slice(0, index) + source.slice(index + 1)
        const document = parseMermaidFlowSource(text)
        texts++
        if (document.problem) {
          refused++
        } else {
          read++
        }
        const fault =
          printMermaidFlowDocument(document) === text ? coverageFault(document, text) : 'printed differently'
        if (fault !== null && faults.length < 5) {
          faults.push(`${name}, without character ${index}: ${fault}`)
        }
      }
    }
    expect(faults).toEqual([])
    // Both outcomes, in numbers: a run in which nothing is refused (or nothing
    // is read) has stopped testing half of what it says.
    expect(texts).toBeGreaterThan(7000)
    expect(read).toBeGreaterThan(4000)
    expect(refused).toBeGreaterThan(2000)
  })

  it('for text that is not mermaid at all', () => {
    // A small generator with a fixed seed: the alphabet is the characters
    // mermaid's flowchart lexer cares about, so most strings are broken
    // half-statements. None may throw and none may print differently.
    const alphabet = [
      ...('AB xo-=.>|<&;:~#@%"()[]{}/' + BACKSLASH),
      '\n',
      '\r\n',
      '--',
      'graph ',
      'end',
      'subgraph ',
      '%%',
    ]
    let seed = 20261012
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    for (let round = 0; round < 1500; round++) {
      let text = round % 3 === 0 ? 'flowchart LR\n' : ''
      const length = next() % 40
      for (let index = 0; index < length; index++) {
        text += alphabet[next() % alphabet.length]
      }
      const document = parseMermaidFlowSource(text)
      expect(printMermaidFlowDocument(document)).toBe(text)
      expect(coverageFault(document, text)).toBeNull()
    }
  })

  it('keeps what mermaid throws away before parsing, as pieces of their own', () => {
    const source = src(
      '---',
      'title: T',
      '---',
      '%%{init: {"theme":"dark"}}%%',
      'flowchart LR',
      '  %% a comment',
      '  A --> B',
      '  style A fill:#f9f;',
    )
    const document = read(source)
    const kept = (kind: string) => document.pieces.filter((piece) => piece.kind === kind).map((piece) => piece.text)
    expect(kept('frontmatter')).toEqual(['---\ntitle: T\n---\n'])
    expect(kept('directive')).toEqual(['%%{init: {"theme":"dark"}}%%'])
    expect(kept('comment')).toEqual(['  %% a comment\n'])
    // The `;` mermaid drops from a style line that ends in a colour.
    expect(kept('semicolon')).toEqual([';'])
    expect(kept('unread')).toEqual([])
  })

  it('keeps a Windows line ending inside the token that stands for it', () => {
    const source = 'flowchart LR\r\n  A --> B\r\n'
    const document = read(source)
    const newlines = document.pieces.filter((piece) => piece.token === 'NEWLINE').map((piece) => piece.text)
    expect(newlines).toEqual(['\r\n', '\r\n'])
    expect(document.lines.map((line) => line.eol)).toEqual(['\r\n', '\r\n', ''])
  })
})

describe('the grammar it runs', () => {
  it('gives every production a meaning, so no statement is read by default rules', () => {
    expect(unhandledMermaidFlowProductions()).toEqual([])
  })

  it('reads every one of the 37 common ways of writing a flowchart', () => {
    const refused = MERMAID_FLOW_COMMON_FORMS.filter((entry) => parseMermaidFlowSource(entry.source).problem !== null)
    expect(refused.map((entry) => entry.name)).toEqual([])
    expect(MERMAID_FLOW_COMMON_FORMS).toHaveLength(37)
  })

  it('reads the whole corpus', () => {
    const refused = MERMAID_FLOW_CORPUS.filter((entry) => parseMermaidFlowSource(entry.source).problem !== null)
    expect(refused.map((entry) => entry.name)).toEqual([])
  })
})

describe('where a box is written', () => {
  it('finds the id, the brackets and the label of each mention', () => {
    const document = read(src('flowchart LR', '  A[Start] --> B{{Hex}}', '  C(("round")) --> D'))
    const [a, b] = vertexStatement(document, 0).groups.map((group) => group[0])
    expect([a.id, cut(document, a.idSpan), cut(document, a.span)]).toEqual(['A', 'A', 'A[Start]'])
    expect(a.shape && [a.shape.type, cut(document, a.shape.open), cut(document, a.shape.close)]).toEqual([
      'square',
      '[',
      ']',
    ])
    expect(a.shape && cut(document, a.shape.label.inner)).toBe('Start')
    expect(b.shape && [b.shape.type, cut(document, b.shape.open), cut(document, b.shape.close)]).toEqual([
      'hexagon',
      '{{',
      '}}',
    ])
    const [c, d] = vertexStatement(document, 1).groups.map((group) => group[0])
    // The quotes belong to the label as written, not to what mermaid is handed.
    expect(
      c.shape && [c.shape.type, cut(document, c.shape.label.inner), c.shape.label.text, c.shape.label.type],
    ).toEqual(['circle', '"round"', 'round', 'string'])
    expect(d.shape).toBeNull()
    expect(cut(document, d.full)).toBe('D')
  })

  it('names all fifteen bracket shapes as mermaid names them', () => {
    const shapes: [string, string][] = [
      ['A[x]', 'square'],
      ['A(x)', 'round'],
      ['A([x])', 'stadium'],
      ['A[[x]]', 'subroutine'],
      ['A[(x)]', 'cylinder'],
      ['A((x))', 'circle'],
      ['A>x]', 'odd'],
      ['A{x}', 'diamond'],
      ['A{{x}}', 'hexagon'],
      ['A[/x/]', 'lean_right'],
      [`A[${BACKSLASH}x${BACKSLASH}]`, 'lean_left'],
      [`A[/x${BACKSLASH}]`, 'trapezoid'],
      [`A[${BACKSLASH}x/]`, 'inv_trapezoid'],
      ['A(((x)))', 'doublecircle'],
      ['A(-x-)', 'ellipse'],
    ]
    for (const [written, type] of shapes) {
      const document = read(src('flowchart LR', '  ' + written))
      const mention = vertexStatement(document, 0).groups[0][0]
      expect([written, mention.shape?.type, mention.shape && cut(document, mention.shape.label.inner)]).toEqual([
        written,
        type,
        'x',
      ])
      expect(document.reading?.nodes).toEqual([
        { id: 'A', text: 'x', type, labelType: 'text', classes: [], styles: [] },
      ])
    }
  })

  it('keeps the class and the shape data that follow a box with that box', () => {
    const document = read(src('flowchart LR', '  A[One]:::hot --> B@{ shape: cyl }', '  classDef hot fill:#f96'))
    const [a, b] = vertexStatement(document, 0).groups.map((group) => group[0])
    expect(a.classes.map((entry) => [entry.name, cut(document, entry.span)])).toEqual([['hot', ':::hot']])
    expect(cut(document, a.full)).toBe('A[One]:::hot')
    expect(b.shapeData && cut(document, b.shapeData)).toBe('@{ shape: cyl }')
    expect(cut(document, b.full)).toBe('B@{ shape: cyl }')
    // What `@{…}` says is YAML this module does not read: the box is marked,
    // and its shape is left for mermaid to say.
    expect(document.reading?.nodes[1]).toMatchObject({ id: 'B', shapeData: true })
  })

  it('traces an entity code back to the characters it was typed as', () => {
    const source = src('flowchart LR', '  A["a #quot;q#quot; b"] --> B')
    const document = read(source)
    const label = vertexStatement(document, 0).groups[0][0].shape?.label
    expect(label && cut(document, label.inner)).toBe('"a #quot;q#quot; b"')
    // What mermaid's parser is handed has placeholders in it.
    expect(label?.text).toBe('a ﬂ°quot¶ßqﬂ°quot¶ß b')
  })

  it('gives the same spans under Windows line endings', () => {
    const document = read('flowchart LR\r\n  A[Start] -->|go| B\r\n  B --> C\r\n')
    const first = vertexStatement(document, 0)
    expect(cut(document, first.span)).toBe('A[Start] -->|go| B')
    expect(first.links[0].label && cut(document, first.links[0].label.inner)).toBe('go')
    expect([first.line, vertexStatement(document, 1).line]).toEqual([1, 2])
  })
})

describe('where a link is written, and which edges it stands for', () => {
  it('reads a chain as one statement with a link between each pair of groups', () => {
    const document = read(src('flowchart LR', '  A --> B --> C'))
    const statement = vertexStatement(document, 0)
    expect(statement.groups.map((group) => group.map((mention) => mention.id))).toEqual([['A'], ['B'], ['C']])
    expect(statement.links.map((link) => link.edges)).toEqual([[0], [1]])
    expect(document.edges).toEqual([
      { statement: 0, link: 0, start: 0, end: 0 },
      { statement: 0, link: 1, start: 0, end: 0 },
    ])
    expect(document.reading?.edges.map((edge) => [edge.start, edge.end])).toEqual([
      ['A', 'B'],
      ['B', 'C'],
    ])
  })

  it('expands a fan-out in mermaid’s order: every end for the first start, then the next start', () => {
    const document = read(src('flowchart LR', '  A & B --> C & D'))
    expect(document.reading?.edges.map((edge) => edge.start + edge.end)).toEqual(['AC', 'AD', 'BC', 'BD'])
    expect(document.edges.map((site) => [site.start, site.end])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ])
    expect(vertexStatement(document, 0).links[0].edges).toEqual([0, 1, 2, 3])
  })

  it('tells the three ways of writing a link’s text apart, and finds the text', () => {
    const document = read(src('flowchart LR', '  A --> B', '  B -->|pipe text| C', '  C -- inline text --> D'))
    const links = [0, 1, 2].map((index) => vertexStatement(document, index).links[0])
    expect(links.map((link) => link.form)).toEqual(['plain', 'pipe', 'inline'])
    expect(links.map((link) => link.label && cut(document, link.label.inner))).toEqual([
      null,
      'pipe text',
      'inline text',
    ])
    expect(links.map((link) => cut(document, link.span))).toEqual([' --> ', ' -->|pipe text| ', ' -- inline text --> '])
  })

  it.each([
    ['-->', 'arrow_point', 'normal', 1],
    ['---', 'arrow_open', 'normal', 1],
    ['--->', 'arrow_point', 'normal', 2],
    ['-.->', 'arrow_point', 'dotted', 1],
    ['-..->', 'arrow_point', 'dotted', 2],
    ['-.-', 'arrow_open', 'dotted', 1],
    ['==>', 'arrow_point', 'thick', 1],
    ['===', 'arrow_open', 'thick', 1],
    ['--o', 'arrow_circle', 'normal', 1],
    ['--x', 'arrow_cross', 'normal', 1],
    ['<-->', 'double_arrow_point', 'normal', 1],
    ['o--o', 'double_arrow_circle', 'normal', 1],
    ['x--x', 'double_arrow_cross', 'normal', 1],
    ['~~~', 'arrow_open', 'invisible', 1],
  ])('reads %s as %s, %s, length %i', (arrow, type, stroke, length) => {
    const document = read(src('flowchart LR', `  A ${arrow} B`))
    expect(document.reading?.edges[0]).toMatchObject({ start: 'A', end: 'B', type, stroke, length })
  })

  it('reads a line that starts with an arrow as the rest of the statement above it', () => {
    // Mermaid's link token takes the whitespace around it, newlines included.
    const document = read(src('flowchart LR', '  A --> B', '  x--> C'))
    expect(document.statements).toHaveLength(1)
    const statement = vertexStatement(document, 0)
    expect([statement.line, statement.endLine]).toEqual([1, 2])
    // Not a box called x: a link with a cross at its start, one rank longer.
    expect(document.reading?.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C'])
    expect(document.reading?.edges[1]).toMatchObject({ start: 'B', end: 'C', type: 'arrow_point', length: 2 })
  })

  it('keeps an id written before a link, and does not mistake it for a box', () => {
    const document = read(src('flowchart LR', '  A e1@--> B', '  e1@{ animate: true }'))
    expect(vertexStatement(document, 0).links[0].id).toBe('e1')
    expect(document.reading?.edges[0].id).toBe('e1')
    expect(document.reading?.nodes.map((node) => node.id)).toEqual(['A', 'B'])
  })
})

describe('groups', () => {
  const source = src(
    'flowchart TB',
    '  subgraph one [Title here]',
    '    direction LR',
    '    a1 --> a2',
    '  end',
    '  c1 --> a2',
  )

  it('finds the opening line, the id, the title and the closing word', () => {
    const document = read(source)
    const group = groupStatement(document, 0)
    expect(cut(document, group.opening)).toBe('subgraph one [Title here]')
    expect(cut(document, group.closing)).toBe('end')
    expect([group.id, group.idSpan && cut(document, group.idSpan)]).toEqual(['one', 'one'])
    expect(group.title && cut(document, group.title.inner)).toBe('Title here')
    expect(cut(document, group.span)).toBe(source.slice(source.indexOf('subgraph'), source.indexOf('end') + 3))
  })

  it('lists what is directly inside, and says of each statement which group it is in', () => {
    const document = read(source)
    expect(groupStatement(document, 0).body).toEqual([1, 2])
    expect(document.statements.map((statement) => [statement.kind, statement.parent])).toEqual([
      ['group', null],
      ['direction', 0],
      ['vertex', 0],
      ['vertex', null],
    ])
    expect(document.reading?.groups).toEqual([
      { id: 'one', title: 'Title here', nodes: ['a2', 'a1'], dir: 'LR', labelType: 'text', classes: [] },
    ])
  })

  it('gives a box to the first group that mentions it, as mermaid does', () => {
    const document = read(
      src('flowchart TB', '  subgraph first', '    a --> b', '  end', '  subgraph second', '    b --> c', '  end'),
    )
    expect(document.reading?.groups.map((group) => [group.id, group.nodes])).toEqual([
      ['first', ['b', 'a']],
      ['second', ['c']],
    ])
  })

  it('reports no written id for a group mermaid has to name itself', () => {
    const document = read(src('flowchart TB', '  subgraph "Phase one"', '    a', '  end'))
    const group = groupStatement(document, 0)
    expect([group.id, group.idSpan]).toEqual(['subGraph0', null])
    expect(group.name && cut(document, group.name.inner)).toBe('"Phase one"')
    expect(document.reading?.groups[0].title).toBe('Phase one')
  })

  it('nests', () => {
    const document = read(
      src('flowchart LR', '  subgraph outer', '    subgraph inner', '      a --> b', '    end', '    c --> a', '  end'),
    )
    expect(document.statements.map((statement) => [statement.kind, statement.parent])).toEqual([
      ['group', null],
      ['group', 0],
      ['vertex', 1],
      ['vertex', 0],
    ])
    // Mermaid registers the inner group first: it ends first.
    expect(document.reading?.groups.map((group) => [group.id, group.nodes])).toEqual([
      ['inner', ['b', 'a']],
      ['outer', ['inner', 'c']],
    ])
  })
})

describe('the statements that style and wire', () => {
  const source = src(
    'flowchart LR',
    '  A --> B --> C',
    '  style A fill:#f9f',
    '  class A,B hot',
    '  click C href "https://example.com" "tip"',
    '  linkStyle 0,1 stroke:#f00',
    '  linkStyle default stroke-width:2px',
    '  classDef hot fill:#f96',
  )

  it('finds each id they name, where it is written', () => {
    const document = read(source)
    const byKind = (kind: string) => document.statements.filter((statement) => statement.kind === kind)
    const [style] = byKind('style')
    expect(style.kind === 'style' && [style.target, cut(document, style.targetSpan)]).toEqual(['A', 'A'])
    const [classStatement] = byKind('class')
    expect(
      classStatement.kind === 'class' && [
        classStatement.targets.map((target) => [target.id, cut(document, target.span)]),
        cut(document, classStatement.targetsSpan),
        classStatement.className,
      ],
    ).toEqual([
      [
        ['A', 'A'],
        ['B', 'B'],
      ],
      'A,B',
      'hot',
    ])
    const [click] = byKind('click')
    expect(click.kind === 'click' && click.targets.map((target) => [target.id, cut(document, target.span)])).toEqual([
      ['C', 'C'],
    ])
    // The whole statement, the word `click` and the closing quote included.
    expect(cut(document, click.span)).toBe('click C href "https://example.com" "tip"')
  })

  it('finds each link number a linkStyle names', () => {
    const document = read(source)
    const linkStyles = document.statements.filter((statement) => statement.kind === 'linkStyle')
    expect(
      linkStyles.map(
        (statement) =>
          statement.kind === 'linkStyle' && [
            statement.isDefault,
            statement.positions.map((position) => [position.value, cut(document, position.span)]),
            cut(document, statement.positionsSpan),
          ],
      ),
    ).toEqual([
      [
        false,
        [
          ['0', '0'],
          ['1', '1'],
        ],
        '0,1',
      ],
      [true, [], 'default'],
    ])
    expect(document.reading?.edges.map((edge) => edge.style)).toEqual([
      ['stroke:#f00', 'fill:none'],
      ['stroke:#f00', 'fill:none'],
    ])
    expect(document.reading?.defaultLinkStyle).toEqual(['stroke-width:2px'])
  })

  it('applies classes and styles the way mermaid does', () => {
    const document = read(source)
    expect(document.reading?.nodes.map((node) => [node.id, node.classes, node.styles])).toEqual([
      ['A', ['hot'], ['fill:#f9f']],
      ['B', ['hot'], []],
      // A link target is made clickable by mermaid itself.
      ['C', ['clickable'], []],
    ])
    expect(document.reading?.classes).toEqual([{ id: 'hot', styles: ['fill:#f96'], textStyles: [] }])
  })

  it('reads the header: keyword and direction, each where it is', () => {
    const document = read(src('graph TD;', '  A-->B;'))
    expect(document.header).toEqual({
      keyword: 'graph',
      keywordSpan: { start: 0, end: 5 },
      direction: { value: 'TD', span: { start: 6, end: 8 } },
    })
    expect(document.reading?.direction).toBe('TB')
    expect(read(src('flowchart', '  A --> B')).header?.direction).toBeNull()
  })

  it('reads several statements on one line, and says what ended each', () => {
    const document = read('graph LR; A[One]-->B(Two); B-->C{Three}; style A fill:#eee')
    expect(
      document.statements.map((statement) => [statement.kind, statement.separator, cut(document, statement.span)]),
    ).toEqual([
      ['vertex', 'semicolon', 'A[One]-->B(Two)'],
      ['vertex', 'semicolon', 'B-->C{Three}'],
      // Mermaid appends a newline to every text it parses, so the last
      // statement of a text that has none is still ended by one.
      ['style', 'newline', 'style A fill:#eee'],
    ])
  })

  it('reads a line that merely contains the words as a direction statement, because mermaid does', () => {
    const document = read(src('flowchart LR', '  A[go in direction TB] --> B', '  B --> C'))
    expect(document.statements.map((statement) => statement.kind)).toEqual(['direction', 'vertex'])
    expect(document.reading?.nodes.map((node) => node.id)).toEqual(['B', 'C'])
  })
})

describe('a text the builder cannot edit says why, and where', () => {
  it.each([
    ['another kind of diagram', src('sequenceDiagram', '  A->>B: hi'), 'not-flowchart', 0],
    ['a variant keyword', src('flowchart-elk LR', '  A --> B'), 'not-flowchart', 0],
    ['nothing at all', '', 'not-flowchart', 0],
    ['a link that goes nowhere', src('flowchart LR', '  A -->'), 'syntax', 1],
    ['a bracket never closed', src('flowchart LR', '  A --> B', '  C[open'), 'syntax', 2],
    ['a character mermaid has no rule for', src('flowchart LR', '  A --> B', '  ¤'), 'lexical', 2],
    ['a linkStyle past the last link', src('flowchart LR', '  A --> B', '  linkStyle 5 stroke:red'), 'rejected', 2],
    ['a group with no name', src('flowchart LR', '  subgraph', '    a', '  end'), 'rejected', 1],
  ])('%s', (_name, source, kind, line) => {
    const document = parseMermaidFlowSource(source)
    expect(document.problem).toMatchObject({ kind, line })
    expect(document.reading).toBeNull()
    expect(document.statements).toEqual([])
    // Refused, and still whole.
    expect(printMermaidFlowDocument(document)).toBe(source)
  })

  it('says what mermaid tripped over', () => {
    expect(parseMermaidFlowSource(src('flowchart LR', '  A -->')).problem?.message).toBe(
      'Mermaid does not expect the text to end here.',
    )
    expect(parseMermaidFlowSource(src('flowchart LR', '  A --> end')).problem?.message).toBe(
      'Mermaid does not expect "end" here.',
    )
  })
})

describe('mermaidSourceLineAt', () => {
  it('finds the line of an offset, a terminator belonging to the line it ends', () => {
    const { lines } = parseMermaidFlowSource('ab\r\ncd\nef')
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((offset) => mermaidSourceLineAt(lines, offset))).toEqual([
      0, 0, 0, 0, 1, 1, 1, 2, 2, 2,
    ])
  })
})

describe('plainMermaidLabel', () => {
  it.each([
    ['what mermaid keeps for an entity code', 'a ﬂ°quot¶ßqﬂ°quot¶ß b', 'a "q" b'],
    ['the same thing as typed', 'a #quot;q#quot; b', 'a "q" b'],
    ['a numbered code', 'ﬂ°°35¶ß1', '#1'],
    ['what the sanitiser makes of an ampersand', 'Tom &amp; Jerry', 'Tom & Jerry'],
    ['a comparison the sanitiser escaped', 'a &lt; b', 'a < b'],
    ['a line break, however it is written', 'one<br>two<BR />three', 'one<br/>two<br/>three'],
    ['runs of whitespace', '  a \n  b  ', 'a b'],
    ['an entity it does not know', '&hearts; #hearts;', '&hearts; &hearts;'],
  ])('%s', (_name, value, expected) => {
    expect(plainMermaidLabel(value)).toBe(expected)
  })
})

describe('compareMermaidFlowReadings', () => {
  const readingOf = (source: string): MermaidFlowReading => {
    const { reading } = read(source)
    if (!reading) {
      throw new Error('no reading')
    }
    return reading
  }
  const base = src('flowchart LR', '  A[One] -->|go| B', '  subgraph g', '    C', '  end')

  it('finds nothing to say about a reading and itself', () => {
    expect(compareMermaidFlowReadings(readingOf(base), readingOf(base))).toEqual([])
  })

  it.each([
    ['a box that is missing', src('flowchart LR', '  A[One] -->|go| B', '  subgraph g', '    D', '  end'), /^boxes: /],
    ['a different shape', base.replace('A[One]', 'A(One)'), /^shape of A: /],
    ['a different label', base.replace('One', 'Two'), /^label of A: /],
    ['a link that ends elsewhere', base.replace('| B', '| C'), /^ends of link 0: /],
    ['a different line', base.replace('-->', '==>'), /^line of link 0: /],
    ['a different link text', base.replace('go', 'stop'), /^text of link 0: /],
    ['one link more', base + '\n  B --> C', /^number of links: /],
    ['a group with other boxes in it', base.replace('    C', '    C\n    B'), /^boxes in group g: /],
    ['another direction', base.replace('LR', 'TB'), /^direction: /],
  ])('names %s', (_name, other, expected) => {
    const differences = compareMermaidFlowReadings(readingOf(base), readingOf(other))
    expect(differences.some((difference) => expected.test(difference))).toBe(true)
  })

  it('compares a label only up to its first markup character, which is as far as mermaid leaves it alone', () => {
    const ours = readingOf(src('flowchart LR', '  A["Tom & Jerry <b>x</b>"]'))
    const sanitised: MermaidFlowReading = {
      ...ours,
      nodes: [{ ...ours.nodes[0], text: 'Tom &amp; Jerry <b>x</b>' }],
    }
    expect(compareMermaidFlowReadings(ours, sanitised)).toEqual([])
    const different: MermaidFlowReading = { ...ours, nodes: [{ ...ours.nodes[0], text: 'Tim &amp; Jerry' }] }
    expect(compareMermaidFlowReadings(ours, different)).toHaveLength(1)
  })

  it('does not hold a box given `@{…}` to a shape and a label it cannot know', () => {
    const ours = readingOf(src('flowchart LR', '  A@{ shape: cyl, label: "DB" }'))
    const theirs: MermaidFlowReading = {
      ...ours,
      nodes: [{ id: 'A', text: 'DB', type: 'cyl', labelType: 'string', classes: [], styles: [] }],
    }
    expect(compareMermaidFlowReadings(ours, theirs)).toEqual([])
  })
})
