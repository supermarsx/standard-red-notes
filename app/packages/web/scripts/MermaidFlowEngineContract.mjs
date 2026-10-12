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

/** What mermaid's flowchart parser is handed for a source: `Diagram.text`, then its wrapper's one rewrite. */
const parsedTextOf = async (source) => {
  let diagram
  try {
    diagram = await api.getDiagramFromText(source)
  } catch (error) {
    // The text mermaid parsed is not available when parsing threw. Detection
    // alone can say whether this was a flowchart at all.
    return { failed: String(error?.message ?? error).split('\n')[0] }
  }
  return { type: diagram.type, text: diagram.text.replace(/}\s*\n/g, '}\n') }
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
