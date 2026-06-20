import {
  AVATAR_SIZE,
  MAX_SOURCE_BYTES,
  MAX_STORED_DATA_URL_LENGTH,
  initialsForUser,
  isAcceptedImageType,
  normalizeStoredAvatar,
  validateSourceFile,
} from './avatarCore'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
  JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

describe('isAcceptedImageType', () => {
  it('accepts supported image MIME types', () => {
    expect(isAcceptedImageType('image/png')).toBe(true)
    expect(isAcceptedImageType('image/jpeg')).toBe(true)
    expect(isAcceptedImageType('image/webp')).toBe(true)
    expect(isAcceptedImageType('image/gif')).toBe(true)
  })

  it('rejects unsupported / missing types', () => {
    expect(isAcceptedImageType('application/pdf')).toBe(false)
    expect(isAcceptedImageType('text/plain')).toBe(false)
    expect(isAcceptedImageType('')).toBe(false)
    expect(isAcceptedImageType(undefined)).toBe(false)
    expect(isAcceptedImageType(null)).toBe(false)
  })
})

describe('validateSourceFile', () => {
  it('accepts a reasonable image file', () => {
    expect(validateSourceFile({ type: 'image/png', size: 1024 })).toBeNull()
  })

  it('rejects when no file is selected', () => {
    expect(validateSourceFile(null)).toMatch(/no file/i)
    expect(validateSourceFile(undefined)).toMatch(/no file/i)
  })

  it('rejects non-image types', () => {
    expect(validateSourceFile({ type: 'application/pdf', size: 1024 })).toMatch(/png|jpeg|image/i)
  })

  it('rejects files over the source size bound', () => {
    expect(validateSourceFile({ type: 'image/png', size: MAX_SOURCE_BYTES + 1 })).toMatch(/too large/i)
  })

  it('accepts files exactly at the size bound', () => {
    expect(validateSourceFile({ type: 'image/jpeg', size: MAX_SOURCE_BYTES })).toBeNull()
  })
})

describe('normalizeStoredAvatar', () => {
  it('returns valid image data URLs unchanged (trimmed)', () => {
    expect(normalizeStoredAvatar(PNG_DATA_URL)).toBe(PNG_DATA_URL)
    expect(normalizeStoredAvatar(JPEG_DATA_URL)).toBe(JPEG_DATA_URL)
    expect(normalizeStoredAvatar(`  ${PNG_DATA_URL}  `)).toBe(PNG_DATA_URL)
  })

  it('rejects non-strings', () => {
    expect(normalizeStoredAvatar(undefined)).toBeNull()
    expect(normalizeStoredAvatar(null)).toBeNull()
    expect(normalizeStoredAvatar(42)).toBeNull()
    expect(normalizeStoredAvatar({})).toBeNull()
  })

  it('rejects empty and non-image-data-url strings', () => {
    expect(normalizeStoredAvatar('')).toBeNull()
    expect(normalizeStoredAvatar('   ')).toBeNull()
    expect(normalizeStoredAvatar('https://example.com/a.png')).toBeNull()
    expect(normalizeStoredAvatar('data:text/plain;base64,AAAA')).toBeNull()
    expect(normalizeStoredAvatar('javascript:alert(1)')).toBeNull()
  })

  it('rejects values past the stored-length bound', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_STORED_DATA_URL_LENGTH)
    expect(normalizeStoredAvatar(huge)).toBeNull()
  })
})

describe('initialsForUser', () => {
  it('derives two initials from a dotted email local part', () => {
    expect(initialsForUser('ada.lovelace@example.com')).toBe('AL')
  })

  it('handles underscore / hyphen / plus separators', () => {
    expect(initialsForUser('ada_lovelace@example.com')).toBe('AL')
    expect(initialsForUser('ada-lovelace@example.com')).toBe('AL')
    expect(initialsForUser('ada+tag@example.com')).toBe('AT')
  })

  it('uses one initial when there is a single token', () => {
    expect(initialsForUser('ada@example.com')).toBe('A')
  })

  it('handles a plain display name', () => {
    expect(initialsForUser('Ada Lovelace')).toBe('AL')
  })

  it('falls back to ? for empty / non-string input', () => {
    expect(initialsForUser('')).toBe('?')
    expect(initialsForUser('   ')).toBe('?')
    expect(initialsForUser(undefined)).toBe('?')
    expect(initialsForUser(null)).toBe('?')
  })

  it('always upper-cases the result', () => {
    expect(initialsForUser('zoe.quinn@example.com')).toBe('ZQ')
  })
})

describe('constants', () => {
  it('keeps the avatar small (square, bounded)', () => {
    expect(AVATAR_SIZE).toBeLessThanOrEqual(256)
    expect(MAX_STORED_DATA_URL_LENGTH).toBeGreaterThan(0)
  })
})
