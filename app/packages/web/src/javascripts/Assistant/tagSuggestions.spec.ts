import {
  buildTagSuggestionPrompt,
  DEFAULT_TAG_INPUT_BUDGET,
  MAX_SUGGESTED_TAGS,
  MAX_TAG_LENGTH,
  parseSuggestedTags,
  prepareTagInputText,
  sanitizeTag,
} from './tagSuggestions'

describe('prepareTagInputText', () => {
  it('returns trimmed, newline-normalized text under budget unchanged', () => {
    expect(prepareTagInputText('  hello\r\nworld  ')).toBe('hello\nworld')
  })

  it('truncates on a whitespace boundary when over budget', () => {
    const text = 'word '.repeat(50) // 250 chars
    const out = prepareTagInputText(text, 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.endsWith(' ')).toBe(false)
    // Should not end mid-word.
    expect(out).toBe('word word word word')
  })

  it('falls back to a hard cut when no whitespace is in range', () => {
    const out = prepareTagInputText('a'.repeat(100), 10)
    expect(out).toBe('a'.repeat(10))
  })

  it('uses the default budget when given a non-positive budget', () => {
    const text = 'x'.repeat(DEFAULT_TAG_INPUT_BUDGET + 100)
    const out = prepareTagInputText(text, 0)
    expect(out.length).toBe(DEFAULT_TAG_INPUT_BUDGET)
  })
})

describe('buildTagSuggestionPrompt', () => {
  it('asks for at most MAX_SUGGESTED_TAGS as a JSON array', () => {
    const { system } = buildTagSuggestionPrompt({ title: 't', plaintext: 'body', existingTags: [] })
    expect(system).toContain(`at most ${MAX_SUGGESTED_TAGS}`)
    expect(system.toLowerCase()).toContain('json array')
  })

  it('includes the title and body in the user message', () => {
    const { user } = buildTagSuggestionPrompt({ title: 'My Title', plaintext: 'Some content', existingTags: [] })
    expect(user).toContain('Title: My Title')
    expect(user).toContain('Some content')
  })

  it('omits the title block when there is no title', () => {
    const { user } = buildTagSuggestionPrompt({ title: '   ', plaintext: 'body', existingTags: [] })
    expect(user).not.toContain('Title:')
  })

  it('lists existing tags so the model prefers reusing them', () => {
    const { user } = buildTagSuggestionPrompt({
      title: 't',
      plaintext: 'body',
      existingTags: ['work', '  budget  ', '', 'travel'],
    })
    expect(user).toContain('- work')
    expect(user).toContain('- budget')
    expect(user).toContain('- travel')
    expect(user).toContain('prefer reusing')
  })

  it('notes when the user has no existing tags', () => {
    const { user } = buildTagSuggestionPrompt({ title: 't', plaintext: 'body', existingTags: [] })
    expect(user).toContain('no existing tags')
  })

  it('truncates the note body to the budget', () => {
    const big = 'lorem '.repeat(5000)
    const { user } = buildTagSuggestionPrompt({ title: '', plaintext: big, existingTags: [] }, 50)
    // The user message has a fixed preamble; assert the body portion is short.
    const body = user.slice(user.indexOf('Note:\n---\n') + 'Note:\n---\n'.length)
    expect(body.length).toBeLessThanOrEqual(50)
  })
})

describe('sanitizeTag', () => {
  it('trims and strips a leading hashtag', () => {
    expect(sanitizeTag('  #work ')).toBe('work')
  })

  it('strips wrapping quotes and list markers', () => {
    expect(sanitizeTag('"budget"')).toBe('budget')
    expect(sanitizeTag('- travel')).toBe('travel')
    expect(sanitizeTag('1. finance')).toBe('finance')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeTag('home   office')).toBe('home office')
  })

  it('drops empties and over-long candidates', () => {
    expect(sanitizeTag('   ')).toBe('')
    expect(sanitizeTag('#')).toBe('')
    expect(sanitizeTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBe('')
  })

  it('returns empty for non-strings', () => {
    // @ts-expect-error intentionally wrong type
    expect(sanitizeTag(null)).toBe('')
  })
})

describe('parseSuggestedTags', () => {
  it('parses a clean JSON array', () => {
    expect(parseSuggestedTags('["work","budget","travel"]')).toEqual(['work', 'budget', 'travel'])
  })

  it('parses a JSON array wrapped in code fences', () => {
    const reply = '```json\n["work", "budget"]\n```'
    expect(parseSuggestedTags(reply)).toEqual(['work', 'budget'])
  })

  it('extracts a JSON array surrounded by prose', () => {
    const reply = 'Sure! Here are some tags: ["work", "finance"]. Hope that helps.'
    expect(parseSuggestedTags(reply)).toEqual(['work', 'finance'])
  })

  it('falls back to a comma-separated list when no JSON array is present', () => {
    expect(parseSuggestedTags('work, budget, travel')).toEqual(['work', 'budget', 'travel'])
  })

  it('falls back to a newline list and strips hashtags/bullets', () => {
    const reply = '#work\n- budget\n* travel'
    expect(parseSuggestedTags(reply)).toEqual(['work', 'budget', 'travel'])
  })

  it('caps at MAX_SUGGESTED_TAGS', () => {
    const result = parseSuggestedTags('["a","b","c","d","e","f"]')
    expect(result.length).toBe(MAX_SUGGESTED_TAGS)
    expect(result).toEqual(['a', 'b', 'c', 'd'])
  })

  it('dedupes case-insensitively, preserving first-seen casing', () => {
    expect(parseSuggestedTags('["Work","work","WORK","budget"]')).toEqual(['Work', 'budget'])
  })

  it('drops empty and junk entries', () => {
    expect(parseSuggestedTags('["", "  ", "#", "good"]')).toEqual(['good'])
  })

  it('returns an empty array for empty / whitespace input', () => {
    expect(parseSuggestedTags('')).toEqual([])
    expect(parseSuggestedTags('   \n  ')).toEqual([])
  })

  it('coerces non-string JSON array elements before sanitizing', () => {
    expect(parseSuggestedTags('["work", 5, null, "budget"]')).toEqual(['work', '5', 'budget'])
  })

  it('handles a malformed JSON-looking array by splitting on delimiters', () => {
    // Not valid JSON (single quotes) — falls through to comma/newline split.
    const result = parseSuggestedTags("['work', 'budget']")
    expect(result).toEqual(['work', 'budget'])
  })
})
