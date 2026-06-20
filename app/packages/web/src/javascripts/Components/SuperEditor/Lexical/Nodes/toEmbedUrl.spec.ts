import { toEmbedUrl, toTrustedEmbedUrl } from './toEmbedUrl'

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

  it('converts a youtube-nocookie.com/embed/ID URL to the canonical embed form', () => {
    expect(toEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    )
  })

  it('normalizes an already-embeddable player.vimeo.com/video/ID URL', () => {
    expect(toEmbedUrl('https://player.vimeo.com/video/123456789')).toBe(
      'https://player.vimeo.com/video/123456789',
    )
  })

  it('returns null for empty input', () => {
    expect(toEmbedUrl('')).toBeNull()
    expect(toEmbedUrl('   ')).toBeNull()
  })

  it('returns null for an arbitrary / unknown http(s) URL instead of passing it through', () => {
    expect(toEmbedUrl('https://example.com/some/page')).toBeNull()
    expect(toEmbedUrl('http://attacker.example/evil')).toBeNull()
  })

  it('returns null for a host that merely contains a trusted substring', () => {
    expect(toEmbedUrl('https://youtube.com.attacker.example/embed/dQw4w9WgXcQ')).toBeNull()
    expect(toEmbedUrl('https://evil.com/?x=vimeo.com/123456789')).toBeNull()
  })

  it('returns null for dangerous schemes', () => {
    expect(toEmbedUrl('javascript:alert(1)')).toBeNull()
    expect(toEmbedUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })
})

describe('toTrustedEmbedUrl', () => {
  it('returns the canonical embed URL for recognized providers', () => {
    expect(toTrustedEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    )
    expect(toTrustedEmbedUrl('https://vimeo.com/123456789')).toBe('https://player.vimeo.com/video/123456789')
  })

  it('returns null for arbitrary origins and dangerous schemes', () => {
    expect(toTrustedEmbedUrl('https://example.com/some/page')).toBeNull()
    expect(toTrustedEmbedUrl('javascript:alert(1)')).toBeNull()
  })
})
