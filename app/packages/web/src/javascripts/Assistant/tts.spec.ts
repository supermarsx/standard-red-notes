import { splitIntoSpeechChunks } from './tts'

describe('splitIntoSpeechChunks', () => {
  it('returns an empty array for blank input', () => {
    expect(splitIntoSpeechChunks('')).toEqual([])
    expect(splitIntoSpeechChunks('   \n\t ')).toEqual([])
  })

  it('keeps a short note as a single chunk', () => {
    expect(splitIntoSpeechChunks('Hello world.')).toEqual(['Hello world.'])
  })

  it('splits long text into multiple chunks all within the max length', () => {
    const sentence = 'This is a sentence that is reasonably sized. '
    const text = sentence.repeat(20) // ~900 chars
    const chunks = splitIntoSpeechChunks(text, 160)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 160)).toBe(true)
  })

  it('packs multiple sentences together up to the limit (not one chunk per sentence)', () => {
    const text = 'A. B. C. D. E. F. G. H.'
    const chunks = splitIntoSpeechChunks(text, 160)
    expect(chunks).toHaveLength(1)
  })

  it('hard-splits a single sentence longer than the limit on word boundaries', () => {
    const longWordRun = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') // no sentence punctuation
    const chunks = splitIntoSpeechChunks(longWordRun, 80)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 80)).toBe(true)
    // No content is lost (every original word appears somewhere).
    expect(chunks.join(' ')).toContain('word0')
    expect(chunks.join(' ')).toContain('word59')
  })

  it('collapses whitespace and trims each chunk', () => {
    const chunks = splitIntoSpeechChunks('  Lots   of\n\nwhitespace   here.  ')
    expect(chunks).toEqual(['Lots of whitespace here.'])
  })

  it('preserves all sentence content across chunks', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.'
    const joined = splitIntoSpeechChunks(text, 25).join(' ')
    expect(joined).toContain('First sentence')
    expect(joined).toContain('Second sentence')
    expect(joined).toContain('Third sentence')
  })
})
