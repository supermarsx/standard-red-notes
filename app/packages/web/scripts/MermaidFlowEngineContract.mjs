// The visual builder's engine, checked against the REAL mermaid.
//
// The builder edits a flowchart by changing a few characters of its text, and
// it finds those characters with mermaid's own grammar, embedded as data
// (MermaidFlowGrammar.ts) and run by MermaidSourceDoc.ts. Three things can make
// that wrong, and jest can see none of them, because jest cannot load mermaid:
//
//   - the embedded grammar is not the installed library's (an upgrade);
//   - the text handed to the embedded lexer is not the text mermaid hands its
//     own (mermaid rewrites a diagram six times before parsing it);
//   - the lexer run here does not make the tokens mermaid's lexer makes.
//
// This script asks the installed library directly, under Node with jsdom's
// globals, and drives the app's own sources through Node's type stripping.
// MermaidFlowEngineContract.spec.ts starts it as a child process, so it runs
// wherever `yarn test` runs, and reads its exit code and the JSON summary on
// its last line.
//
//   node scripts/MermaidFlowEngineContract.mjs          what the gate runs
//   node scripts/MermaidFlowEngineContract.mjs --all    every single-character deletion of every corpus text
//
// The gate runs every deletion of the 37 common forms and every seventh of the
// longer samples; --all runs all of them and takes about a minute.
import { buildMermaidFlowGrammar } from './GenerateMermaidFlowGrammar.mjs'
import { api, flowParser, mermaidVersion, NODES } from './MermaidUnderNode.mjs'

const Grammar = await import(`${NODES}/MermaidFlowGrammar.ts`)
const SourceDoc = await import(`${NODES}/MermaidSourceDoc.ts`)
const Oracle = await import(`${NODES}/MermaidOracle.ts`)
const Corpus = await import(`${NODES}/MermaidFlowCorpus.fixture.ts`)

const everyDeletion = process.argv.includes('--all')
const SAMPLE_STRIDE = 7

const checks = []
const counts = {}
const check = async (name, body) => {
  try {
    const detail = await body()
    checks.push({ name, ok: true, detail: detail ?? '' })
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error?.message ?? error) })
  }
}
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const quoted = (text) => JSON.stringify(text.length > 160 ? text.slice(0, 160) + '…' : text)

// ---------------------------------------------------------------------------
// The texts: the corpus, and texts one character short of a corpus entry —
// most of which mermaid no longer accepts, which is the point.
// ---------------------------------------------------------------------------
const texts = []
const commonNames = new Set(Corpus.MERMAID_FLOW_COMMON_FORMS.map((entry) => entry.name))
for (const { name, source } of Corpus.MERMAID_FLOW_CORPUS) {
  texts.push({ name, text: source, whole: true })
  const stride = everyDeletion || commonNames.has(name) ? 1 : SAMPLE_STRIDE
  for (let index = 0; index < source.length; index += stride) {
    texts.push({ name: `${name}, without character ${index}`, text: source.slice(0, index) + source.slice(index + 1) })
  }
}
counts.corpus = Corpus.MERMAID_FLOW_CORPUS.length
counts.commonForms = Corpus.MERMAID_FLOW_COMMON_FORMS.length
counts.texts = texts.length

// ---------------------------------------------------------------------------
// Mermaid's own parser object, and its lexer driven the way its parser drives it.
// ---------------------------------------------------------------------------
const parser = await flowParser()

const FLOWCHART_TYPES = new Set(['flowchart', 'flowchart-v2'])

/**
 * What mermaid makes of a source, asked once: the text its flowchart parser
 * was handed (`Diagram.text`, then its wrapper's one rewrite), and — for a
 * flowchart — its database read through the app's one adapter.
 */
const parsedTextOf = async (source) => {
  let diagram
  try {
    diagram = await api.getDiagramFromText(source)
  } catch (error) {
    // Neither is available when parsing threw.
    return { failed: String(error?.message ?? error).split('\n')[0] }
  }
  const text = diagram.text.replace(/}\s*\n/g, '}\n')
  if (!FLOWCHART_TYPES.has(diagram.type)) {
    return { type: diagram.type, text }
  }
  return { type: diagram.type, text, reading: Oracle.mermaidFlowReadingFromDatabase(diagram.db) }
}

