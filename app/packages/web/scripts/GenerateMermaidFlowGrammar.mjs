// Mermaid's flowchart grammar, taken from the INSTALLED package as data.
//
// The visual builder has to know exactly where in a diagram's text each box and
// link is written. A hand-written recogniser can only approximate mermaid's
// grammar, and every place it differs is a place the builder would edit the
// wrong characters. So the builder does not recognise anything by hand: it runs
// mermaid's own lexer rules and mermaid's own LALR table (MermaidSourceDoc.ts),
// and this script is where those come from.
//
//   node scripts/GenerateMermaidFlowGrammar.mjs            prints whether the checked-in file is current
//   node scripts/GenerateMermaidFlowGrammar.mjs --write    rewrites MermaidFlowGrammar.ts
//
// After a mermaid upgrade, run it with --write and then run the engine contract
// (scripts/MermaidFlowEngineContract.mjs): the contract fails until the file
// matches the installed library, and it is the contract — not this script —
// that says whether the builder still reads diagrams the way the new mermaid
// does.
//
// What is read, all of it from the generated jison parser object:
//   - `lexer.rules` and `lexer.conditions`: data, copied.
//   - `lexer.performAction`: CODE. Each `case` is translated into a few
//     operations from a closed vocabulary (push a state, pop, return a token,
//     the two rewrites of a shape-data value, the first-graph switch). A
//     statement outside that vocabulary stops the script: it never guesses.
//   - `table`, `productions_`, `symbols_`: data, copied (the table in a compact
//     text form).
// The parser's own `performAction` — the code that calls mermaid's FlowDB — is
// NOT copied. MermaidSourceDoc.ts has its own handlers, keyed by production
// shape, and the contract test compares what they read with what mermaid reads.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { flowParser, mermaidVersion, NODES } from './MermaidUnderNode.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const GRAMMAR_FILE = join(here, NODES, 'MermaidFlowGrammar.ts')

const fail = (message) => {
  throw new Error(`GenerateMermaidFlowGrammar: ${message}`)
}

/** `case N: … break;` bodies of the lexer's action function, by rule index. */
function lexerCaseBodies(source, ruleCount) {
  const bodies = new Map()
  const pattern = /case (\d+):/g
  const starts = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    starts.push({ rule: Number(match[1]), from: match.index + match[0].length, at: match.index })
  }
  const end = source.lastIndexOf('}', source.lastIndexOf('}') - 1)
  starts.forEach((start, index) => {
    const until = index + 1 < starts.length ? starts[index + 1].at : end
    bodies.set(start.rule, source.slice(start.from, until))
  })
  for (let rule = 0; rule < ruleCount; rule++) {
    if (!bodies.has(rule)) {
      fail(`lexer rule ${rule} has no action`)
    }
  }
  if (bodies.size !== ruleCount) {
    fail(`the lexer has ${ruleCount} rules and ${bodies.size} actions`)
  }
  return bodies
}

/** One action body as operations, or an error naming the statement nobody taught this script. */
function translateLexerAction(rule, body, symbols) {
  const operations = []
  let rest = body.replace(/\s+/g, ' ').trim()
  const take = (pattern, operation) => {
    const found = pattern.exec(rest)
    if (!found) {
      return false
    }
    operations.push(typeof operation === 'function' ? operation(found) : operation)
    rest = rest.slice(found[0].length).trim()
    return true
  }
  const token = (name) => {
    if (/^\d+$/.test(name)) {
      return `=${name}`
    }
    return name in symbols ? `=${symbols[name]}` : `=?${name}`
  }
  while (rest.length > 0) {
    const progressed =
      take(/^this\.(?:begin|pushState)\("(\w+)"\);/, (found) => `+${found[1]}`) ||
      take(/^this\.popState\(\);/, '-') ||
      take(/^return (\d+);/, (found) => token(found[1])) ||
      take(/^return "([^"]+)";/, (found) => token(found[1])) ||
      take(/^yy_\.yytext = "";/, 'e') ||
      take(/^const re = \/\\n\\s\*\/g; yy_\.yytext = yy_\.yytext\.replace\(re, "<br\/>"\);/, 'b') ||
      take(/^if \(yy\.lex\.firstGraph\(\)\) \{ this\.begin\("dir"\); \}/, 'g') ||
      take(/^break;/, '')
    if (!progressed) {
      fail(`lexer rule ${rule} does something this script was never taught: ${JSON.stringify(rest)}`)
    }
  }
  return operations.filter((operation) => operation !== '').join(' ')
}

