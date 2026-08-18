import {
  hasCompatibleInlineImageSource,
  hasSupportedImageSignature,
  isFilePreviewable,
  isFileTypePreviewable,
  resolvePreviewKind,
  resolveTextPreviewLanguage,
} from './isFilePreviewable'

const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const supportedImageSignatures = [
  ['image/apng', 'animation.apng', pngSignature],
  ['image/avif', 'photo.avif', new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
  ['image/bmp', 'photo.bmp', new Uint8Array([0x42, 0x4d])],
  ['image/gif', 'photo.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
  ['image/jpeg', 'photo.jpg', new Uint8Array([0xff, 0xd8, 0xff])],
  ['image/png', 'photo.png', pngSignature],
  ['image/vnd.microsoft.icon', 'photo.ico', new Uint8Array([0, 0, 1, 0])],
  [
    'image/webp',
    'photo.webp',
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x30, 0x30, 0x30, 0x30, 0x57, 0x45, 0x42, 0x50]),
  ],
  ['image/x-icon', 'photo.cur', new Uint8Array([0, 0, 2, 0])],
] as const

const dataUrl = (mimeType: string, bytes: Uint8Array) =>
  `data:${mimeType};base64,${btoa(String.fromCharCode(...bytes))}`

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

  it('safely probes opaque payloads as text while rejecting mismatched known binary MIME types', () => {
    expect(resolvePreviewKind({ name: 'settings.yaml', mimeType: '' })).toBe('text')
    expect(resolvePreviewKind({ name: '.env', mimeType: 'application/x-unknown' })).toBe('text')
    expect(resolvePreviewKind({ name: 'not-really-text.txt', mimeType: 'application/zip' })).toBe('unsupported')
    expect(resolvePreviewKind({ name: 'extensionless', mimeType: 'application/octet-stream' })).toBe('text')
    expect(resolveTextPreviewLanguage({ name: 'payload.exe', mimeType: 'application/octet-stream' })).toBe('plain')
  })

  it('keeps inert media and PDF routing authoritative while treating SVG as escaped markup', () => {
    expect(resolvePreviewKind({ name: 'misnamed.txt', mimeType: 'image/svg+xml' })).toBe('text')
    expect(resolveTextPreviewLanguage({ name: 'drawing.svg', mimeType: 'image/svg+xml' })).toBe('markup')
    expect(resolvePreviewKind({ name: 'sound.txt', mimeType: 'audio/ogg' })).toBe('audio')
    expect(resolvePreviewKind({ name: 'movie.txt', mimeType: 'video/mp4' })).toBe('video')
    expect(resolvePreviewKind({ name: 'document.bin', mimeType: 'application/pdf' })).toBe('pdf')
  })

  it('allows only supported, filename-compatible image MIME types into image-body rendering', () => {
    expect(resolvePreviewKind({ name: 'photo.png', mimeType: 'image/png' })).toBe('image')
    expect(resolvePreviewKind({ name: 'photo', mimeType: 'image/png' })).toBe('image')
    expect(resolvePreviewKind({ name: 'document.pdf', mimeType: 'image/png' })).toBe('unsupported')
    expect(resolvePreviewKind({ name: 'photo.heic', mimeType: 'image/heic' })).toBe('unsupported')
  })

  it('uses data URLs only to reject contradictory image claims', () => {
    const image = { name: 'photo.png', mimeType: 'image/png' }
    expect(hasCompatibleInlineImageSource(image, 'blob:opaque-source')).toBe(true)
    expect(hasCompatibleInlineImageSource(image, 'data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(hasCompatibleInlineImageSource(image, 'data:application/pdf;base64,JVBERg==')).toBe(false)
    expect(hasCompatibleInlineImageSource(image, 'data:image/png;base64,JVBERg==')).toBe(false)
  })

  it.each(supportedImageSignatures)(
    'requires a genuine %s signature for both downloaded bytes and data URLs',
    (mimeType, name, signature) => {
      const image = { name, mimeType }
      const contradictoryBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

      expect(resolvePreviewKind(image)).toBe('image')
      expect(hasSupportedImageSignature(image, signature)).toBe(true)
      expect(hasCompatibleInlineImageSource(image, dataUrl(mimeType, signature))).toBe(true)
      expect(hasSupportedImageSignature(image, contradictoryBytes)).toBe(false)
      expect(hasCompatibleInlineImageSource(image, dataUrl(mimeType, contradictoryBytes))).toBe(false)
    },
  )

  it('never treats non-image metadata as an image even when its bytes have an image signature', () => {
    expect(hasSupportedImageSignature({ name: 'notes.txt', mimeType: 'text/plain' }, pngSignature)).toBe(false)
  })

  it('allows the MIME-only gate to request a bounded text probe for opaque content', () => {
    expect(isFileTypePreviewable('text/plain')).toBe(true)
    expect(isFileTypePreviewable('application/octet-stream')).toBe(true)
    expect(resolvePreviewKind({ name: 'unknown', mimeType: 'application/octet-stream' })).toBe('text')
  })
})