/** Mermaid's lexer over a text: each token's name (null when it hands the parser nothing is not observable here) and match. */
const mermaidTokens = (text) => {
  const lexer = parser.lexer
  let first = true
  lexer.setInput(text, {
    lex: {
      firstGraph: () => {
        const was = first
        first = false
        return was
      },
    },
  })
  const tokens = []
  for (let guard = 0; guard < text.length * 4 + 64; guard++) {
    let token
    try {
      token = lexer.lex()
    } catch {
      tokens.push({ token: '!lexical error', text: '' })
      return tokens
    }
    if (token === lexer.EOF) {
      return tokens
    }
    tokens.push({ token: typeof token === 'number' ? parser.terminals_[token] : token, text: lexer.match })
  }
  tokens.push({ token: '!did not finish', text: '' })
  return tokens
}

// ===========================================================================
// 1. The grammar.
// ===========================================================================
await check('the grammar the builder runs is the installed mermaid’s, rule for rule and state for state', async () => {
  const installed = await buildMermaidFlowGrammar()
  const embedded = Grammar.MERMAID_FLOW_GRAMMAR
  for (const key of Object.keys(installed)) {
    assert(
      same(installed[key], embedded[key]),
      `MermaidFlowGrammar.ts was generated from mermaid ${embedded.mermaid} and its "${key}" is not what mermaid ${installed.mermaid} has. ` +
        'Run `node scripts/GenerateMermaidFlowGrammar.mjs --write`, then this contract again.',
    )
  }
  assert(same(Object.keys(installed).sort(), Object.keys(embedded).sort()), 'the two grammars have different fields')
  counts.lexRules = embedded.lexRules.length
  counts.parserStates = embedded.table.length
  return `mermaid ${installed.mermaid}: ${embedded.lexRules.length} lexer rules, ${embedded.table.length} parser states`
})

await check('every production of that grammar has a meaning in the document', async () => {
  const unhandled = SourceDoc.unhandledMermaidFlowProductions()
  assert(unhandled.length === 0, `no handler and not a pass-through: ${unhandled.join(' | ')}`)
})

// ===========================================================================
// 2. The text the lexer is handed, and the tokens it makes of it.
// ===========================================================================
const observed = []
for (const entry of texts) {
  observed.push({
    ...entry,
    mermaid: await parsedTextOf(entry.text),
    document: SourceDoc.parseMermaidFlowSource(entry.text),
  })
}

await check('the builder hands its lexer exactly the text mermaid hands its own parser', async () => {
  let compared = 0
  for (const { name, text, mermaid, document } of observed) {
    if (mermaid.text === undefined) {
      continue
    }
    compared++
    assert(
      mermaid.text === document.parsedText,
      `${name}: mermaid parses ${quoted(mermaid.text)}, the builder lexes ${quoted(document.parsedText)} — source ${quoted(text)}`,
    )
  }
  assert(compared >= 1000, `only ${compared} texts were compared: the corpus has stopped testing the preprocessing`)
  counts.preprocessed = compared
  return `${compared} texts mermaid parsed`
})

await check('the builder’s tokens are mermaid’s tokens, name for name and character for character', async () => {
  let compared = 0
  let tokens = 0
  for (const { name, text, document } of observed) {
    if (document.problem?.kind === 'not-flowchart') {
      continue
    }
    const theirs = mermaidTokens(document.parsedText)
    const ours = SourceDoc.lexMermaidFlowSource(text).filter((token) => token.token !== null)
    const lexicalError = theirs.length > 0 && theirs[theirs.length - 1].token === '!lexical error'
    if (lexicalError) {
      // Mermaid's lexer threw: the builder's must have stopped at the same token.
      assert(
        document.problem?.kind === 'lexical',
        `${name}: mermaid's lexer rejects the text and the builder reports ${document.problem?.kind ?? 'no problem'}`,
      )
      theirs.pop()
    } else {
      assert(document.problem?.kind !== 'lexical', `${name}: the builder's lexer rejects a text mermaid's lexes`)
    }
    assert(
      same(ours, theirs),
      `${name}: ${quoted(JSON.stringify(ours))} against mermaid's ${quoted(JSON.stringify(theirs))}`,
    )
    compared++
    tokens += ours.length
  }
  assert(compared >= 2000, `only ${compared} texts were lexed`)
  counts.lexed = compared
  counts.tokens = tokens
  return `${tokens} tokens over ${compared} texts`
})

