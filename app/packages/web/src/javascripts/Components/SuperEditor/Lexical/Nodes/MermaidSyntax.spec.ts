/**
 * Standard Red Notes — contracts for the mermaid source tokenizer.
 *
 * Three things are being guarded here, in order of how much damage they do when
 * they break:
 *
 *  1. THE ROUND-TRIP. The pane draws the tokens in a `<pre>` behind a
 *     transparent `<textarea>`; if the tokens do not reproduce the source
 *     exactly, every glyph after the discrepancy shifts and the caret stops
 *     sitting over its own character. So the first describe asserts, for every
 *     fixture, that the token stream is ordered, non-overlapping, gapless and
 *     reassembles the input byte for byte. jsdom has no layout engine so it
 *     cannot see the misalignment itself — but it can see the cause.
 *
 *  2. THAT TOKENS ARE ACTUALLY PRODUCED. Highlighting that classifies nothing
 *     renders no coloured spans, which is indistinguishable from highlighting
 *     being switched off. Every assertion below names the token type AND the
 *     exact text, so a tokenizer that returned one `text` token for the whole
 *     source would fail every one of them rather than passing vacuously.
 *
 *  3. THE AMBIGUITIES THAT ACTUALLY BIT. `graph-->b` must not scan as the
 *     identifier `graph--`; `||--o{` must not become an edge label; `to` must
 *     not be a keyword in a flowchart. Each has its own test.
 */
import {
  MERMAID_TOKEN_CLASS,
  MERMAID_TOKEN_TYPES,
  detectMermaidSyntaxFamily,
  tokenizeMermaid,
  tokenizeMermaidByLine,
  type MermaidToken,
  type MermaidTokenType,
} from './MermaidSyntax'

/** The text a token covers, which is what every assertion below is about. */
const textOf = (source: string, token: MermaidToken): string => source.slice(token.start, token.end)

/** Every `[type, text]` pair except the unclassified runs. */
const classified = (source: string): [MermaidTokenType, string][] =>
  tokenizeMermaid(source)
    .filter((token) => token.type !== 'text')
    .map((token) => [token.type, textOf(source, token)])

/** The texts a given type claims, in source order. */
const textsOfType = (source: string, type: MermaidTokenType): string[] =>
  tokenizeMermaid(source)
    .filter((token) => token.type === type)
    .map((token) => textOf(source, token))

