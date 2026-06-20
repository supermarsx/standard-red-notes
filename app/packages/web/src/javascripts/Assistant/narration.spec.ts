import {
  buildNarrationPrompt,
  DEFAULT_NARRATION_INPUT_BUDGET,
  DEFAULT_NARRATION_STYLE,
  getNarrationStyle,
  NARRATION_STYLES,
  prepareNarrationInput,
} from './narration'

describe('getNarrationStyle', () => {
  it('returns the matching style by id', () => {
    expect(getNarrationStyle('summary').id).toBe('summary')
    expect(getNarrationStyle('formal').label).toBe('Formal')
  })

  it('falls back to the first style for an unknown id', () => {
    // @ts-expect-error intentionally passing an invalid id
    expect(getNarrationStyle('nope')).toBe(NARRATION_STYLES[0])
  })

  it('exposes a sensible default style', () => {
    expect(NARRATION_STYLES.some((style) => style.id === DEFAULT_NARRATION_STYLE)).toBe(true)
  })
})

describe('buildNarrationPrompt', () => {
  it('embeds the chosen style instruction in the system prompt', () => {
    const faithful = buildNarrationPrompt('faithful', 'Hello.')
    expect(faithful.system).toContain('Faithful read')
    expect(faithful.system).toContain(getNarrationStyle('faithful').instruction)

    const summary = buildNarrationPrompt('summary', 'Hello.')
    expect(summary.system).toContain('Summary')
    expect(summary.system).not.toContain(getNarrationStyle('faithful').instruction)
  })

  it('always instructs the model to return read-aloud plain prose', () => {
    const { system } = buildNarrationPrompt('explainer', 'X')
    expect(system.toLowerCase()).toContain('read aloud')
    expect(system.toLowerCase()).toContain('only the narration text')
  })

  it('places the note text in the user message under a separator', () => {
    const { user } = buildNarrationPrompt('storytelling', 'My note body')
    expect(user).toContain('---')
    expect(user).toContain('My note body')
  })

  it('produces a different system prompt per style', () => {
    const systems = NARRATION_STYLES.map((style) => buildNarrationPrompt(style.id, 'same').system)
    expect(new Set(systems).size).toBe(NARRATION_STYLES.length)
  })
})

describe('prepareNarrationInput', () => {
  it('returns short text unchanged and untruncated', () => {
    const result = prepareNarrationInput('  Hello world  ')
    expect(result.text).toBe('Hello world')
    expect(result.truncated).toBe(false)
    expect(result.characters).toBe('Hello world'.length)
  })

  it('normalizes CRLF line endings', () => {
    const result = prepareNarrationInput('line1\r\nline2\rline3')
    expect(result.text).toBe('line1\nline2\nline3')
  })

  it('reports zero characters for empty input', () => {
    const result = prepareNarrationInput('')
    expect(result.text).toBe('')
    expect(result.characters).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('truncates text beyond the budget and appends a notice', () => {
    const long = 'word '.repeat(10_000) // ~50k chars
    const result = prepareNarrationInput(long, 1000)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('[Note truncated for narration')
    // Body (excluding the notice) must respect the budget.
    expect(result.characters).toBeLessThanOrEqual(1000)
  })

  it('cuts on a whitespace boundary, not mid-word', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(100)
    const result = prepareNarrationInput(long, 200)
    const body = result.text.replace(/\n\n\[Note truncated.*$/s, '')
    // The body should not end in a partial token (it ends on a complete word).
    expect(body.endsWith(' ')).toBe(false)
    expect(body.length).toBeLessThanOrEqual(200)
  })

  it('uses the default budget when none is given', () => {
    const long = 'a'.repeat(DEFAULT_NARRATION_INPUT_BUDGET + 5_000)
    const result = prepareNarrationInput(long)
    expect(result.truncated).toBe(true)
    expect(result.characters).toBeLessThanOrEqual(DEFAULT_NARRATION_INPUT_BUDGET)
  })

  it('falls back to a hard cut when there is no whitespace near the limit', () => {
    const noSpaces = 'x'.repeat(5000)
    const result = prepareNarrationInput(noSpaces, 1000)
    expect(result.truncated).toBe(true)
    expect(result.characters).toBe(1000)
  })
})