/** A state's actions as text: `s12:8,9 r4:11 g7:20 a:1`, symbols grouped by what they do. */
function encodeState(row) {
  const groups = new Map()
  for (const [symbol, action] of Object.entries(row)) {
    let key
    if (typeof action === 'number') {
      key = `g${action}`
    } else if (Array.isArray(action) && action.length === 2 && action[0] === 1) {
      key = `s${action[1]}`
    } else if (Array.isArray(action) && action.length === 2 && action[0] === 2) {
      key = `r${action[1]}`
    } else if (Array.isArray(action) && action.length === 1 && action[0] === 3) {
      key = 'a'
    } else {
      fail(`a table action this script does not know: ${JSON.stringify(action)}`)
    }
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(symbol)
  }
  return [...groups.entries()].map(([key, symbols]) => `${key}:${symbols.join(',')}`).join(' ')
}

/**
 * Every production with its right-hand side: `left>symbol,symbol`.
 *
 * Jison's runtime keeps only each production's LENGTH; the symbols themselves
 * are recovered from the automaton. A state that reduces production p was
 * reached by reading p's right-hand side, so walking the transitions backwards
 * that many steps spells it out — and of the walks that exist, the right one is
 * the one that starts in a state with a goto on p's left-hand side. That must
 * leave exactly one answer; anything else stops the script. A production no
 * state reduces is written `left>?length`: nothing can ever build it.
 *
 * The document's handlers are keyed by these shapes rather than by production
 * number, so a grammar that renumbers its productions cannot hand one
 * production's tokens to another's handler.
 */
function productionShapes(parser) {
  const forward = parser.table.map((row) => {
    const moves = new Map()
    for (const [symbol, action] of Object.entries(row)) {
      if (typeof action === 'number') {
        moves.set(Number(symbol), action)
      } else if (action[0] === 1) {
        moves.set(Number(symbol), action[1])
      }
    }
    return moves
  })
  const backward = parser.table.map(() => [])
  forward.forEach((moves, state) => moves.forEach((target, symbol) => backward[target].push([state, symbol])))

  const found = new Map()
  parser.table.forEach((row, state) => {
    for (const action of Object.values(row)) {
      if (!Array.isArray(action) || action[0] !== 2) {
        continue
      }
      const production = action[1]
      const [left, length] = parser.productions_[production]
      let walks = [[state, []]]
      for (let step = 0; step < length; step++) {
        walks = walks.flatMap(([at, symbols]) => backward[at].map(([from, symbol]) => [from, [symbol, ...symbols]]))
      }
      for (const [origin, symbols] of walks) {
        if (forward[origin].has(left)) {
          if (!found.has(production)) {
            found.set(production, new Set())
          }
          found.get(production).add(symbols.join(','))
        }
      }
    }
  })

  return parser.productions_.slice(1).map(([left, length], index) => {
    const production = index + 1
    const shapes = found.get(production)
    if (!shapes) {
      return `${left}>?${length}`
    }
    if (shapes.size !== 1) {
      fail(`production ${production} could be read ${shapes.size} ways: ${[...shapes].join(' | ')}`)
    }
    const [shape] = [...shapes]
    if ((shape === '' ? 0 : shape.split(',').length) !== length) {
      fail(`production ${production} has length ${length} but was recovered as "${shape}"`)
    }
    return `${left}>${shape}`
  })
}