const FIXTURES: Record<string, string> = {
  flowchart: [
    '---',
    'title: Deployment',
    'config:',
    '  theme: dark',
    '---',
    '%%{init: {"flowchart": {"curve": "linear"}}}%%',
    'flowchart LR',
    '  %% the happy path',
    '  A[Start] --> B{Ready?}',
    '  B -->|yes| C((Done))',
    '  B -.->|no| D[/Retry/]',
    '  C ==> E[[Report]]',
    '  D --x F([Abort])',
    '  E --- G[(Store)]',
    '  subgraph Cluster',
    '    direction TB',
    '    H>Flag] --o I{{Hex}}',
    '  end',
    '  A -- labelled --> I',
    '  classDef hot fill:#f00,stroke:#333',
    '  class A,B hot',
    '  style C fill:#0f0',
    '  linkStyle 0 stroke:#00f',
    '  click A href "https://example.com" _blank',
    '  J:::hot',
    '  K ~~~ L',
  ].join('\n'),
  sequence: [
    'sequenceDiagram',
    '  autonumber',
    '  participant A as Alice',
    '  actor B',
    '  box Grey Team',
    '  participant C',
    '  end',
    '  A->>B: Hello "world"',
    '  B-->>A: Hi',
    '  A-)C: async',
    '  C--xA: lost',
    '  activate B',
    '  deactivate B',
    '  Note left of A: a note',
    '  Note right of B: another',
    '  loop every minute',
    '    A->B: ping',
    '  end',
    '  alt is ok',
    '    A->B: yes',
    '  else is not',
    '    A->B: no',
    '  end',
    '  par one',
    '    A->B: p',
    '  and two',
    '    A->C: q',
    '  end',
    '  critical attempt',
    '  option failure',
    '  end',
    '  break oops',
    '  end',
    '  create participant D',
    '  destroy D',
    '  links A: {"repo": "x"}',
    '  accTitle: A title',
  ].join('\n'),
  class: [
    'classDiagram-v2',
    '  direction RL',
    '  class Animal {',
    '    +String name',
    '    -int age',
    '    #protected()',
    '    ~internal()',
    '  }',
    '  Animal <|-- Dog',
    '  Animal *-- Leg',
    '  Animal o-- Collar',
    '  Animal ..> Food',
    '  Animal --|> Base',
    '  Dog ..|> Walkable',
    '  class Dog:::highlight',
    '  note for Dog "a dog"',
    '  namespace Pets {',
    '    class Cat',
    '  }',
    '  cssClass "Dog" bold',
  ].join('\n'),
  state: [
    'stateDiagram-v2',
    '  direction LR',
    '  [*] --> Idle',
    '  Idle --> Running : start',
    '  state Running {',
    '    [*] --> Warm',
    '  }',
    '  state Fork <<fork>>',
    '  note left of Idle',
    '    waiting',
    '  end note',
    '  hide empty description',
    '  classDef busy fill:#f90',
    '  Running:::busy',
  ].join('\n'),
  er: [
    'erDiagram',
    '  CUSTOMER ||--o{ ORDER : places',
    '  ORDER ||--|{ LINE_ITEM : contains',
    '  CUSTOMER }|..|{ ADDRESS : uses',
    '  PERSON one or more to CAR : drives',
    '  PERSON only one to PASSPORT : has',
    '  CUSTOMER {',
    '    string name PK',
    '    int id FK',
    '  }',
  ].join('\n'),
  gantt: [
    'gantt',
    '  title A schedule',
    '  dateFormat YYYY-MM-DD',
    '  axisFormat %Y-%m',
    '  tickInterval 1week',
    '  excludes weekends',
    '  todayMarker off',
    '  weekday monday',
    '  inclusiveEndDates',
    '  topAxis',
    '  section Design',
    '    Draft :a1, 2024-01-01, 30d',
    '    Review :after a1, 20d',
  ].join('\n'),
  pie: ['pie showData', '  title Shares', '  "Alpha" : 42.5', '  "Beta" : 57.5'].join('\n'),
  journey: ['journey', '  title My day', '  section Morning', '    Wake: 5: Me', '    Eat: 3: Me, Cat'].join('\n'),
  gitGraph: [
    'gitGraph TB:',
    '  commit id: "one"',
    '  commit id: "two" tag: "v1" type: HIGHLIGHT',
    '  branch develop order: 2',
    '  checkout develop',
    '  commit',
    '  checkout main',
    '  merge develop',
    '  cherry-pick id: "two" parent: "one"',
  ].join('\n'),
  mindmap: ['mindmap', '  root((centre))', '    Child', '      ::icon(fa fa-book)', '      Leaf[square]'].join('\n'),
  timeline: ['timeline', '  title History', '  section Era', '    1990 : one : two'].join('\n'),
  quadrant: [
    'quadrantChart',
    '  title Reach',
    '  x-axis Low --> High',
    '  y-axis Small --> Big',
    '  quadrant-1 Do',
    '  "A": [0.3, 0.6]',
  ].join('\n'),
  requirement: [
    'requirementDiagram',
    '  requirement one {',
    '    id: 1',
    '    text: a requirement',
    '    risk: high',
    '    verifyMethod: test',
    '  }',
    '  element two {',
    '    type: simulation',
    '  }',
    '  one - satisfies -> two',
  ].join('\n'),
  sankey: ['sankey-beta', 'A,B,10', 'B,C,5'].join('\n'),
  xychart: [
    'xychart-beta',
    '  title "Sales"',
    '  x-axis [jan, feb]',
    '  y-axis "Revenue" 0 --> 100',
    '  bar [10, 20]',
    '  line [15, 25]',
  ].join('\n'),
  block: ['block-beta', '  columns 3', '  A B C', '  space', '  D["wide"]', '  classDef x fill:#fff'].join('\n'),
  c4: [
    'C4Context',
    '  title System',
    '  Person(user, "User", "a person")',
    '  System(sys, "System")',
    '  Rel(user, sys, "uses")',
    '  UpdateRelStyle(user, sys, $offsetY="10")',
  ].join('\n'),
  kanban: ['kanban', '  Todo', '    task1[Do it]', '  Done'].join('\n'),
  architecture: [
    'architecture-beta',
    '  group api(cloud)[API]',
    '  service db(database)[Database] in api',
    '  db:L -- R:server',
  ].join('\n'),
  packet: ['packet-beta', '  title A packet', '  0-15: "Source"', '  16-31: "Destination"'].join('\n'),
  radar: ['radar-beta', '  axis a["A"], b["B"]', '  curve one{1, 2}', '  showLegend true', '  ticks 5'].join('\n'),
  treemap: ['treemap-beta', '  "Root"', '    "Leaf": 10'].join('\n'),
  info: ['info', 'showInfo'].join('\n'),
  venn: ['venn-beta', '  set a: 10', '  union a, b: 3'].join('\n'),
  unknownSource: ['not a diagram at all', 'A --> B', '%% but it still has a comment'].join('\n'),
  empty: '',
  justWhitespace: '   \n\t\n  ',
  unterminatedString: 'flowchart LR\n  A["unclosed\n  B --> C',
  crlf: 'flowchart LR\r\n  A --> B\r\n  %% a comment\r\n',
  trailingNewline: 'flowchart LR\n  A --> B\n',
}

