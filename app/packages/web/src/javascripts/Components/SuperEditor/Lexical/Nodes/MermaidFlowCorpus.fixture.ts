/**
 * Flowcharts as people actually write them — the texts the visual builder is
 * tested against, by its unit specs and by the engine contract alike
 * (scripts/MermaidFlowEngineContract.mjs, which asks the installed mermaid what
 * each of them means).
 *
 * `MERMAID_FLOW_COMMON_FORMS` is the list the builder plan counted: 37 ordinary
 * ways of writing a flowchart, of which the builder this engine replaces
 * refused 19. One of the plan's 37 was not what its name said — its backslashes
 * were eaten by the JavaScript string it was written in, leaving a plain box —
 * so here that entry really is a slanted pair.
 *
 * `MERMAID_FLOW_SAMPLES` is everything else worth having an opinion about:
 * whole diagrams with comments, blank lines, mixed indentation, Windows line
 * endings, configuration, styling, nested groups; and the awkward corners of
 * mermaid's grammar, one per entry so a failure names its cause.
 */
export type MermaidFlowCorpusEntry = { name: string; source: string }

const BACKSLASH = String.fromCharCode(92)
const BACKTICK = String.fromCharCode(96)
const lines = (...parts: string[]): string => parts.join('\n')

export const MERMAID_FLOW_COMMON_FORMS: MermaidFlowCorpusEntry[] = [
  {
    name: 'the block’s starter',
    source: lines('graph TD', '  A[Start] --> B{Decision}', '  B -->|Yes| C[OK]', '  B -->|No| D[Rethink]'),
  },
  { name: 'flowchart keyword', source: lines('flowchart LR', '  A[Start] --> B[End]') },
  { name: 'chained links', source: lines('flowchart LR', '  A --> B --> C') },
  { name: 'ampersand fan-out', source: lines('flowchart TD', '  A --> B & C') },
  { name: 'text on the link', source: lines('flowchart LR', '  A -- yes --> B') },
  { name: 'semicolons', source: lines('graph TD;', '  A-->B;', '  A-->C;') },
  { name: 'header and statement on one line', source: 'graph TD; A-->B' },
  { name: 'subgraph', source: lines('flowchart TB', '  subgraph one', '    a1 --> a2', '  end', '  c1 --> a2') },
  { name: 'class shorthand', source: lines('flowchart LR', '  A:::hot --> B', '  classDef hot fill:#f96') },
  {
    name: 'classDef and class',
    source: lines('flowchart LR', '  A --> B', '  classDef hot fill:#f96', '  class A hot'),
  },
  {
    name: 'style statement',
    source: lines('flowchart LR', '  A --> B', '  style A fill:#f9f,stroke:#333,stroke-width:4px'),
  },
  { name: 'new shape syntax', source: lines('flowchart TD', '  A@{ shape: cyl, label: "DB" } --> B') },
  { name: 'circle and cross ends', source: lines('flowchart LR', '  A --o B', '  B --x C') },
  { name: 'bidirectional', source: lines('flowchart LR', '  A <--> B') },
  { name: 'long link', source: lines('flowchart TD', '  A ---> B') },
  { name: 'invisible link', source: lines('flowchart LR', '  A ~~~ B') },
  { name: 'dotted with text', source: lines('flowchart LR', '  A -. text .-> B') },
  { name: 'thick with text', source: lines('flowchart LR', '  A == text ==> B') },
  {
    name: 'slanted boxes',
    source: lines('flowchart TD', '  A[/Input/] --> B[' + BACKSLASH + 'Output' + BACKSLASH + ']'),
  },
  { name: 'flag', source: lines('flowchart LR', '  A>Flag] --> B') },
  { name: 'double circle', source: lines('flowchart LR', '  A(((Stop))) --> B') },
  {
    name: 'markdown string label',
    source: lines('flowchart LR', '  A["' + BACKTICK + '**bold** text' + BACKTICK + '"] --> B'),
  },
  { name: 'hyphenated id', source: lines('flowchart LR', '  my-node[Hi] --> other-node') },
  { name: 'unicode id', source: lines('flowchart LR', '  début[Start] --> fin[End]') },
  { name: 'click statement', source: lines('flowchart LR', '  A --> B', '  click A href "https://example.com"') },
  {
    name: 'frontmatter title and config',
    source: lines('---', 'title: T', 'config:', '  theme: forest', '---', 'flowchart LR', '  A --> B'),
  },
  { name: 'init directive', source: lines('%%{init: {"theme":"forest"}}%%', 'flowchart LR', '  A --> B') },
  { name: 'comment mid-body', source: lines('flowchart LR', '  A --> B', '  %% step two', '  B --> C') },
  { name: 'linkStyle', source: lines('flowchart LR', '  A --> B', '  linkStyle 0 stroke:#f00') },
  { name: 'edge id and animate', source: lines('flowchart LR', '  A e1@--> B', '  e1@{ animate: true }') },
  { name: 'direction in body', source: lines('flowchart LR', '  direction TB', '  A --> B') },
  { name: 'TB header', source: lines('flowchart TB', '  A --> B') },
  { name: 'no direction', source: lines('flowchart', '  A --> B') },
  { name: 'label with parens quoted', source: lines('flowchart LR', '  A["call(x)"] --> B') },
  { name: 'entity code', source: lines('flowchart LR', '  A["a #quot;q#quot; b"] --> B') },
  { name: 'br in label', source: lines('flowchart LR', '  A["line1<br/>line2"] --> B') },
  {
    name: 'labels with spaces and link text',
    source: lines(
      'flowchart LR',
      '  A[Hard edge] -->|Link text| B(Round edge)',
      '  B --> C{Decision}',
      '  C -->|One| D[Result one]',
      '  C -->|Two| E[Result two]',
    ),
  },
]

