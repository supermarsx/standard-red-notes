import { looksLikeSuperText, resolveSharedNoteFormat } from './SharedNoteFormat'

/**
 * The share viewer used to run every note through the markdown renderer, which
 * for a Super note means printing its serialized Lexical state as paragraph
 * text. Format resolution is what ends that, so these tests pin the two things
 * it has to get right: a Super note is recognised from its OWN BYTES (every
 * link created before the envelope carried a note type depends on that), and a
 * declared type never routes text into a renderer that cannot show it.
 */

const SUPER_TEXT = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'hello', type: 'text', version: 1 }],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

describe('looksLikeSuperText', () => {
  it('recognises a serialized Lexical editor state', () => {
    expect(looksLikeSuperText(SUPER_TEXT)).toBe(true)
  })

  it('recognises one that arrives with surrounding whitespace', () => {
    expect(looksLikeSuperText(`\n  ${SUPER_TEXT}\n`)).toBe(true)
  })

  it('rejects ordinary note text', () => {
    expect(looksLikeSuperText('# A heading\n\nSome prose.')).toBe(false)
  })

  it('rejects JSON that merely mentions root', () => {
    // An API response pasted into a markdown note. Routing this into the Super
    // renderer would show the reader an empty document instead of their text.
    expect(looksLikeSuperText('{"root": "/srv/app", "ok": true}')).toBe(false)
  })

  it('rejects a root whose children is not an array', () => {
    expect(looksLikeSuperText('{"root":{"children":{"0":{}}}}')).toBe(false)
  })

  it('rejects truncated JSON rather than throwing', () => {
    expect(looksLikeSuperText('{"root":{"children":[')).toBe(false)
  })

  it('rejects the empty note', () => {
    expect(looksLikeSuperText('')).toBe(false)
  })
})

describe('resolveSharedNoteFormat', () => {
  it('routes Super text to the Super renderer even when nothing declares it', () => {
    // The whole legacy-link case: no envelope before this work carried a note
    // type, and those links must still render.
    expect(resolveSharedNoteFormat(undefined, SUPER_TEXT)).toBe('super')
  })

  it('routes Super text to the Super renderer when the declared type is stale', () => {
    // A note converted to Super keeps its previous editor identifier until the
    // next save. Trusting the label here is how raw JSON reached a reader.
    expect(resolveSharedNoteFormat('markdown', SUPER_TEXT)).toBe('super')
  })

  it.each([
    ['markdown', 'markdown'],
    ['rich-text', 'html'],
    ['code', 'code'],
    ['plain-text', 'plain'],
  ])('maps the declared note type %s onto the %s renderer', (noteType, expected) => {
    expect(resolveSharedNoteFormat(noteType, 'plain words')).toBe(expected)
  })

  it('falls back to markdown for a declared super whose text is not Super', () => {
    expect(resolveSharedNoteFormat('super', '# just text')).toBe('markdown')
  })

  it.each([['task'], ['spreadsheet'], ['authentication'], ['unknown'], ['something-new']])(
    'falls back to markdown for the unmapped note type %s',
    (noteType) => {
      expect(resolveSharedNoteFormat(noteType, 'plain words')).toBe('markdown')
    },
  )

  it.each([[undefined], [null], [42], [{}]])('falls back to markdown for the non-string note type %p', (noteType) => {
    expect(resolveSharedNoteFormat(noteType, 'plain words')).toBe('markdown')
  })
})