describe('tokenizeMermaid — the round-trip the caret depends on', () => {
  for (const [name, source] of Object.entries(FIXTURES)) {
    it(`reassembles ${name} byte for byte`, () => {
      const tokens = tokenizeMermaid(source)
      expect(tokens.map((token) => textOf(source, token)).join('')).toBe(source)
    })

    it(`emits ordered, non-overlapping, gapless tokens for ${name}`, () => {
      const tokens = tokenizeMermaid(source)
      let cursor = 0
      for (const token of tokens) {
        expect(token.end).toBeGreaterThan(token.start)
        expect(token.start).toBe(cursor)
        cursor = token.end
      }
      expect(cursor).toBe(source.length)
    })

    it(`classifies every token of ${name} as a known type`, () => {
      for (const token of tokenizeMermaid(source)) {
        expect(MERMAID_TOKEN_TYPES).toContain(token.type)
      }
    })
  }

  it('is not vacuously green — a tokenizer that classified nothing would fail', () => {
    // The guard on the guard. If `tokenizeMermaid` returned one `text` token per
    // source, every round-trip test above would still pass. These are the two
    // assertions that would not: each real fixture must yield at least two
    // classified tokens, and across the fixtures every classified type must
    // appear at least once, so no colour in the palette is dead.
    for (const [name, source] of Object.entries(FIXTURES)) {
      if (name === 'empty' || name === 'justWhitespace' || name === 'unknownSource') {
        continue
      }
      expect(classified(source).length).toBeGreaterThanOrEqual(2)
    }
    const seen = new Set<MermaidTokenType>()
    for (const source of Object.values(FIXTURES)) {
      for (const [type] of classified(source)) {
        seen.add(type)
      }
    }
    for (const type of MERMAID_TOKEN_TYPES) {
      if (type === 'text') {
        continue
      }
      expect([...seen]).toContain(type)
    }
  })

  it('reproduces the source even when the declared family is forced to the wrong one', () => {
    // The family only selects rules; it can never make the stream lossy.
    const source = FIXTURES.flowchart
    for (const family of ['er', 'sequence', 'class', 'unknown'] as const) {
      const tokens = tokenizeMermaid(source, family)
      expect(tokens.map((token) => textOf(source, token)).join('')).toBe(source)
    }
  })
})