/** A release pipeline the way an assistant writes one: everything at once. */
const RELEASE_PIPELINE = lines(
  '---',
  'title: Release pipeline',
  'config:',
  '  theme: neutral',
  '  flowchart:',
  '    curve: linear',
  '---',
  '%% Release pipeline, generated 2026-10-01',
  'flowchart TD',
  '    %% --- intake ---',
  '    Start([Commit pushed]) --> Lint{Lint passes?}',
  '    Lint -- no --> Fix[Fix the errors]',
  '    Fix --> Start',
  '    Lint -- yes --> Build[[Build image]]',
  '',
  '    subgraph ci [Continuous integration]',
  '        direction LR',
  '        Build --> Unit[Unit tests] & Types[Type check]',
  '        Unit --> Gate{All green?}',
  '        Types --> Gate',
  '    end',
  '',
  '    Gate -->|no| Fix',
  '    Gate ==>|yes| Stage[(Staging)]',
  '    Stage -.->|smoke| Prod((Production))',
  '',
  '    classDef danger fill:#fdd,stroke:#c00,stroke-width:2px;',
  '    classDef done fill:#dfd,stroke:#090',
  '    class Fix danger',
  '    class Prod done',
  '    style Start fill:#eef,stroke:#339',
  '    linkStyle 1 stroke:#c00,stroke-width:2px',
  '    linkStyle 7,8 stroke:#090',
  '    click Prod href "https://example.com/prod" "Open production" _blank',
)

const NESTED_THREE_DEEP = lines(
  'flowchart LR',
  '  subgraph outer [Outer]',
  '    subgraph middle [Middle]',
  '      subgraph inner [Inner]',
  '        a1[One] --> a2[Two]',
  '      end',
  '      b1 --> a1',
  '    end',
  '    c1 --> b1',
  '  end',
  '  d1 --> c1',
  '  d1 --> outer',
)

const EVERY_ARROW = lines(
  'flowchart LR',
  '  A --> B',
  '  B --- C',
  '  C -.-> D',
  '  D ==> E',
  '  E --o F',
  '  F --x G',
  '  G <--> H',
  '  H o--o I',
  '  I x--x J',
  '  J ---> K',
  '  K ----> L',
  '  L -.- M',
  '  M -..-> N',
  '  N === O',
  '  O ===> P',
  '  P ~~~ Q',
  '  Q <-.-> R',
  '  R <==> S',
  '  S -- text --- T',
  '  T -. text .-> U',
  '  U == text ==> V',
  '  V -->|text| W',
  '  W ---|text| X',
  '  X -.->|text| Y',
  '  Y ==>|text| Z',
)

