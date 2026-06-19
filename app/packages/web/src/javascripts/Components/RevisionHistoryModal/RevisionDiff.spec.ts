import { NoteContent, NoteType } from '@standardnotes/snjs'
import {
  buildSplitRows,
  computeDiffStats,
  computeLineDiff,
  DiffLine,
  getDiffableTextFromContent,
} from './RevisionDiff'

const noteContent = (overrides: Partial<NoteContent>): NoteContent => {
  return {
    title: '',
    text: '',
    references: [],
    ...overrides,
  } as unknown as NoteContent
}

const textsOf = (lines: DiffLine[]) => lines.map((line) => `${line.type}:${line.text}`)

describe('computeLineDiff', () => {
  it('produces no added/removed lines for identical inputs', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nb\nc')

    expect(diff).toHaveLength(3)
    expect(diff.every((line) => line.type === 'context')).toBe(true)
    expect(diff.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  it('returns an empty diff when both inputs are empty', () => {
    expect(computeLineDiff('', '')).toEqual([])
  })

  it('handles pure additions (empty -> content)', () => {
    const diff = computeLineDiff('', 'a\nb')

    expect(diff).toEqual([
      { type: 'added', oldNumber: null, newNumber: 1, text: 'a' },
      { type: 'added', oldNumber: null, newNumber: 2, text: 'b' },
    ])
  })

  it('handles additions in the middle preserving line numbers', () => {
    const diff = computeLineDiff('a\nc', 'a\nb\nc')

    expect(textsOf(diff)).toEqual(['context:a', 'added:b', 'context:c'])
    const added = diff.find((line) => line.type === 'added')
    expect(added).toEqual({ type: 'added', oldNumber: null, newNumber: 2, text: 'b' })
    // The trailing context line keeps a consistent old/new numbering.
    expect(diff[2]).toEqual({ type: 'context', oldNumber: 2, newNumber: 3, text: 'c' })
  })

  it('handles pure deletions (content -> empty)', () => {
    const diff = computeLineDiff('a\nb', '')

    expect(diff).toEqual([
      { type: 'removed', oldNumber: 1, newNumber: null, text: 'a' },
      { type: 'removed', oldNumber: 2, newNumber: null, text: 'b' },
    ])
  })

  it('handles deletions in the middle preserving line numbers', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nc')

    expect(textsOf(diff)).toEqual(['context:a', 'removed:b', 'context:c'])
    expect(diff[1]).toEqual({ type: 'removed', oldNumber: 2, newNumber: null, text: 'b' })
    expect(diff[2]).toEqual({ type: 'context', oldNumber: 3, newNumber: 2, text: 'c' })
  })

  it('handles a single-line modification as a remove + add', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nB\nc')

    expect(textsOf(diff)).toEqual(['context:a', 'removed:b', 'added:B', 'context:c'])
    expect(diff[1]).toMatchObject({ type: 'removed', oldNumber: 2, newNumber: null })
    expect(diff[2]).toMatchObject({ type: 'added', oldNumber: null, newNumber: 2 })
    expect(diff[3]).toEqual({ type: 'context', oldNumber: 3, newNumber: 3, text: 'c' })
  })

  it('handles a complete replacement of all lines', () => {
    const diff = computeLineDiff('a\nb', 'x\ny')

    const removed = diff.filter((line) => line.type === 'removed').map((line) => line.text)
    const added = diff.filter((line) => line.type === 'added').map((line) => line.text)
    expect(removed).toEqual(['a', 'b'])
    expect(added).toEqual(['x', 'y'])
    expect(diff.some((line) => line.type === 'context')).toBe(false)
  })

  it('normalizes CRLF line endings before diffing', () => {
    const diff = computeLineDiff('a\r\nb', 'a\nb')

    expect(diff.every((line) => line.type === 'context')).toBe(true)
    expect(diff).toHaveLength(2)
  })

  it('treats a trailing newline as an added empty line', () => {
    const diff = computeLineDiff('a', 'a\n')

    expect(textsOf(diff)).toEqual(['context:a', 'added:'])
    expect(diff[1]).toEqual({ type: 'added', oldNumber: null, newNumber: 2, text: '' })
  })

  it('treats removing a trailing newline as a removed empty line', () => {
    const diff = computeLineDiff('a\n', 'a')

    expect(textsOf(diff)).toEqual(['context:a', 'removed:'])
    expect(diff[1]).toEqual({ type: 'removed', oldNumber: 2, newNumber: null, text: '' })
  })

  it('produces correct line numbers across mixed add/remove/context blocks', () => {
    const diff = computeLineDiff('a\nb\nc\nd', 'a\nx\nc\nd\ne')

    expect(textsOf(diff)).toEqual(['context:a', 'removed:b', 'added:x', 'context:c', 'context:d', 'added:e'])
    expect(diff[diff.length - 1]).toEqual({ type: 'added', oldNumber: null, newNumber: 5, text: 'e' })
  })
})

