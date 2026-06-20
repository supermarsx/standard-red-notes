import { toEmbedUrl } from './toEmbedUrl'

describe('toEmbedUrl', () => {
  it('converts a youtube.com/watch?v=ID URL to the embed form', () => {
    expect(toEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    )
  })

  it('converts a youtu.be/ID short URL to the embed form', () => {
    expect(toEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
  })

  it('converts a youtube.com/shorts/ID URL to the embed form', () => {
    expect(toEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    )
  })

  it('passes through an already-embeddable youtube.com/embed/ID URL', () => {
    expect(toEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    )
  })

  it('preserves a numeric t= timestamp as ?start=SECONDS', () => {
    expect(toEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90',
    )
  })

  it('preserves a t=1m30s timestamp as total seconds', () => {
    expect(toEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=1m30s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90',
    )
  })

  it('preserves a t=90s timestamp on a youtu.be URL', () => {
    expect(toEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=90s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90',
    )
  })

  it('handles a watch URL where v= is not the first query param', () => {
    expect(toEmbedUrl('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    )
  })

  it('converts a vimeo.com/ID URL to the player form', () => {
    expect(toEmbedUrl('https://vimeo.com/123456789')).toBe('https://player.vimeo.com/video/123456789')
  })

  it('trims surrounding whitespace before matching', () => {
    expect(toEmbedUrl('  https://youtu.be/dQw4w9WgXcQ  ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
  })

  it('returns an empty string for empty input', () => {
    expect(toEmbedUrl('')).toBe('')
    expect(toEmbedUrl('   ')).toBe('')
  })

  it('leaves a generic non-video URL unchanged', () => {
    expect(toEmbedUrl('https://example.com/some/page')).toBe('https://example.com/some/page')
  })
})
