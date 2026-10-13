/**
 * @jest-environment node
 *
 * The lossless document, without any one kind of diagram.
 *
 * `MermaidFlowDoc.spec.ts` pins what the flowchart reader makes of a text. This
 * file pins what is underneath it and would be underneath a second kind of
 * diagram too: that a kind is a grammar plus handlers plus a reader and nothing
 * more (shown with a second, deliberately tiny, reader over the same grammar),
 * and the text surgery every operation is built from — splices that cannot
 * overlap, lines added without disturbing their neighbours, and the refusal to
 * rewrite characters that do not stand for themselves.
 */
import { MERMAID_FLOW_GRAMMAR } from './MermaidFlowGrammar'
import {
  applyMermaidSourceSplices,
  compileMermaidGrammar,
  lexMermaidSource,
  MermaidEditRefusal,
  MermaidReadFailure,
  MermaidSourceBench,
  type MermaidSourceHandler,
  type MermaidSourceLanguage,
  mermaidSourceLineAt,
  MermaidSourceReader,
  parseMermaidSource,
  plainMermaidLabel,
  printMermaidSourceDocument,
} from './MermaidSourceDoc'

const src = (...lines: string[]): string => lines.join('\n')

// ---------------------------------------------------------------------------
// A second reader over mermaid's flowchart grammar: it counts boxes and keeps
// the ids it saw, and knows nothing else. It stands in for "another kind of
// diagram" — which is exactly this much code plus its own grammar file.
// ---------------------------------------------------------------------------
class CountingReader extends MermaidSourceReader {
  ids: string[] = []
}

const EVERY_SHAPE = compileMermaidGrammar<CountingReader>(MERMAID_FLOW_GRAMMAR, {}, new Set()).unhandled
const BARE_BOX = 'vertex: idString'

const countingLanguage = (
  handlers: Record<string, MermaidSourceHandler<CountingReader>>,
): MermaidSourceLanguage<CountingReader, { ids: string[] }> => ({
  recognises: /^\s*(?:graph|flowchart)\b/,
  otherKind: 'Not something the counting reader counts.',
  grammar: compileMermaidGrammar<CountingReader>(
    MERMAID_FLOW_GRAMMAR,
    handlers,
    new Set(EVERY_SHAPE.filter((shape) => !(shape in handlers))),
  ),
  rewrites: [],
  begin: (source, pieces) => new CountingReader(source, pieces),
  finish: (reader) => ({ ids: reader.ids }),
})

const COUNTING = countingLanguage({
  [BARE_BOX]: (kids, reader) => {
    reader.ids.push(`${String(kids[0].value)}@${reader.span(kids[0]).start}`)
    return kids[0].value
  },
})

describe('a kind of diagram is a grammar, handlers and a reader', () => {
  it('runs another reader’s handlers over the same grammar, and hands them where things are', () => {
    const source = src('flowchart LR', '  A --> B', '  B --> C')
    const document = parseMermaidSource(source, COUNTING)
    expect(document.problem).toBeNull()
    expect(document.result).toEqual({ ids: ['A@15', 'B@21', 'B@25', 'C@31'] })
    expect(printMermaidSourceDocument(document)).toBe(source)
  })

  it('says a text is another kind in that kind’s own words, and still prints it back', () => {
    const source = src('sequenceDiagram', '  A->>B: hi')
    const document = parseMermaidSource(source, COUNTING)
    expect(document.problem).toMatchObject({ kind: 'other-kind', message: 'Not something the counting reader counts.' })
    expect(document.result).toBeNull()
    expect(printMermaidSourceDocument(document)).toBe(source)
  })

  it('reports where a handler gave up, with the kind of trouble the handler named', () => {
    const refusing = countingLanguage({
      [BARE_BOX]: (kids) => {
        if (kids[0].value === 'B') {
          throw new MermaidReadFailure('rejected', 'no box may be called B')
        }
        return kids[0].value
      },
    })
    const document = parseMermaidSource(src('flowchart LR', '  A --> B'), refusing)
    expect(document.problem).toEqual({ kind: 'rejected', message: 'no box may be called B', offset: 21, line: 1 })
    expect(document.result).toBeNull()
  })

  it('does not read at all with a grammar that has a production nobody gave a meaning to', () => {
    // Every production but the bare box is declared pass-through, and the bare
    // box is left out of both lists.
    const incomplete: MermaidSourceLanguage<CountingReader, { ids: string[] }> = {
      ...COUNTING,
      grammar: compileMermaidGrammar<CountingReader>(
        MERMAID_FLOW_GRAMMAR,
        {},
        new Set(EVERY_SHAPE.filter((shape) => shape !== BARE_BOX)),
      ),
    }
    expect(incomplete.grammar.unhandled).toEqual([BARE_BOX])
    const source = src('flowchart LR', '  A --> B')
    const document = parseMermaidSource(source, incomplete)
    expect(document.problem).toMatchObject({ kind: 'unsure' })
    expect(document.problem?.message).toContain(BARE_BOX)
    expect(printMermaidSourceDocument(document)).toBe(source)
  })

  it('keys handlers by the production’s shape, so every production of the grammar has a name', () => {
    expect(EVERY_SHAPE).toContain('vertex: idString SQS text SQE')
    expect(EVERY_SHAPE).toContain('statement: subgraph SPACE textNoTags SQS text SQE separator document end')
    expect(EVERY_SHAPE.length).toBeGreaterThan(150)
    expect(new Set(EVERY_SHAPE).size).toBe(EVERY_SHAPE.length)
  })

  it('applies a kind’s own parser-wrapper rewrite, and keeps what it removed as a piece', () => {
    const trimming: MermaidSourceLanguage<CountingReader, { ids: string[] }> = {
      ...COUNTING,
      // Take the spaces that end a line out before lexing, as a wrapper might.
      rewrites: [{ pattern: / +\n/g, remove: (match) => ({ from: 0, to: match[0].length - 1 }) }],
    }
    const source = 'flowchart LR\n  A --> B   \n'
    expect(lexMermaidSource(source, COUNTING).map((token) => token.text)).toContain(' ')
    const document = parseMermaidSource(source, trimming)
    expect(document.parsedText).toBe('flowchart LR\n  A --> B\n\n')
    expect(document.pieces.filter((piece) => piece.kind === 'space').map((piece) => piece.text)).toEqual(['   '])
    expect(printMermaidSourceDocument(document)).toBe(source)
  })
})

