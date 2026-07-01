import { sanitizeUrl } from './sanitizeUrl'

describe('sanitizeUrl', () => {
  it('allows http and https URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com')
    expect(sanitizeUrl('https://example.com/path?q=1#frag')).toBe('https://example.com/path?q=1#frag')
  })

  it('allows mailto URLs', () => {
    expect(sanitizeUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('allows safe relative and anchor URLs', () => {
    expect(sanitizeUrl('/relative/path')).toBe('/relative/path')
    expect(sanitizeUrl('#anchor')).toBe('#anchor')
    expect(sanitizeUrl('./foo')).toBe('./foo')
  })

  it('rejects the file: scheme and returns a safe fallback', () => {
    expect(sanitizeUrl('file:///etc/passwd')).toBe('https://')
    expect(sanitizeUrl('FILE:///etc/passwd')).toBe('https://')
    expect(sanitizeUrl('  file:///C:/Windows/System32  ')).toBe('https://')
  })

  it('rejects other risky schemes', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('https://')
    expect(sanitizeUrl('ftp://example.com/file')).toBe('https://')
    expect(sanitizeUrl('tel:+1234567890')).toBe('https://')
    expect(sanitizeUrl('sms:+1234567890')).toBe('https://')
  })
})