describe('detectMermaidSyntaxFamily', () => {
  const cases: [string, string][] = [
    ['flowchart LR\nA-->B', 'flowchart'],
    ['graph TD\nA-->B', 'flowchart'],
    ['flowchart-elk LR\nA-->B', 'flowchart'],
    ['sequenceDiagram\nA->>B: hi', 'sequence'],
    ['classDiagram\nclass A', 'class'],
    ['classDiagram-v2\nclass A', 'class'],
    ['stateDiagram-v2\n[*]-->A', 'state'],
    ['erDiagram\nA ||--o{ B : x', 'er'],
    ['gantt\ntitle x', 'gantt'],
    ['pie showData', 'pie'],
    ['journey\ntitle x', 'journey'],
    ['gitGraph\ncommit', 'gitGraph'],
    ['mindmap\nroot', 'mindmap'],
    ['timeline\ntitle x', 'timeline'],
    ['quadrantChart\ntitle x', 'quadrant'],
    ['requirementDiagram\nrequirement a {}', 'requirement'],
    ['sankey-beta\nA,B,1', 'sankey'],
    ['xychart-beta\ntitle x', 'xychart'],
    ['block-beta\ncolumns 1', 'block'],
    ['C4Context\ntitle x', 'c4'],
    // The families only this module names.
    ['kanban\nTodo', 'kanban'],
    ['architecture-beta\ngroup a', 'architecture'],
    ['packet-beta\ntitle x', 'packet'],
    ['radar-beta\naxis a', 'radar'],
    ['treemap-beta\n"a"', 'treemap'],
    ['info', 'info'],
    ['venn-beta\nset a: 1', 'venn'],
    ['ishikawa-beta\ntitle x', 'ishikawa'],
    ['eventmodeling\ntitle x', 'eventmodeling'],
    ['swimlane-beta\nA-->B', 'swimlane'],
    ['railroad-beta\nx', 'railroad'],
    ['cynefin-beta\nx', 'cynefin'],
    ['nothing recognisable', 'unknown'],
    ['', 'unknown'],
  ]
  for (const [source, expected] of cases) {
    it(`names ${JSON.stringify(source.split('\n')[0])} as ${expected}`, () => {
      expect(detectMermaidSyntaxFamily(source)).toBe(expected)
    })
  }

  it('skips frontmatter and comments to find the declaring line', () => {
    expect(detectMermaidSyntaxFamily('---\ntitle: x\n---\n%% a comment\n\nkanban\n  Todo')).toBe('kanban')
  })

  it('tolerates a non-string', () => {
    expect(detectMermaidSyntaxFamily(undefined as unknown as string)).toBe('unknown')
  })
})

