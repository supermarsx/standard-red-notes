import { NoteType } from '@standardnotes/snjs'
import {
  computePlaintextStats,
  extractPlaintextFromNoteText,
  NOTE_STATS_MAX_SCAN_LENGTH,
} from './NoteStats'

describe('computePlaintextStats', () => {
  it('returns all zeros for an empty string', () => {
    expect(computePlaintextStats('')).toEqual({
      characters: 0,
      charactersNoSpaces: 0,
      words: 0,
      lines: 0,
      paragraphs: 0,
    })
  })

  it('counts characters with and without spaces', () => {
    const stats = computePlaintextStats('ab cd')
    expect(stats.characters).toBe(5)
    expect(stats.charactersNoSpaces).toBe(4)
  })

  it('counts words ignoring extra whitespace', () => {
    expect(computePlaintextStats('  hello   world  ').words).toBe(2)
    expect(computePlaintextStats('one\ntwo\tthree').words).toBe(3)
  })

  it('counts lines as newline count + 1 and normalizes CRLF', () => {
    expect(computePlaintextStats('single line').lines).toBe(1)
    expect(computePlaintextStats('a\nb\nc').lines).toBe(3)
    expect(computePlaintextStats('a\r\nb').lines).toBe(2)
  })

  it('counts paragraphs separated by blank lines', () => {
    expect(computePlaintextStats('only one paragraph\nwith two lines').paragraphs).toBe(1)
    expect(computePlaintextStats('para one\n\npara two\n\n\npara three').paragraphs).toBe(3)
  })

  it('treats whitespace-only text as zero words/paragraphs but counts lines', () => {
    const stats = computePlaintextStats('   \n   ')
    expect(stats.words).toBe(0)
    expect(stats.paragraphs).toBe(0)
    expect(stats.lines).toBe(2)
  })

  it('caps the scanned text length for very large notes', () => {
    const huge = 'a'.repeat(NOTE_STATS_MAX_SCAN_LENGTH + 500)
    expect(computePlaintextStats(huge).characters).toBe(NOTE_STATS_MAX_SCAN_LENGTH)
  })
})

describe('extractPlaintextFromNoteText', () => {
  it('returns the text as-is for plain notes', () => {
    expect(extractPlaintextFromNoteText('hello world', NoteType.Plain)).toBe('hello world')
  })

  it('extracts text nodes from Super (Lexical) JSON', () => {
    const lexical = JSON.stringify({
      root: {
        children: [
          { children: [{ text: 'Hello' }, { text: ' world' }], type: 'paragraph' },
          { children: [{ text: 'Second' }], type: 'paragraph' },
        ],
        type: 'root',
      },
    })
    expect(extractPlaintextFromNoteText(lexical, NoteType.Super)).toBe('Hello\n world\nSecond')
  })

  it('falls back to the raw string when Super JSON is invalid', () => {
    expect(extractPlaintextFromNoteText('not json', NoteType.Super)).toBe('not json')
  })

  it('returns empty string for empty Super note text', () => {
    expect(extractPlaintextFromNoteText('', NoteType.Super)).toBe('')
  })
})
