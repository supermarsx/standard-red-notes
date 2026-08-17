import {
  isFilePreviewable,
  isFileTypePreviewable,
  resolvePreviewKind,
  resolveTextPreviewLanguage,
} from './isFilePreviewable'

describe('file preview resolution', () => {
  it('recognizes OpenVPN profiles reported as an opaque binary MIME type', () => {
    const file = { name: 'work-profile.ovpn', mimeType: 'application/octet-stream' }

    expect(resolvePreviewKind(file)).toBe('text')
    expect(resolveTextPreviewLanguage(file)).toBe('openvpn')
    expect(isFilePreviewable(file)).toBe(true)
  })

  it('recognizes safe text MIME families and normalizes parameters', () => {
    expect(resolvePreviewKind({ name: 'api-response', mimeType: 'application/problem+json; charset=utf-8' })).toBe(
      'text',
    )
    expect(resolveTextPreviewLanguage({ name: 'api-response', mimeType: 'application/problem+json' })).toBe('json')
    expect(resolvePreviewKind({ name: 'settings', mimeType: 'application/vnd.example+xml' })).toBe('text')
    expect(resolvePreviewKind({ name: 'server.log', mimeType: 'text/plain; charset=UTF-8' })).toBe('text')
  })

  it('uses vetted extensions only when the MIME type is absent or opaque', () => {
    expect(resolvePreviewKind({ name: 'settings.yaml', mimeType: '' })).toBe('text')
    expect(resolvePreviewKind({ name: '.env', mimeType: 'application/x-unknown' })).toBe('text')
    expect(resolvePreviewKind({ name: 'not-really-text.txt', mimeType: 'application/zip' })).toBe('unsupported')
    expect(resolvePreviewKind({ name: 'payload.exe', mimeType: 'application/octet-stream' })).toBe('unsupported')
  })

  it('keeps media and PDF routing authoritative over filename hints', () => {
    expect(resolvePreviewKind({ name: 'misnamed.txt', mimeType: 'image/svg+xml' })).toBe('image')
    expect(resolvePreviewKind({ name: 'sound.txt', mimeType: 'audio/ogg' })).toBe('audio')
    expect(resolvePreviewKind({ name: 'movie.txt', mimeType: 'video/mp4' })).toBe('video')
    expect(resolvePreviewKind({ name: 'document.bin', mimeType: 'application/pdf' })).toBe('pdf')
  })

  it('keeps the MIME-only compatibility gate fail-closed without a filename', () => {
    expect(isFileTypePreviewable('text/plain')).toBe(true)
    expect(isFileTypePreviewable('application/octet-stream')).toBe(false)
    expect(resolvePreviewKind({ name: 'unknown', mimeType: 'application/octet-stream' })).toBe('unsupported')
  })
})