describe('flowchart tokens', () => {
  it('names the diagram keyword and the direction', () => {
    expect(classified('flowchart LR')).toEqual([
      ['keyword', 'flowchart'],
      ['keyword', 'LR'],
    ])
  })

  it('covers every link form flow.jison matches', () => {
    const links = [
      '-->',
      '---',
      '--x',
      '--o',
      '<-->',
      '---->',
      '==>',
      '===',
      '==x',
      '<==>',
      '-.->',
      '-.-',
      '-..->',
      '<-.->',
      // `-.-x`, not `-.x`: flow.jison's dotted rule is `[xo<]?-?\.+-[xo>]?`, so
      // the dots are always followed by a dash before the head.
      '-.-x',
      '~~~',
    ]
    for (const link of links) {
      const source = `flowchart LR\n  A ${link} B`
      const operators = textsOfType(source, 'operator')
      expect(operators).toEqual([link])
    }
  })

  it('reads the inline-label link as an opener, a label and a head', () => {
    const source = 'flowchart LR\n  A -- yes --> B'
    expect(textsOfType(source, 'operator')).toEqual(['--', '-->'])
  })

  it('reads an edge label in pipes as a string between two pipes', () => {
    const source = 'flowchart LR\n  A -->|yes| B'
    expect(classified(source)).toEqual([
      ['keyword', 'flowchart'],
      ['keyword', 'LR'],
      ['operator', '-->'],
      ['punctuation', '|'],
      ['string', 'yes'],
      ['punctuation', '|'],
    ])
  })

  it('covers every node-shape delimiter pair', () => {
    const shapes: [string, string][] = [
      ['[', ']'],
      ['(', ')'],
      ['((', '))'],
      ['{', '}'],
      ['{{', '}}'],
      ['[[', ']]'],
      ['([', '])'],
      ['[(', ')]'],
      ['[/', '/]'],
      ['[\\', '\\]'],
      ['(((', ')))'],
    ]
    for (const [open, close] of shapes) {
      const source = `flowchart LR\n  A${open}Label${close}`
      const punctuation = textsOfType(source, 'punctuation')
      expect(punctuation).toEqual([open, close])
    }
  })

  it('reads the asymmetric `>]` shape', () => {
    expect(textsOfType('flowchart LR\n  A>Flag]', 'punctuation')).toEqual(['>', ']'])
  })

  it('names subgraph, end and the direction statement', () => {
    const source = 'flowchart LR\n  subgraph S\n    direction TB\n  end'
    expect(textsOfType(source, 'keyword')).toEqual(['flowchart', 'LR', 'subgraph', 'direction', 'TB', 'end'])
  })

  it('names classDef, class, style, linkStyle and click', () => {
    const source = [
      'flowchart LR',
      '  classDef hot fill:#f00',
      '  class A hot',
      '  style B fill:#0f0',
      '  linkStyle 0 stroke:#00f',
      '  click A href "https://example.com" _blank',
    ].join('\n')
    const keywords = textsOfType(source, 'keyword')
    expect(keywords).toContain('classDef')
    expect(keywords).toContain('class')
    expect(keywords).toContain('style')
    expect(keywords).toContain('linkStyle')
    expect(keywords).toContain('click')
    expect(keywords).toContain('href')
    expect(keywords).toContain('_blank')
  })

  it('reads `:::` as one operator, not three colons', () => {
    expect(textsOfType('flowchart LR\n  A:::hot', 'operator')).toEqual([':::'])
  })

  it('does NOT scan `graph-->b` as the identifier `graph--`', () => {
    // The bug a `-`-inclusive identifier class produces. `graph` must stay a
    // keyword and `-->` must stay an arrow.
    expect(classified('graph-->b')).toEqual([
      ['keyword', 'graph'],
      ['operator', '-->'],
    ])
  })

  it('still reads a hyphenated keyword as one keyword', () => {
    expect(textsOfType('flowchart-elk LR\n A-->B', 'keyword')).toContain('flowchart-elk')
  })

  it('does NOT treat the entity-relationship word `to` as a keyword here', () => {
    const source = 'flowchart LR\n  A[go to work] --> B'
    expect(textsOfType(source, 'keyword')).toEqual(['flowchart', 'LR'])
  })
})

describe('sequence diagram tokens', () => {
  it('covers every arrow form sequenceDiagram.jison matches', () => {
    for (const arrow of ['->', '-->', '->>', '-->>', '<<->>', '<<-->>', '-x', '--x', '-)', '--)']) {
      const source = `sequenceDiagram\n  A${arrow}B: hi`
      expect(textsOfType(source, 'operator')).toEqual([arrow])
    }
  })

  it('names participants, actors and the block keywords', () => {
    const keywords = textsOfType(FIXTURES.sequence, 'keyword')
    for (const expected of [
      'sequenceDiagram',
      'autonumber',
      'participant',
      'as',
      'actor',
      'box',
      'end',
      'activate',
      'deactivate',
      'loop',
      'alt',
      'else',
      'par',
      'and',
      'critical',
      'option',
      'break',
      'create',
      'destroy',
      'links',
    ]) {
      expect(keywords).toContain(expected)
    }
  })

  it('reads `left of` and `right of` as single keywords', () => {
    const keywords = textsOfType('sequenceDiagram\n  Note left of A: x\n  Note right of B: y', 'keyword')
    expect(keywords).toContain('left of')
    expect(keywords).toContain('right of')
  })

  it('reads a quoted message as a string', () => {
    expect(textsOfType('sequenceDiagram\n  A->>B: say "hello"', 'string')).toEqual(['"hello"'])
  })

  it('names accTitle as a property', () => {
    expect(textsOfType('sequenceDiagram\n  accTitle: A title', 'property')).toEqual(['accTitle'])
  })
})