const EVERY_BRACKET_SHAPE = lines(
  'flowchart TD',
  '  A[Box] --> B(Round)',
  '  C([Pill]) --> D[[Subroutine]]',
  '  E[(Database)] --> F((Circle))',
  '  G>Flag] --> H{Decision}',
  '  I{{Hexagon}} --> J[/Lean right/]',
  '  K[' + BACKSLASH + 'Lean left' + BACKSLASH + '] --> L[/Trapezoid' + BACKSLASH + ']',
  '  M[' + BACKSLASH + 'Inverted/] --> N(((Double circle)))',
  '  O(-Ellipse-) --> A',
)

export const MERMAID_FLOW_SAMPLES: MermaidFlowCorpusEntry[] = [
  { name: 'a whole pipeline', source: RELEASE_PIPELINE },
  { name: 'a whole pipeline, Windows line endings', source: RELEASE_PIPELINE.replace(/\n/g, '\r\n') },
  { name: 'a whole pipeline, ending in a newline', source: RELEASE_PIPELINE + '\n' },
  { name: 'groups nested three deep', source: NESTED_THREE_DEEP },
  { name: 'every arrow', source: EVERY_ARROW },
  { name: 'every bracket shape', source: EVERY_BRACKET_SHAPE },
  {
    name: 'tabs, spaces and blank lines',
    source: lines('flowchart TD', '', '\tA[One]', '\t\tA --> B', '', '    B --> C', '  \t', 'C --> A', ''),
  },
  {
    name: 'old Mac line endings',
    source: ['flowchart LR', '  A --> B', '  B --> C'].join('\r'),
  },
  {
    name: 'chains and fans together',
    source: lines('flowchart LR', '  A & B --> C & D --> E', '  E --> F --> G & H'),
  },
  {
    name: 'a chain continued on the next line',
    source: lines('flowchart LR', '  A --> B', '    --> C', '    --> D'),
  },
  {
    name: 'a cross-ended link that looks like a box called x',
    source: lines('flowchart LR', '  A --> B', '  x--> C'),
  },
  {
    name: 'a link glued to an id that starts with o',
    source: lines('flowchart LR', '  A---oB', '  A --- oC'),
  },
  {
    name: 'a label given twice',
    source: lines('flowchart LR', '  A[Start] --> B', '  A[Renamed later]'),
  },
  {
    name: 'a shape given twice',
    source: lines('flowchart LR', '  A(Round) --> B', '  A[Box later]'),
  },
  {
    name: 'declared after use',
    source: lines('flowchart LR', '  A --> B', '  A[Start]', '  A --> C', '  A'),
  },
  {
    name: 'two links between the same boxes',
    source: lines('flowchart LR', '  A --> B', '  A --> B', '  A -.-> B', '  linkStyle 2 stroke:#00f'),
  },
  {
    name: 'linkStyle list, default and interpolate',
    source: lines(
      'flowchart LR',
      '  A --> B',
      '  B --> C',
      '  C --> D',
      '  linkStyle default stroke:#999',
      '  linkStyle 0,2 stroke:#f00',
      '  linkStyle 1 interpolate basis stroke:#0f0',
    ),
  },
  {
    name: 'quoted labels with awkward starts',
    source: lines(
      'flowchart LR',
      '  A["/path/to/file/"] --> B["(optional)"]',
      '  C(("(c)")) --> D("-dashed-")',
      '  E[">= 3"] --> F["|x|"]',
    ),
  },
  {
    name: 'unicode labels',
    source: lines('flowchart LR', '  A[Café ☕] --> B["日本語のラベル"]', '  B --> C[Ünïcödé — dash]'),
  },
  {
    name: 'markdown strings everywhere',
    source: lines(
      'flowchart LR',
      '  A["' + BACKTICK + 'The **cat** in' + BACKTICK + '"] -- "' + BACKTICK + 'an _edge_' + BACKTICK + '" --> B',
      '  subgraph "' + BACKTICK + '**Group**' + BACKTICK + '"',
      '    B --> C',
      '  end',
    ),
  },
  {
    name: 'keywords inside ids',
    source: lines(
      'graph TD',
      '  A["a"]',
      '  A --> end1',
      '  end1["x"]',
      '  graphite --> subgraphed',
      '  default --> A',
    ),
  },
  {
    name: 'a group with a quoted title and no id',
    source: lines(
      'flowchart TB',
      '  subgraph "Phase one"',
      '    a --> b',
      '  end',
      '  subgraph Phase two',
      '    c',
      '  end',
    ),
  },
  {
    name: 'a box in two groups',
    source: lines(
      'flowchart TB',
      '  subgraph first',
      '    a --> b',
      '  end',
      '  subgraph second',
      '    b --> c',
      '  end',
    ),
  },
  {
    name: 'links to and from a group',
    source: lines(
      'flowchart TB',
      '  subgraph one',
      '    a',
      '  end',
      '  one --> z',
      '  z --> one',
      '  style one fill:#eee',
    ),
  },
  {
    name: 'class on several boxes',
    source: lines(
      'flowchart LR',
      '  A --> B --> C',
      '  classDef hot,cold fill:#f96',
      '  class A,B hot',
      '  class C cold',
    ),
  },
  {
    name: 'click forms',
    source: lines(
      'flowchart LR',
      '  A --> B --> C --> D',
      '  click A callback "Tooltip"',
      '  click B call callback()',
      '  click C "https://example.com" "tip" _blank',
      '  click D href "https://example.com"',
    ),
  },
  {
    name: 'accessibility lines',
    source: lines(
      'flowchart LR',
      '  accTitle: The title',
      '  accDescr: One line of description',
      '  A --> B',
      '  accDescr {',
      '    several',
      '    lines',
      '  }',
    ),
  },
  {
    name: 'shape data on several lines',
    source: lines(
      'flowchart TD',
      '  A@{',
      '    shape: rounded',
      '    label: "Two',
      '    lines"',
      '  }',
      '  A --> B@{ shape: diamond }',
    ),
  },
  {
    name: 'a label over two lines',
    source: lines('flowchart LR', '  A["first', '  second"] --> B'),
  },
  {
    name: 'a style line ending in a semicolon after a colour',
    source: lines('flowchart LR', '  A --> B;', '  style A fill:#f9f;', '  classDef k stroke:#333;'),
  },
  {
    name: 'entity codes in labels and on a link',
    source: lines('flowchart LR', '  A["#35;1 #amp; co"] -->|"a #quot;b#quot;"| B[plain #9829; heart]'),
  },
  {
    name: 'html in a label',
    source: lines('flowchart LR', '  A["<b>bold</b> and <i class="x">italic</i>"] --> B["a < b"]'),
  },
  {
    name: 'two init directives and a wrap',
    source: lines('%%{init: {"theme":"dark"}}%%', '%%{wrap}%%', 'graph LR', '  A --> B'),
  },
  {
    name: 'indented frontmatter and leading blank lines',
    source: lines('  ---', '  title: Indented', '  ---', '', '', '  flowchart LR', '    A --> B'),
  },
  {
    name: 'a comment at the very end and one at the start',
    source: lines('%% top', 'flowchart LR', '  A --> B', '%% bottom'),
  },
  {
    name: 'a line that only mentions a direction',
    source: lines('flowchart LR', '  A[go in direction TB] --> B', '  B --> C'),
  },
  {
    name: 'an edge with an id, styled by class',
    source: lines('flowchart LR', '  A e1@==> B', '  A e2@--> C', '  classDef hot stroke:#f00', '  class e1 hot'),
  },
  {
    name: 'a box with a property',
    source: lines('flowchart LR', '  A[|borders:lt|Text] --> B'),
  },
  {
    name: 'old direction words',
    source: lines('graph >', '  A --> B'),
  },
  {
    name: 'everything on one line',
    source: 'graph LR; A[One]-->B(Two); B-->C{Three}; C-->|yes|A; style A fill:#eee',
  },
]

/** The whole corpus: the 37 common forms first. */
export const MERMAID_FLOW_CORPUS: MermaidFlowCorpusEntry[] = [...MERMAID_FLOW_COMMON_FORMS, ...MERMAID_FLOW_SAMPLES]
