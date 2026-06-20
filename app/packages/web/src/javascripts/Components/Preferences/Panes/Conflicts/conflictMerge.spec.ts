import {
  buildConflictMergePrompt,
  DEFAULT_CONFLICT_INPUT_BUDGET,
  isUsableMergeReply,
  postProcessMergeReply,
  prepareConflictInputText,
} from './conflictMerge'

describe('prepareConflictInputText', () => {
  it('returns trimmed, newline-normalized text under budget unchanged', () => {
    expect(prepareConflictInputText('  hello\r\nworld  ')).toBe('hello\nworld')
  })

  it('truncates on a whitespace boundary when over budget', () => {
    const text = 'word '.repeat(50) // 250 chars
    const out = prepareConflictInputText(text, 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.endsWith(' ')).toBe(false)
    expect(out).toBe('word word word word')
  })

  it('falls back to a hard cut when no whitespace is in range', () => {
    const out = prepareConflictInputText('a'.repeat(100), 10)
    expect(out).toBe('a'.repeat(10))
  })

  it('uses the default budget when given a non-positive budget', () => {
    const text = 'x'.repeat(DEFAULT_CONFLICT_INPUT_BUDGET + 100)
    const out = prepareConflictInputText(text, 0)
    expect(out.length).toBe(DEFAULT_CONFLICT_INPUT_BUDGET)
  })

  it('handles null/undefined safely', () => {
    expect(prepareConflictInputText(undefined as unknown as string)).toBe('')
  })
})

describe('buildConflictMergePrompt', () => {
  it('includes both versions clearly delimited', () => {
    const { system, user } = buildConflictMergePrompt({ localText: 'Local body', remoteText: 'Remote body' })
    expect(system).toContain('merge')
    expect(user).toContain('VERSION A')
    expect(user).toContain('VERSION B')
    expect(user).toContain('Local body')
    expect(user).toContain('Remote body')
  })

  it('asks the model for ONLY the merged note with the title on the first line', () => {
    const { system, user } = buildConflictMergePrompt({ localText: 'a', remoteText: 'b' })
    expect(system.toLowerCase()).toContain('first line')
    expect(user.toLowerCase()).toContain('first line = title')
  })

  it('budgets each side independently', () => {
    const big = 'word '.repeat(5000) // ~25k chars
    const { user } = buildConflictMergePrompt({ localText: big, remoteText: big }, 100)
    // Both budgeted slices must be present and bounded; the prompt should not contain
    // the full 25k-char input.
    expect(user.length).toBeLessThan(big.length)
  })
})

describe('postProcessMergeReply', () => {
  it('normalizes line endings and trims trailing whitespace', () => {
    expect(postProcessMergeReply('Title\r\nBody  \n')).toBe('Title\nBody')
  })

  it('strips a code fence wrapping the entire reply', () => {
    expect(postProcessMergeReply('```\nTitle\nBody\n```')).toBe('Title\nBody')
    expect(postProcessMergeReply('```markdown\nTitle\nBody\n```')).toBe('Title\nBody')
  })

  it('does NOT strip a fenced block that is only part of the note', () => {
    const input = 'My note\n\n```js\nconst x = 1\n```\n\nmore text'
    expect(postProcessMergeReply(input)).toBe(input)
  })

  it('returns empty string for empty/whitespace input', () => {
    expect(postProcessMergeReply('   \n  ')).toBe('')
    expect(postProcessMergeReply(undefined as unknown as string)).toBe('')
  })
})

describe('isUsableMergeReply', () => {
  it('accepts ordinary merged content', () => {
    expect(isUsableMergeReply('My Title\nBody content here')).toBe(true)
  })

  it('accepts a short one-line note', () => {
    expect(isUsableMergeReply('Buy milk')).toBe(true)
  })

  it('rejects empty content', () => {
    expect(isUsableMergeReply('')).toBe(false)
    expect(isUsableMergeReply('   ')).toBe(false)
  })

  it('rejects common AI refusal/apology shapes', () => {
    expect(isUsableMergeReply("I'm sorry, but I can't merge these.")).toBe(false)
    expect(isUsableMergeReply('I cannot complete this request.')).toBe(false)
    expect(isUsableMergeReply('As an AI language model, I am unable to...')).toBe(false)
  })
})