describe('class diagram tokens', () => {
  it('reads each relation as one operator', () => {
    for (const relation of ['<|--', '*--', 'o--', '-->', '--', '..>', '..', '--|>', '..|>', '<|..', '<..']) {
      const source = `classDiagram\n  A ${relation} B`
      expect(textsOfType(source, 'operator')).toEqual([relation])
    }
  })

  it('reads an annotation in angle brackets as an operator pair', () => {
    expect(textsOfType('classDiagram\n  <<interface>> Shape', 'operator')).toEqual(['<<', '>>'])
  })

  it('names note for and namespace', () => {
    const keywords = textsOfType(FIXTURES.class, 'keyword')
    expect(keywords).toContain('note for')
    expect(keywords).toContain('namespace')
    expect(keywords).toContain('cssClass')
  })
})

describe('state diagram tokens', () => {
  it('reads the start/end pseudostate as one operator', () => {
    expect(textsOfType('stateDiagram-v2\n  [*] --> A', 'operator')).toEqual(['[*]', '-->'])
  })

  it('reads a fork annotation as one operator', () => {
    expect(textsOfType('stateDiagram-v2\n  state F <<fork>>', 'operator')).toEqual(['<<fork>>'])
  })

  it('reads `hide empty description` as one keyword', () => {
    expect(textsOfType('stateDiagram-v2\n  hide empty description', 'keyword')).toContain('hide empty description')
  })
})

describe('entity-relationship tokens', () => {
  it('reads a cardinality pair as operators rather than an edge label', () => {
    const source = 'erDiagram\n  A ||--o{ B : x'
    expect(textsOfType(source, 'operator')).toEqual(['||--o{'])
    expect(textsOfType(source, 'string')).toEqual([])
  })

  it('covers the dotted and dashed relation bodies', () => {
    for (const relation of ['||--o{', '}|..|{', '||--|{', '|o..o|']) {
      const source = `erDiagram\n  A ${relation} B : x`
      expect(textsOfType(source, 'operator')).toEqual([relation])
    }
  })

  it('reads the word cardinalities as keywords', () => {
    const keywords = textsOfType(FIXTURES.er, 'keyword')
    expect(keywords).toContain('one or more')
    expect(keywords).toContain('only one')
    expect(keywords).toContain('to')
  })

  it('names the key markers', () => {
    const keywords = textsOfType(FIXTURES.er, 'keyword')
    expect(keywords).toContain('PK')
    expect(keywords).toContain('FK')
  })
})

describe('gantt tokens', () => {
  it('names every statement keyword', () => {
    const keywords = textsOfType(FIXTURES.gantt, 'keyword')
    for (const expected of [
      'gantt',
      'title',
      'dateFormat',
      'axisFormat',
      'tickInterval',
      'excludes',
      'todayMarker',
      'weekday',
      'monday',
      'inclusiveEndDates',
      'topAxis',
      'section',
    ]) {
      expect(keywords).toContain(expected)
    }
  })

  it('reads an ISO date as one number token, not three', () => {
    expect(textsOfType('gantt\n  Draft :a1, 2024-01-01, 30d', 'number')).toEqual(['2024-01-01', '30'])
  })
})

