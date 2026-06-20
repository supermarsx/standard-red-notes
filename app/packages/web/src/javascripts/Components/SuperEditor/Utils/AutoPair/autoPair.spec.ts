import { applyAction, decideBackspace, decideInsertion, AutoPairContext } from './autoPair'

/** Build a context from a string where `|` marks a collapsed caret, or
 * `[` … `]` (via two markers) marks a selection. We use a small DSL: the test
 * passes explicit offsets instead to stay unambiguous. */
function ctx(text: string, start: number, end: number = start): AutoPairContext {
  return { text, selection: { start, end } }
}

/** Helper: run decide + apply for a typed char and return the resulting string
 * with a `|` inserted at the caret (or [..] around a selection) for easy asserts. */
function typeChar(char: string, c: AutoPairContext): string {
  const action = decideInsertion(char, c)
  if (action.type === 'none') {
    // Simulate the editor's own default insert (replace selection with char).
    const before = c.text.slice(0, c.selection.start)
    const after = c.text.slice(c.selection.end)
    const newText = before + char + after
    const caret = c.selection.start + char.length
    return render({ text: newText, selection: { start: caret, end: caret } })
  }
  return render(applyAction(action, c))
}

function render(c: AutoPairContext): string {
  const { text, selection } = c
  if (selection.start === selection.end) {
    return text.slice(0, selection.start) + '|' + text.slice(selection.start)
  }
  return text.slice(0, selection.start) + '[' + text.slice(selection.start, selection.end) + ']' + text.slice(selection.end)
}

describe('autoPair – insert pair (collapsed caret)', () => {
  it.each([
    ['(', '(|)'],
    ['[', '[|]'],
    ['{', '{|}'],
    ['"', '"|"'],
    ["'", "'|'"],
    ['`', '`|`'],
  ])('typing %s on empty inserts a pair', (char, expected) => {
    expect(typeChar(char, ctx('', 0))).toBe(expected)
  })

  it('inserts a bracket pair mid-text', () => {
    // "ab|cd" typing ( -> "ab(|)cd"
    expect(typeChar('(', ctx('abcd', 2))).toBe('ab(|)cd')
  })

  it('does not pair `<` by default', () => {
    expect(typeChar('<', ctx('a b', 1))).toBe('a<| b')
  })
})

describe('autoPair – wrap selection', () => {
  it('wraps a bracket around the selection and keeps it selected', () => {
    // select "bc" in "abcd", type ( -> "a(bc)d" with bc selected
    expect(typeChar('(', ctx('abcd', 1, 3))).toBe('a([bc])d')
  })

  it('wraps a quote around the selection', () => {
    // select "hello", type " -> "hello" with hello selected -> ["hello"]
    expect(typeChar('"', ctx('hello', 0, 5))).toBe('"[hello]"')
  })

  it('wraps with square brackets', () => {
    expect(typeChar('[', ctx('word', 0, 4))).toBe('[[word]]')
  })

  it('does nothing special for a non-opener typed over a selection', () => {
    // typing "x" over selection "bc" -> default replace
    expect(typeChar('x', ctx('abcd', 1, 3))).toBe('ax|d')
  })
})

describe('autoPair – type over closer', () => {
  it('types over a matching close bracket', () => {
    // "(|)" typing ) -> "()|"
    expect(typeChar(')', ctx('()', 1))).toBe('()|')
  })

  it('types over a matching quote', () => {
    // '"|"' typing " -> '""|'
    expect(typeChar('"', ctx('""', 1))).toBe('""|')
  })

  it('inserts a real close bracket when next char is not the closer', () => {
    // "a|b" typing ) -> "a)|b"
    expect(typeChar(')', ctx('ab', 1))).toBe('a)|b')
  })
})

describe('autoPair – apostrophe / quote suppression', () => {
  it('does not pair an apostrophe right after a word char (contraction)', () => {
    // "don|" typing ' -> "don'|"  (no closing quote)
    expect(typeChar("'", ctx('don', 3))).toBe("don'|")
  })

  it('does not pair a quote directly before a word char', () => {
    // "|word" typing " -> '"|word'
    expect(typeChar('"', ctx('word', 0))).toBe('"|word')
  })

  it('still pairs a quote between spaces', () => {
    // "a | b" typing " -> 'a "|" b'
    expect(typeChar('"', ctx('a  b', 2))).toBe('a "|" b')
  })
})

describe('autoPair – backspace deletes empty pair', () => {
  it('deletes both chars of an empty bracket pair', () => {
    const action = decideBackspace(ctx('()', 1))
    expect(action.type).toBe('delete-pair')
    expect(render(applyAction(action, ctx('()', 1)))).toBe('|')
  })

  it('deletes both chars of an empty quote pair', () => {
    const action = decideBackspace(ctx('""', 1))
    expect(action.type).toBe('delete-pair')
    expect(render(applyAction(action, ctx('""', 1)))).toBe('|')
  })

  it('deletes empty pair embedded in text', () => {
    // "a()b" caret between -> "ab"
    expect(render(applyAction(decideBackspace(ctx('a()b', 2)), ctx('a()b', 2)))).toBe('a|b')
  })

  it('does nothing for a non-empty pair', () => {
    // "(x)" caret after ( -> not an empty pair
    expect(decideBackspace(ctx('(x)', 1)).type).toBe('none')
  })

  it('does nothing for mismatched neighbours', () => {
    expect(decideBackspace(ctx('(]', 1)).type).toBe('none')
  })

  it('does nothing with a non-collapsed selection', () => {
    expect(decideBackspace(ctx('()', 0, 2)).type).toBe('none')
  })

  it('does nothing at the start or end of text', () => {
    expect(decideBackspace(ctx('()', 0)).type).toBe('none')
    expect(decideBackspace(ctx('()', 2)).type).toBe('none')
  })
})

describe('autoPair – no-op cases', () => {
  it('returns none for a normal letter', () => {
    expect(decideInsertion('a', ctx('', 0)).type).toBe('none')
  })

  it('returns none for a closer with no matching next char', () => {
    expect(decideInsertion('}', ctx('abc', 3)).type).toBe('none')
  })
})