describe('buildSplitRows', () => {
  it('mirrors context lines on both sides', () => {
    const diff = computeLineDiff('a\nb', 'a\nb')
    const rows = buildSplitRows(diff)

    expect(rows).toHaveLength(2)
    rows.forEach((row) => {
      expect(row.left).not.toBeNull()
      expect(row.left).toBe(row.right)
    })
  })

  it('pairs a removed line with an added line on the same row (modification)', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nB\nc')
    const rows = buildSplitRows(diff)

    // context, the modified row, context
    expect(rows).toHaveLength(3)
    expect(rows[1].left).toMatchObject({ type: 'removed', text: 'b' })
    expect(rows[1].right).toMatchObject({ type: 'added', text: 'B' })
  })

  it('fills the shorter side with null when removed/added counts differ', () => {
    // Two removed, one added in the same contiguous block.
    const diff = computeLineDiff('a\nb\nc\nd', 'a\nX\nd')
    const rows = buildSplitRows(diff)

    const changeRows = rows.filter((row) => {
      const left = row.left
      const right = row.right
      return (left && left.type !== 'context') || (right && right.type !== 'context')
    })

    // First change row: removed 'b' paired with added 'X'. Second: removed 'c' with null right.
    expect(changeRows[0].left).toMatchObject({ type: 'removed', text: 'b' })
    expect(changeRows[0].right).toMatchObject({ type: 'added', text: 'X' })
    expect(changeRows[1].left).toMatchObject({ type: 'removed', text: 'c' })
    expect(changeRows[1].right).toBeNull()
  })

  it('pairs pure additions with null left side', () => {
    const diff = computeLineDiff('', 'a\nb')
    const rows = buildSplitRows(diff)

    expect(rows).toHaveLength(2)
    rows.forEach((row) => {
      expect(row.left).toBeNull()
      expect(row.right).not.toBeNull()
    })
  })

  it('pairs pure deletions with null right side', () => {
    const diff = computeLineDiff('a\nb', '')
    const rows = buildSplitRows(diff)

    expect(rows).toHaveLength(2)
    rows.forEach((row) => {
      expect(row.right).toBeNull()
      expect(row.left).not.toBeNull()
    })
  })

  it('returns no rows for an empty diff', () => {
    expect(buildSplitRows([])).toEqual([])
  })
})

describe('computeDiffStats', () => {
  it('counts zero changes for identical content', () => {
    expect(computeDiffStats(computeLineDiff('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 })
  })

  it('counts pure additions', () => {
    expect(computeDiffStats(computeLineDiff('', 'a\nb\nc'))).toEqual({ added: 3, removed: 0 })
  })

  it('counts pure deletions', () => {
    expect(computeDiffStats(computeLineDiff('a\nb\nc', ''))).toEqual({ added: 0, removed: 3 })
  })

  it('counts a modification as one add and one remove', () => {
    expect(computeDiffStats(computeLineDiff('a\nb\nc', 'a\nB\nc'))).toEqual({ added: 1, removed: 1 })
  })

  it('returns zero stats for an empty diff', () => {
    expect(computeDiffStats([])).toEqual({ added: 0, removed: 0 })
  })
})

describe('getDiffableTextFromContent', () => {
  it('returns the raw text for a plain note with no title', () => {
    const content = noteContent({ noteType: NoteType.Plain, title: '', text: 'hello\nworld' })
    expect(getDiffableTextFromContent(content)).toBe('hello\nworld')
  })

  it('prepends the title for a plain note', () => {
    const content = noteContent({ noteType: NoteType.Plain, title: 'My Note', text: 'body' })
    expect(getDiffableTextFromContent(content)).toBe('My Note\nbody')
  })

  it('handles missing title and text gracefully', () => {
    const content = noteContent({ noteType: NoteType.Plain, title: undefined, text: undefined })
    expect(getDiffableTextFromContent(content)).toBe('')
  })

  it('does not attempt Lexical parsing for non-Super notes', () => {
    const lexicalLooking = '{"root":{"children":[]}}'
    const content = noteContent({ noteType: NoteType.Plain, title: '', text: lexicalLooking })
    // Plain notes keep the raw JSON string untouched.
    expect(getDiffableTextFromContent(content)).toBe(lexicalLooking)
  })

  it('decodes a Super note Lexical JSON payload into plain text', () => {
    const lexical = JSON.stringify({
      root: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: 'First paragraph' }],
          },
          {
            type: 'heading',
            children: [{ type: 'text', text: 'A Heading' }],
          },
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'Line one' },
              { type: 'linebreak' },
              { type: 'text', text: 'Line two' },
            ],
          },
        ],
      },
    })

    const content = noteContent({ noteType: NoteType.Super, title: 'Super Title', text: lexical })

    expect(getDiffableTextFromContent(content)).toBe(
      'Super Title\nFirst paragraph\nA Heading\nLine one\nLine two',
    )
  })

  it('falls back to the raw string when a Super note text is not valid JSON', () => {
    const content = noteContent({ noteType: NoteType.Super, title: '', text: 'not json at all' })
    expect(getDiffableTextFromContent(content)).toBe('not json at all')
  })

  it('falls back to the raw string when Super JSON lacks a root', () => {
    const text = JSON.stringify({ notRoot: true })
    const content = noteContent({ noteType: NoteType.Super, title: '', text })
    expect(getDiffableTextFromContent(content)).toBe(text)
  })

  it('strips trailing blank lines produced by Lexical extraction', () => {
    const lexical = JSON.stringify({
      root: {
        type: 'root',
        children: [
          { type: 'paragraph', children: [{ type: 'text', text: 'content' }] },
          { type: 'paragraph', children: [] },
        ],
      },
    })
    const content = noteContent({ noteType: NoteType.Super, title: '', text: lexical })
    expect(getDiffableTextFromContent(content)).toBe('content')
  })

  it('produces text that round-trips through computeLineDiff with no diff for unchanged Super content', () => {
    const lexical = JSON.stringify({
      root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'same' }] }] },
    })
    const content = noteContent({ noteType: NoteType.Super, title: 'T', text: lexical })
    const text = getDiffableTextFromContent(content)
    const diff = computeLineDiff(text, text)
    expect(computeDiffStats(diff)).toEqual({ added: 0, removed: 0 })
  })
})