describe('the other diagram families', () => {
  it('names pie keywords', () => {
    const keywords = textsOfType(FIXTURES.pie, 'keyword')
    expect(keywords).toContain('pie')
    expect(keywords).toContain('showData')
    expect(keywords).toContain('title')
  })

  it('names gitGraph keywords and its `name:` properties', () => {
    const keywords = textsOfType(FIXTURES.gitGraph, 'keyword')
    expect(keywords).toContain('gitGraph')
    expect(keywords).toContain('commit')
    expect(keywords).toContain('branch')
    expect(keywords).toContain('checkout')
    expect(keywords).toContain('merge')
    expect(keywords).toContain('cherry-pick')
    expect(keywords).toContain('HIGHLIGHT')
    const properties = textsOfType(FIXTURES.gitGraph, 'property')
    expect(properties).toContain('id')
    expect(properties).toContain('tag')
    expect(properties).toContain('type')
    expect(properties).toContain('order')
    expect(properties).toContain('parent')
  })

  it('names the mindmap header and its icon decorator', () => {
    expect(textsOfType(FIXTURES.mindmap, 'keyword')).toEqual(['mindmap'])
    expect(textsOfType(FIXTURES.mindmap, 'operator')).toContain('::icon(')
  })

  it('names journey and timeline sections', () => {
    expect(textsOfType(FIXTURES.journey, 'keyword')).toContain('section')
    expect(textsOfType(FIXTURES.timeline, 'keyword')).toContain('section')
  })

  it('names quadrant and xychart axes', () => {
    expect(textsOfType(FIXTURES.quadrant, 'keyword')).toContain('x-axis')
    expect(textsOfType(FIXTURES.xychart, 'keyword')).toContain('y-axis')
    expect(textsOfType(FIXTURES.xychart, 'keyword')).toContain('bar')
  })

  it('names C4 elements', () => {
    const keywords = textsOfType(FIXTURES.c4, 'keyword')
    expect(keywords).toContain('C4Context')
    expect(keywords).toContain('Person')
    expect(keywords).toContain('Rel')
    expect(keywords).toContain('UpdateRelStyle')
  })

  it('names architecture, packet, radar, treemap, info and venn keywords', () => {
    expect(textsOfType(FIXTURES.architecture, 'keyword')).toContain('group')
    expect(textsOfType(FIXTURES.architecture, 'keyword')).toContain('service')
    expect(textsOfType(FIXTURES.packet, 'keyword')).toContain('packet-beta')
    expect(textsOfType(FIXTURES.radar, 'keyword')).toContain('axis')
    expect(textsOfType(FIXTURES.radar, 'keyword')).toContain('showLegend')
    expect(textsOfType(FIXTURES.treemap, 'keyword')).toContain('treemap-beta')
    expect(textsOfType(FIXTURES.info, 'keyword')).toContain('showInfo')
    expect(textsOfType(FIXTURES.venn, 'keyword')).toContain('set')
  })

  it('names requirement types and risks', () => {
    const keywords = textsOfType(FIXTURES.requirement, 'keyword')
    expect(keywords).toContain('requirementDiagram')
    expect(keywords).toContain('requirement')
    expect(keywords).toContain('element')
  })
})

describe('comments, directives and frontmatter', () => {
  it('reads a `%%` comment to end of line and no further', () => {
    const source = 'flowchart LR\n  %% a comment\n  A --> B'
    expect(textsOfType(source, 'comment')).toEqual(['%% a comment'])
    expect(textsOfType(source, 'operator')).toEqual(['-->'])
  })

  it('reads `%%{init: …}%%` as a directive, not a comment', () => {
    const source = '%%{init: {"theme": "dark"}}%%\nflowchart LR'
    expect(textsOfType(source, 'directive')).toEqual(['%%{init: {"theme": "dark"}}%%'])
    expect(textsOfType(source, 'comment')).toEqual([])
  })

  it('reads a multi-line directive whole', () => {
    const source = '%%{init: {\n  "theme": "dark"\n}}%%\nflowchart LR'
    expect(textsOfType(source, 'directive')).toEqual(['%%{init: {\n  "theme": "dark"\n}}%%'])
  })

  it('stops an unclosed directive at the end of its line', () => {
    const source = '%%{init: {"theme"\nflowchart LR\nA-->B'
    expect(textsOfType(source, 'directive')).toEqual(['%%{init: {"theme"'])
    expect(textsOfType(source, 'keyword')).toContain('flowchart')
  })

  it('reads frontmatter fences as punctuation and its keys as properties', () => {
    const source = '---\ntitle: Hello\nconfig:\n  theme: dark\n---\nflowchart LR'
    expect(textsOfType(source, 'punctuation')).toEqual(['---', ':', ':', ':', '---'])
    expect(textsOfType(source, 'property')).toEqual(['title', 'config', 'theme'])
    expect(textsOfType(source, 'keyword')).toEqual(['flowchart', 'LR'])
  })

  it('does NOT read a frontmatter fence as a flowchart link', () => {
    const source = '---\ntitle: Hello\n---\nflowchart LR\nA --> B'
    expect(textsOfType(source, 'operator')).toEqual(['-->'])
  })

  it('leaves a bare `---` that is not frontmatter to the normal rules', () => {
    // No closing fence, so mermaid does not treat it as frontmatter either.
    const source = '---\nflowchart LR\nA --> B'
    expect(textsOfType(source, 'property')).toEqual([])
  })
})