/** The grammar, as the plain object MermaidFlowGrammar.ts carries. */
export async function buildMermaidFlowGrammar() {
  const parser = await flowParser()
  const lexer = parser.lexer

  if (Object.keys(lexer.options ?? {}).length > 0) {
    fail(`the lexer has options now (${JSON.stringify(lexer.options)}): first-match-wins is no longer a given`)
  }
  if (Object.keys(parser.defaultActions ?? {}).length > 0) {
    fail('the parser has default actions now: the driver in MermaidSourceDoc.ts does not apply them')
  }

  const symbols = []
  for (const [name, id] of Object.entries(parser.symbols_)) {
    symbols[id] = name
  }
  for (let id = 0; id < symbols.length; id++) {
    if (typeof symbols[id] !== 'string') {
      fail(`symbol ${id} has no name`)
    }
  }

  const lexRules = lexer.rules.map((rule, index) => {
    if (rule.flags !== '') {
      fail(`lexer rule ${index} has flags "${rule.flags}"`)
    }
    const source = rule.source
    if (!source.startsWith('^(?:') || !source.endsWith(')')) {
      fail(`lexer rule ${index} is not anchored the way jison writes them: ${source.slice(0, 40)}`)
    }
    // The document's lexer runs each rule sticky at an offset rather than
    // against a slice. Those are the same thing only for a rule that cannot
    // look behind its own first character.
    const body = source.slice(1)
    if (/\(\?<[=!]/.test(body) || /^\(\?:\\[bB]/.test(body)) {
      fail(`lexer rule ${index} looks behind its start: ${source.slice(0, 40)}`)
    }
    return body
  })

  const lexConditions = {}
  for (const [name, condition] of Object.entries(lexer.conditions)) {
    lexConditions[name] = condition.rules.join(',')
  }
  if (!('INITIAL' in lexConditions)) {
    fail('the lexer has no INITIAL condition')
  }

  const bodies = lexerCaseBodies(lexer.performAction.toString(), lexer.rules.length)
  const lexActions = lexer.rules.map((_rule, index) => translateLexerAction(index, bodies.get(index), parser.symbols_))

  const terminals = Object.keys(parser.terminals_)
    .map(Number)
    .sort((a, b) => a - b)

  return {
    mermaid: mermaidVersion,
    symbols,
    terminals: terminals.join(','),
    productions: productionShapes(parser).join(' '),
    table: parser.table.map(encodeState),
    lexRules,
    lexConditions,
    lexActions,
  }
}

/** The text of MermaidFlowGrammar.ts for a grammar object. */
export function renderGrammarModule(grammar) {
  const json = JSON.stringify(grammar)
  const literal = "'" + json.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
  return [
    '/**',
    ' * GENERATED — do not edit. `node scripts/GenerateMermaidFlowGrammar.mjs --write` rewrites it.',
    ' *',
    ` * Mermaid ${grammar.mermaid}'s own flowchart grammar, as data: its lexer's rules, conditions`,
    ' * and actions, and its LALR table. MermaidSourceDoc.ts runs them, so the builder',
    ' * splits a diagram into tokens and statements exactly where mermaid does.',
    ' *',
    ' * It is a copy, and a copy can go stale. scripts/MermaidFlowEngineContract.mjs',
    ' * rebuilds this object from the installed package on every test run and fails',
    ' * when the two differ — so a mermaid upgrade cannot leave the builder reading',
    ' * diagrams with the previous version’s grammar.',
    ' */',
    'export type MermaidFlowGrammarData = {',
    '  /** The mermaid version this was generated from. */',
    '  mermaid: string',
    '  /** Symbol names by symbol number, terminals and non-terminals alike. */',
    '  symbols: string[]',
    '  /** The symbol numbers that are terminals, comma separated. */',
    '  terminals: string',
    '  /** `left>symbol,symbol` per production, space separated, production 1 first; `left>?n` is one nothing reduces. */',
    '  productions: string',
    '  /** Per parser state: `s<state>` shift, `r<production>` reduce, `g<state>` goto, `a` accept, each `:symbols`. */',
    '  table: string[]',
    '  /** Lexer rule bodies, to be run sticky at an offset. */',
    '  lexRules: string[]',
    '  /** Per lexer condition, the rules it tries, in order. */',
    '  lexConditions: Record<string, string>',
    '  /** Per lexer rule: `+state` push, `-` pop, `=n` return symbol n, `=?NAME` return a name the parser has no symbol for, `e`/`b` rewrite a shape-data value, `g` the first-graph switch. */',
    '  lexActions: string[]',
    '}',
    '',
    // Broken after the `=` because that is where prettier breaks it, and
    // `yarn format:check` reads this file like any other.
    'const SERIALIZED =',
    `  ${literal}`,
    '',
    'export const MERMAID_FLOW_GRAMMAR: MermaidFlowGrammarData = JSON.parse(SERIALIZED) as MermaidFlowGrammarData',
    '',
  ].join('\n')
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const grammar = await buildMermaidFlowGrammar()
  const text = renderGrammarModule(grammar)
  let current = null
  try {
    current = readFileSync(GRAMMAR_FILE, 'utf8')
  } catch {
    current = null
  }
  if (process.argv.includes('--write')) {
    writeFileSync(GRAMMAR_FILE, text)
    console.log(`wrote ${GRAMMAR_FILE} from mermaid ${grammar.mermaid} (${text.length} bytes)`)
  } else if (current === text) {
    console.log(`MermaidFlowGrammar.ts is current for mermaid ${grammar.mermaid}`)
  } else {
    console.error(`MermaidFlowGrammar.ts does not match mermaid ${grammar.mermaid}. Run with --write.`)
    process.exit(1)
  }
}