await check('printing every text gives it back, byte for byte', async () => {
  for (const { name, text, document } of observed) {
    assert(SourceDoc.printMermaidFlowDocument(document) === text, `${name}: printed differently`)
  }
  return `${observed.length} texts`
})

// ===========================================================================
// 3. Mermaid's database, read through the app's one adapter, and the reading
//    the builder makes of the same text.
// ===========================================================================
const lines = (...parts) => parts.join('\n')

await check('mermaid’s flowchart database is the shape the builder’s one adapter reads', async () => {
  // Through the app's own path — MermaidRuntime's queue, then the adapter — on
  // a diagram that uses every part of the database the builder relies on. If
  // an upgrade renames a getter or changes what one returns, this is where it
  // is said, by name.
  const source = lines(
    'flowchart LR',
    '  A[One] e1@-->|go| B(Two)',
    '  B -.-> C',
    '  subgraph g [Group]',
    '    direction TB',
    '    C --> D{{Four}}',
    '  end',
    '  classDef hot fill:#f96',
    '  class A hot',
    '  style B fill:#eee',
    '  click A href "https://example.com" "tip"',
    '  linkStyle 1 stroke:#f00',
    '  linkStyle default stroke-width:2px',
  )
  const result = await Oracle.readMermaidFlowchart(source)
  assert(result.ok, `mermaid's reading was refused: ${result.message}`)
  const { reading } = result
  const node = (id) => reading.nodes.find((entry) => entry.id === id)
  assert(
    same(
      reading.nodes.map((entry) => entry.id),
      ['A', 'B', 'C', 'D'],
    ),
    `boxes: ${JSON.stringify(reading.nodes)}`,
  )
  assert(
    same(
      [node('A').text, node('A').type, node('A').labelType, node('A').classes],
      ['One', 'square', 'text', ['hot', 'clickable']],
    ),
    `A: ${JSON.stringify(node('A'))}`,
  )
  assert(same([node('B').type, node('B').styles], ['round', ['fill:#eee']]), `B: ${JSON.stringify(node('B'))}`)
  assert(node('C').type === undefined && node('C').text === 'C', `C: ${JSON.stringify(node('C'))}`)
  assert(node('D').type === 'hexagon', `D: ${JSON.stringify(node('D'))}`)
  assert(
    String(node('A').extra?.link).includes('example.com'),
    `A's link is not in extra: ${JSON.stringify(node('A'))}`,
  )
  assert(
    same(
      reading.edges.map((edge) => [
        edge.start,
        edge.end,
        edge.type,
        edge.stroke,
        edge.length,
        edge.text,
        edge.id ?? null,
      ]),
      [
        ['A', 'B', 'arrow_point', 'normal', 1, 'go', 'e1'],
        ['B', 'C', 'arrow_point', 'dotted', 1, '', null],
        ['C', 'D', 'arrow_point', 'normal', 1, '', null],
      ],
    ),
    `links: ${JSON.stringify(reading.edges)}`,
  )
  assert(
    same(reading.edges[1].style, ['stroke:#f00', 'fill:none']),
    `link 1 style: ${JSON.stringify(reading.edges[1])}`,
  )
  assert(
    same(
      reading.groups.map((group) => [group.id, group.title, [...group.nodes].sort(), group.dir, group.labelType]),
      [['g', 'Group', ['C', 'D'], 'TB', 'text']],
    ),
    `groups: ${JSON.stringify(reading.groups)}`,
  )
  assert(
    same(reading.classes, [{ id: 'hot', styles: ['fill:#f96'], textStyles: [] }]),
    `classes: ${JSON.stringify(reading.classes)}`,
  )
  assert(
    same(reading.defaultLinkStyle, ['stroke-width:2px']),
    `default link style: ${JSON.stringify(reading.defaultLinkStyle)}`,
  )
  assert(same(reading.extra?.tooltips, [['A', 'tip']]), `tooltips: ${JSON.stringify(reading.extra)}`)

  const other = await Oracle.readMermaidFlowchart('sequenceDiagram\n  A->>B: hi')
  assert(!other.ok && other.kind === 'not-flowchart' && other.diagramType === 'sequence', JSON.stringify(other))
  const broken = await Oracle.readMermaidFlowchart('flowchart LR\n  A -->')
  assert(!broken.ok && broken.kind === 'rejected' && /Parse error/.test(broken.message), JSON.stringify(broken))
  return 'boxes, links, groups, named styles, link styles, tooltips; another kind; a text mermaid rejects'
})

