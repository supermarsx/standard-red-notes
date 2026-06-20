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
})

describe('isValidWebEmbedUrl', () => {
  it('mirrors sanitizeWebEmbedUrl as a boolean predicate', () => {
    expect(isValidWebEmbedUrl('https://example.com')).toBe(true)
    expect(isValidWebEmbedUrl('javascript:alert(1)')).toBe(false)
    expect(isValidWebEmbedUrl('')).toBe(false)
    expect(isValidWebEmbedUrl(null)).toBe(false)
  })
})
