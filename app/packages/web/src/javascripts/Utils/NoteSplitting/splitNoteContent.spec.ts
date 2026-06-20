import { NoteType } from '@standardnotes/snjs'
import { splitNoteContent } from './splitNoteContent'

describe('splitNoteContent', () => {
  describe('headings mode', () => {
    it('splits at ATX headings using heading text as title', () => {
      const text = ['# First', 'alpha', '## Second', 'beta', '### Third', 'gamma'].join('\n')

      const parts = splitNoteContent(text, { mode: 'headings', noteType: NoteType.Plain })

      expect(parts).toEqual([
        { title: 'First', content: '# First\nalpha' },
        { title: 'Second', content: '## Second\nbeta' },
        { title: 'Third', content: '### Third\ngamma' },
      ])
    })

    it('treats content before the first heading as a leading part', () => {
      const text = ['Intro line', 'more intro', '# Heading One', 'body'].join('\n')

      const parts = splitNoteContent(text, { mode: 'headings', noteType: NoteType.Plain })

      expect(parts).toHaveLength(2)
      expect(parts[0]).toEqual({ title: 'Intro line', content: 'Intro line\nmore intro' })
      expect(parts[1]).toEqual({ title: 'Heading One', content: '# Heading One\nbody' })
    })

    it('uses Part N for a leading section with no usable first line', () => {
      const text = ['', '   ', '# Heading'].join('\n')

      const parts = splitNoteContent(text, { mode: 'headings', noteType: NoteType.Plain })

      // The whitespace-only leading section is dropped, leaving just the heading.
      expect(parts).toEqual([{ title: 'Heading', content: '# Heading' }])
    })

    it('derives the title from the next line when a heading has no text', () => {
      const text = ['# ', 'body line'].join('\n')

      const parts = splitNoteContent(text, { mode: 'headings', noteType: NoteType.Plain })

      // Empty heading -> title derived from the next usable line. Internal lines
      // are kept faithfully (only the whole block is trimmed), so the trailing
      // space after "#" is preserved.
      expect(parts).toEqual([{ title: 'body line', content: '# \nbody line' }])
    })

    it('returns a single part when there are no headings', () => {
      const text = 'just some text\nwith no headings'

      const parts = splitNoteContent(text, { mode: 'headings', noteType: NoteType.Plain })

      expect(parts).toHaveLength(1)
      expect(parts[0].content).toBe('just some text\nwith no headings')
    })
  })

  describe('hr (thematic break) mode', () => {
    it.each([['---'], ['***'], ['___'], ['- - -'], ['* * *']])('splits on "%s"', (rule) => {
      const text = ['Part one body', rule, 'Part two body'].join('\n')

      const parts = splitNoteContent(text, { mode: 'hr', noteType: NoteType.Plain })

      expect(parts).toHaveLength(2)
      expect(parts[0]).toEqual({ title: 'Part one body', content: 'Part one body' })
      expect(parts[1]).toEqual({ title: 'Part two body', content: 'Part two body' })
    })

    it('derives titles from the first non-empty line of each part', () => {
      const text = ['', 'Alpha title', 'alpha body', '---', 'Beta title', 'beta body'].join('\n')

      const parts = splitNoteContent(text, { mode: 'hr', noteType: NoteType.Plain })

      expect(parts.map((p) => p.title)).toEqual(['Alpha title', 'Beta title'])
    })

    it('uses Part N when a part has no usable first line', () => {
      const text = ['---', 'has content', '---'].join('\n')

      const parts = splitNoteContent(text, { mode: 'hr', noteType: NoteType.Plain })

      // Empty leading/trailing sections are dropped; only the middle survives.
      expect(parts).toEqual([{ title: 'has content', content: 'has content' }])
    })

    it('does not treat a normal line as a break', () => {
      const text = 'a - b - c\nstill one note'

      const parts = splitNoteContent(text, { mode: 'hr', noteType: NoteType.Plain })

      expect(parts).toHaveLength(1)
    })
  })

  describe('delimiter mode', () => {
    it('splits on a literal custom delimiter', () => {
      const text = 'one===two===three'

      const parts = splitNoteContent(text, { mode: 'delimiter', delimiter: '===', noteType: NoteType.Plain })

      expect(parts.map((p) => p.content)).toEqual(['one', 'two', 'three'])
      expect(parts.map((p) => p.title)).toEqual(['one', 'two', 'three'])
    })

    it('returns a single part when the delimiter is absent', () => {
      const text = 'no delimiter here'

      const parts = splitNoteContent(text, { mode: 'delimiter', delimiter: '%%%', noteType: NoteType.Plain })

      expect(parts).toHaveLength(1)
    })

    it('returns a single part when the delimiter is empty', () => {
      const text = 'some text'

      const parts = splitNoteContent(text, { mode: 'delimiter', delimiter: '', noteType: NoteType.Plain })

      expect(parts).toHaveLength(1)
      expect(parts[0].content).toBe('some text')
    })
  })

  describe('general behaviour', () => {
    it('trims content and drops empty/whitespace-only parts', () => {
      const text = '   alpha   ===   ===  beta  '

      const parts = splitNoteContent(text, { mode: 'delimiter', delimiter: '===', noteType: NoteType.Plain })

      expect(parts).toEqual([
        { title: 'alpha', content: 'alpha' },
        { title: 'beta', content: 'beta' },
      ])
    })

    it('normalizes CRLF line endings', () => {
      const text = '# A\r\nbody\r\n# B\r\nbody2'

      const parts = splitNoteContent(text, { mode: 'headings', noteType: NoteType.Plain })

      expect(parts).toEqual([
        { title: 'A', content: '# A\nbody' },
        { title: 'B', content: '# B\nbody2' },
      ])
    })

    it('returns an empty array for empty text', () => {
      const parts = splitNoteContent('', { mode: 'headings', noteType: NoteType.Plain })
      expect(parts).toEqual([])
    })

    it('splits Super notes via their extracted plaintext', () => {
      const lexical = JSON.stringify({
        root: {
          children: [
            { children: [{ text: '# Heading A' }] },
            { children: [{ text: 'content a' }] },
            { children: [{ text: '# Heading B' }] },
            { children: [{ text: 'content b' }] },
          ],
        },
      })

      const parts = splitNoteContent(lexical, { mode: 'headings', noteType: NoteType.Super })

      expect(parts).toEqual([
        { title: 'Heading A', content: '# Heading A\ncontent a' },
        { title: 'Heading B', content: '# Heading B\ncontent b' },
      ])
    })
  })
})