describe('degenerate input', () => {
  it('returns nothing for an empty source', () => {
    expect(tokenizeMermaid('')).toEqual([])
  })

  it('tolerates a non-string', () => {
    expect(tokenizeMermaid(null as unknown as string)).toEqual([])
  })

  it('stops an unterminated string at the newline', () => {
    const source = 'flowchart LR\n  A["unclosed\n  B --> C'
    expect(textsOfType(source, 'string')).toEqual(['"unclosed'])
    expect(textsOfType(source, 'operator')).toEqual(['-->'])
  })

  it('handles CRLF line endings without losing the \\r', () => {
    const source = FIXTURES.crlf
    const tokens = tokenizeMermaid(source)
    expect(tokens.map((token) => textOf(source, token)).join('')).toBe(source)
    expect(textsOfType(source, 'comment')).toEqual(['%% a comment'])
  })

  it('does not hang on a long run of arrow characters', () => {
    const source = 'flowchart LR\n' + '-'.repeat(2000)
    expect(() => tokenizeMermaid(source)).not.toThrow()
    expect(
      tokenizeMermaid(source)
        .map((token) => textOf(source, token))
        .join(''),
    ).toBe(source)
  })
})

describe('tokenizeMermaidByLine', () => {
  it('returns one entry per line, with the line text', () => {
    const source = 'flowchart LR\n  A --> B\n'
    const lines = tokenizeMermaidByLine(source)
    expect(lines.map((line) => line.text)).toEqual(['flowchart LR', '  A --> B', ''])
  })

  it('keeps every line gapless over its own text', () => {
    for (const source of Object.values(FIXTURES)) {
      for (const line of tokenizeMermaidByLine(source)) {
        let cursor = 0
        for (const token of line.tokens) {
          expect(token.start).toBe(cursor)
          cursor = token.end
        }
        expect(cursor).toBe(line.text.length)
      }
    }
  })

  it('reassembles the source from the lines, newlines excepted', () => {
    for (const source of Object.values(FIXTURES)) {
      expect(
        tokenizeMermaidByLine(source)
          .map((line) => line.text)
          .join('\n'),
      ).toBe(source.replace(/\r\n/g, '\r\n'))
    }
  })

  it('splits a directive that spans lines at the line break', () => {
    const lines = tokenizeMermaidByLine('%%{init: {\n  "theme": "dark"\n}}%%\nflowchart LR')
    expect(lines[0].tokens).toEqual([{ type: 'directive', start: 0, end: 10 }])
    expect(lines[1].tokens[0].type).toBe('directive')
    expect(lines[2].tokens[0].type).toBe('directive')
  })
})

describe('MERMAID_TOKEN_CLASS', () => {
  it('maps every token type', () => {
    for (const type of MERMAID_TOKEN_TYPES) {
      expect(MERMAID_TOKEN_CLASS[type]).toBeDefined()
    }
  })

  it('gives every classified type a distinct non-empty class and `text` none', () => {
    const classes = MERMAID_TOKEN_TYPES.filter((type) => type !== 'text').map((type) => MERMAID_TOKEN_CLASS[type])
    expect(new Set(classes).size).toBe(classes.length)
    expect(classes.every((name) => name.startsWith('MermaidCode__'))).toBe(true)
    expect(MERMAID_TOKEN_CLASS.text).toBe('')
  })
})