describe('mermaidSourceLineAt', () => {
  it('finds the line of an offset, a terminator belonging to the line it ends', () => {
    const { lines } = parseMermaidSource('ab\r\ncd\nef', COUNTING)
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

describe('splices', () => {
  it('replaces, removes and inserts, whatever order they are given in', () => {
    expect(
      applyMermaidSourceSplices('0123456789', [
        { start: 8, end: 10, text: '' },
        { start: 0, end: 1, text: 'zero' },
        { start: 4, end: 4, text: '-' },
      ]),
    ).toBe('zero123-4567')
  })

  it('keeps two insertions at one place in the order they were given', () => {
    expect(
      applyMermaidSourceSplices('ab', [
        { start: 1, end: 1, text: 'first ' },
        { start: 1, end: 1, text: 'second ' },
      ]),
    ).toBe('afirst second b')
  })

  it('refuses two splices that would change the same characters, rather than pick one', () => {
    expect(
      applyMermaidSourceSplices('0123456789', [
        { start: 2, end: 6, text: 'x' },
        { start: 5, end: 7, text: 'y' },
      ]),
    ).toBeNull()
  })

  it('changes nothing when given nothing', () => {
    expect(applyMermaidSourceSplices('as it was', [])).toBe('as it was')
  })
})

describe('the bench an operation works at', () => {
  const benchFor = (source: string) => {
    const document = parseMermaidSource(source, COUNTING)
    return { bench: new MermaidSourceBench(document), document }
  }
  const apply = (source: string, bench: MermaidSourceBench, line: number, indent: string, texts: string[]) =>
    applyMermaidSourceSplices(source, [bench.linesAfter(line, indent, texts)])

  it('adds lines after a line, in the text’s own line ending', () => {
    const unix = src('flowchart LR', '  A --> B', '  B --> C')
    expect(apply(unix, benchFor(unix).bench, 1, '  ', ['X', 'Y'])).toBe(
      src('flowchart LR', '  A --> B', '  X', '  Y', '  B --> C'),
    )
    const windows = 'flowchart LR\r\n  A --> B\r\n  B --> C\r\n'
    expect(apply(windows, benchFor(windows).bench, 1, '\t', ['X'])).toBe(
      'flowchart LR\r\n  A --> B\r\n\tX\r\n  B --> C\r\n',
    )
  })

  it('adds a line after the last one without inventing a trailing line ending', () => {
    const source = src('flowchart LR', '  A --> B')
    expect(apply(source, benchFor(source).bench, 1, '  ', ['X'])).toBe(src('flowchart LR', '  A --> B', '  X'))
    const windows = 'flowchart LR\r\n  A --> B'
    expect(apply(windows, benchFor(windows).bench, 1, '  ', ['X'])).toBe('flowchart LR\r\n  A --> B\r\n  X')
  })

  it('takes a whole line out with its line ending — the one before it, for the last line', () => {
    const source = src('flowchart LR', '  A --> B', '  B --> C')
    const { bench } = benchFor(source)
    expect(applyMermaidSourceSplices(source, [bench.withoutLine(1)])).toBe(src('flowchart LR', '  B --> C'))
    expect(applyMermaidSourceSplices(source, [bench.withoutLine(2)])).toBe(src('flowchart LR', '  A --> B'))
  })

  it('reads a line’s indentation as it is written, tabs included', () => {
    const { bench } = benchFor(src('flowchart LR', '\t  A --> B', 'C'))
    expect([bench.indentOfLine(0), bench.indentOfLine(1), bench.indentOfLine(2)]).toEqual(['', '\t  ', ''])
    expect([bench.lineOf(0), bench.lineOf(14), bench.lineOf(26)]).toEqual([0, 1, 2])
  })

  it('will not rewrite a range that holds a comment, and says which line', () => {
    const source = src('flowchart LR', '  A', '  %% between', '    --> B')
    const { bench } = benchFor(source)
    const statement = { start: source.indexOf('A'), end: source.length }
    expect(bench.isClean(statement)).toBe(false)
    expect(bench.isClean({ start: source.indexOf('A'), end: source.indexOf('A') + 1 })).toBe(true)
    let refusal: unknown
    try {
      bench.requireClean(statement, 'This statement')
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(MermaidEditRefusal)
    expect(refusal).toMatchObject({
      message: 'This statement is written in a way the builder will not rewrite; edit it in the code.',
      line: 1,
    })
  })

  it('will not rewrite half of an entity code', () => {
    // Outside a label, mermaid's placeholder for `#9829;` is lexed as several
    // tokens that all stand for the same six characters.
    const source = src('flowchart LR', '  A#9829;B --> C')
    const { bench, document } = benchFor(source)
    expect(document.pieces.some((piece) => piece.irregular)).toBe(true)
    expect(bench.isClean({ start: source.indexOf('A'), end: source.indexOf(' -->') })).toBe(false)
    expect(printMermaidSourceDocument(document)).toBe(source)
  })
})