await check('every corpus text reads the same to the builder and to mermaid', async () => {
  let compared = 0
  let common = 0
  for (const { name, text, whole, mermaid, document } of observed) {
    if (!whole) {
      continue
    }
    assert(
      mermaid.reading !== undefined,
      `${name}: mermaid does not read this corpus text as a flowchart (${mermaid.failed ?? mermaid.type})`,
    )
    assert(
      document.problem === null,
      `${name}: the builder refuses it — ${document.problem?.kind}: ${document.problem?.message}`,
    )
    const differences = SourceDoc.compareMermaidFlowReadings(document.reading, mermaid.reading)
    assert(differences.length === 0, `${name}: ${differences.join(' ;; ')} — source ${quoted(text)}`)
    assert(
      document.edges.length === mermaid.reading.edges.length,
      `${name}: the builder places ${document.edges.length} links, mermaid has ${mermaid.reading.edges.length}`,
    )
    compared++
    common += commonNames.has(name) ? 1 : 0
  }
  assert(compared === Corpus.MERMAID_FLOW_CORPUS.length, `${compared} of ${Corpus.MERMAID_FLOW_CORPUS.length} compared`)
  counts.corpusRead = compared
  counts.commonFormsRead = common
  return `${compared} texts, ${common} of them the common forms`
})

await check('one character short of a corpus text, the builder never reads something mermaid does not', async () => {
  // Four outcomes are possible for a damaged text. Two are fine: both read it
  // and read the same, or both refuse. One is tolerated and bounded: mermaid
  // refuses for YAML the document does not parse — a frontmatter block, the
  // inside of `@{ … }` — and at run time the oracle is what refuses those.
  // The other two are faults: a different reading, or a refusal of a text
  // mermaid reads.
  const yamlRefusal = /^(No such shape|bad indentation|end of the stream|missed comma|can not read)/
  let sameReading = 0
  let bothRefuse = 0
  let yamlOnly = 0
  for (const { name, text, whole, mermaid, document } of observed) {
    if (whole) {
      continue
    }
    if (mermaid.reading === undefined) {
      if (document.problem !== null) {
        bothRefuse++
        continue
      }
      const carriesYaml = text.includes('@{') || /^\s*---/.test(text)
      assert(
        carriesYaml && mermaid.failed !== undefined && yamlRefusal.test(mermaid.failed),
        `${name}: the builder reads a text mermaid refuses (${mermaid.failed ?? mermaid.type}) — source ${quoted(text)}`,
      )
      yamlOnly++
      continue
    }
    assert(
      document.problem === null,
      `${name}: the builder refuses (${document.problem?.kind}: ${document.problem?.message}) a text mermaid reads — source ${quoted(text)}`,
    )
    const differences = SourceDoc.compareMermaidFlowReadings(document.reading, mermaid.reading)
    assert(differences.length === 0, `${name}: ${differences.join(' ;; ')} — source ${quoted(text)}`)
    assert(document.edges.length === mermaid.reading.edges.length, `${name}: link count`)
    sameReading++
  }
  counts.deletionsSameReading = sameReading
  counts.deletionsBothRefuse = bothRefuse
  counts.deletionsMermaidRefusesYaml = yamlOnly
  assert(sameReading >= 1000, `only ${sameReading} damaged texts were still read by both`)
  assert(bothRefuse >= 500, `only ${bothRefuse} damaged texts were refused by both`)
  return `${sameReading} read the same, ${bothRefuse} refused by both, ${yamlOnly} refused by mermaid alone for their YAML`
})

const failed = checks.filter((entry) => !entry.ok)
for (const entry of checks) {
  console.error(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail ? ' — ' + entry.detail : ''}`)
}
console.log(
  JSON.stringify({
    ok: failed.length === 0,
    mermaid: mermaidVersion,
    node: process.version,
    everyDeletion,
    checks,
    counts,
  }),
)
process.exit(failed.length === 0 ? 0 : 1)
