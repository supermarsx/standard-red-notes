import { DEFAULT_TAB_TITLE, deriveTitleFromMessage } from './chatTabs'

describe('deriveTitleFromMessage', () => {
  it('returns the default title for empty or whitespace-only input', () => {
    expect(deriveTitleFromMessage('')).toBe(DEFAULT_TAB_TITLE)
    expect(deriveTitleFromMessage('   ')).toBe(DEFAULT_TAB_TITLE)
    expect(deriveTitleFromMessage('\n\n  \n')).toBe(DEFAULT_TAB_TITLE)
  })

  it('keeps a short message verbatim (capitalized, no ellipsis)', () => {
    expect(deriveTitleFromMessage('fix the login bug')).toBe('Fix the login bug')
  })

  it('truncates a long message to the first few words with an ellipsis', () => {
    const title = deriveTitleFromMessage('please summarize my notes about the quarterly budget review meeting')
    expect(title).toBe('Please summarize my notes about the…')
  })

  it('uses only the first non-empty line', () => {
    expect(deriveTitleFromMessage('\n\nWrite a poem\nabout the sea')).toBe('Write a poem')
  })

  it('strips surrounding punctuation that reads poorly as a label', () => {
    expect(deriveTitleFromMessage('"hello there"')).toBe('Hello there')
    expect(deriveTitleFromMessage('### Heading')).toBe('Heading')
  })

  it('falls back to the default when the message is only punctuation', () => {
    expect(deriveTitleFromMessage('!!! ???')).toBe(DEFAULT_TAB_TITLE)
  })

  it('caps very long single words by length with an ellipsis', () => {
    const title = deriveTitleFromMessage('a'.repeat(80))
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(41)
  })
})
