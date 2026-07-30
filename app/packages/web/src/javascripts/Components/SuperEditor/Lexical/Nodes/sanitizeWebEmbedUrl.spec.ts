import { isValidWebEmbedUrl, sanitizeWebEmbedUrl } from './sanitizeWebEmbedUrl'

describe('sanitizeWebEmbedUrl', () => {
  it('returns a normalized absolute URL for a valid https URL', () => {
    expect(sanitizeWebEmbedUrl('https://example.com')).toBe('https://example.com/')
    expect(sanitizeWebEmbedUrl('https://example.com/path?q=1#frag')).toBe('https://example.com/path?q=1#frag')
  })

  it('accepts http URLs', () => {
    expect(sanitizeWebEmbedUrl('http://example.com')).toBe('http://example.com/')
  })

  it('trims surrounding whitespace before validating', () => {
    expect(sanitizeWebEmbedUrl('  https://example.com  ')).toBe('https://example.com/')
  })

  it('matches the scheme case-insensitively', () => {
    expect(sanitizeWebEmbedUrl('HTTPS://example.com')).toBe('https://example.com/')
  })

  it('returns empty string for empty / null / undefined input', () => {
    expect(sanitizeWebEmbedUrl('')).toBe('')
    expect(sanitizeWebEmbedUrl('   ')).toBe('')
    expect(sanitizeWebEmbedUrl(null)).toBe('')
    expect(sanitizeWebEmbedUrl(undefined)).toBe('')
  })

  it('rejects scheme-less input rather than auto-prepending https', () => {
    expect(sanitizeWebEmbedUrl('example.com')).toBe('')
    expect(sanitizeWebEmbedUrl('www.example.com/path')).toBe('')
  })

  it('rejects dangerous schemes', () => {
    expect(sanitizeWebEmbedUrl('javascript:alert(1)')).toBe('')
    expect(sanitizeWebEmbedUrl('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(sanitizeWebEmbedUrl('blob:https://example.com/abc')).toBe('')
    expect(sanitizeWebEmbedUrl('file:///etc/passwd')).toBe('')
    expect(sanitizeWebEmbedUrl('vbscript:msgbox(1)')).toBe('')
  })

  it('rejects an http scheme with no parseable URL after it', () => {
    expect(sanitizeWebEmbedUrl('https://')).toBe('')
  })

  it('rejects URLs on the current app origin, including normalized default ports', () => {
    expect(sanitizeWebEmbedUrl(`${window.location.origin}/account`)).toBe('')
    expect(sanitizeWebEmbedUrl('https://notes.example/account', 'https://notes.example')).toBe('')
    expect(sanitizeWebEmbedUrl('https://notes.example:443/account', 'https://notes.example/editor')).toBe('')
  })

  it('still accepts different scheme and port origins', () => {
    expect(sanitizeWebEmbedUrl('http://notes.example/page', 'https://notes.example')).toBe('http://notes.example/page')
    expect(sanitizeWebEmbedUrl('https://notes.example:8443/page', 'https://notes.example')).toBe(
      'https://notes.example:8443/page',
    )
  })

  it('re-evaluates a persisted embed against the runtime origin after navigation or reload', () => {
    const persistedUrl = 'https://notes-a.example/embed'

    expect(sanitizeWebEmbedUrl(persistedUrl, 'https://notes-b.example')).toBe(persistedUrl)
    expect(sanitizeWebEmbedUrl(persistedUrl, 'https://notes-a.example/after-navigation')).toBe('')
  })
})

describe('isValidWebEmbedUrl', () => {
  it('mirrors sanitizeWebEmbedUrl as a boolean predicate', () => {
    expect(isValidWebEmbedUrl('https://example.com')).toBe(true)
    expect(isValidWebEmbedUrl('javascript:alert(1)')).toBe(false)
    expect(isValidWebEmbedUrl('')).toBe(false)
    expect(isValidWebEmbedUrl(null)).toBe(false)
    expect(isValidWebEmbedUrl('https://notes.example/embed', 'https://notes.example')).toBe(false)
  })
})
