import {
  HERO_DEFAULT_HEIGHT,
  HERO_MAX_HEIGHT,
  HERO_MIN_HEIGHT,
  MAX_HERO_DATA_URL_LENGTH,
  MAX_HERO_SOURCE_BYTES,
  clampHeroFocalY,
  clampHeroHeight,
  isAcceptedHeroImageType,
  normalizeHeroHeader,
  normalizeHeroImageDataUrl,
  validateHeroSourceFile,
} from './heroHeader'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
  JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

describe('isAcceptedHeroImageType', () => {
  it('accepts supported image MIME types', () => {
    expect(isAcceptedHeroImageType('image/png')).toBe(true)
    expect(isAcceptedHeroImageType('image/jpeg')).toBe(true)
    expect(isAcceptedHeroImageType('image/webp')).toBe(true)
    expect(isAcceptedHeroImageType('image/gif')).toBe(true)
  })

  it('rejects unsupported / missing types', () => {
    expect(isAcceptedHeroImageType('application/pdf')).toBe(false)
    expect(isAcceptedHeroImageType('text/plain')).toBe(false)
    expect(isAcceptedHeroImageType('')).toBe(false)
    expect(isAcceptedHeroImageType(undefined)).toBe(false)
    expect(isAcceptedHeroImageType(null)).toBe(false)
  })
})

describe('validateHeroSourceFile', () => {
  it('accepts a reasonable image file', () => {
    expect(validateHeroSourceFile({ type: 'image/jpeg', size: 1024 })).toBeNull()
  })

  it('rejects when no file is selected', () => {
    expect(validateHeroSourceFile(null)).toMatch(/no file/i)
    expect(validateHeroSourceFile(undefined)).toMatch(/no file/i)
  })

  it('rejects non-image types', () => {
    expect(validateHeroSourceFile({ type: 'application/pdf', size: 1024 })).toMatch(/png|jpeg|image/i)
  })

  it('rejects files over the source size bound', () => {
    expect(validateHeroSourceFile({ type: 'image/png', size: MAX_HERO_SOURCE_BYTES + 1 })).toMatch(/too large/i)
  })

  it('accepts files exactly at the size bound', () => {
    expect(validateHeroSourceFile({ type: 'image/jpeg', size: MAX_HERO_SOURCE_BYTES })).toBeNull()
  })
})

describe('normalizeHeroImageDataUrl', () => {
  it('returns valid image data URLs unchanged (trimmed)', () => {
    expect(normalizeHeroImageDataUrl(PNG_DATA_URL)).toBe(PNG_DATA_URL)
    expect(normalizeHeroImageDataUrl(JPEG_DATA_URL)).toBe(JPEG_DATA_URL)
    expect(normalizeHeroImageDataUrl(`  ${PNG_DATA_URL}  `)).toBe(PNG_DATA_URL)
  })

  it('rejects non-strings', () => {
    expect(normalizeHeroImageDataUrl(undefined)).toBeNull()
    expect(normalizeHeroImageDataUrl(null)).toBeNull()
    expect(normalizeHeroImageDataUrl(42)).toBeNull()
    expect(normalizeHeroImageDataUrl({})).toBeNull()
  })

  it('rejects empty and non-image-data-url strings', () => {
    expect(normalizeHeroImageDataUrl('')).toBeNull()
    expect(normalizeHeroImageDataUrl('   ')).toBeNull()
    expect(normalizeHeroImageDataUrl('https://example.com/a.png')).toBeNull()
    expect(normalizeHeroImageDataUrl('data:text/plain;base64,AAAA')).toBeNull()
    expect(normalizeHeroImageDataUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects values past the stored-length bound (appData bloat guard)', () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_HERO_DATA_URL_LENGTH)
    expect(normalizeHeroImageDataUrl(huge)).toBeNull()
  })
})

describe('clampHeroHeight', () => {
  it('clamps below/above the allowed range', () => {
    expect(clampHeroHeight(HERO_MIN_HEIGHT - 50)).toBe(HERO_MIN_HEIGHT)
    expect(clampHeroHeight(HERO_MAX_HEIGHT + 50)).toBe(HERO_MAX_HEIGHT)
  })

  it('rounds and passes through in-range values', () => {
    expect(clampHeroHeight(220.4)).toBe(220)
  })

  it('defaults non-finite input to the default height', () => {
    expect(clampHeroHeight(undefined)).toBe(HERO_DEFAULT_HEIGHT)
    expect(clampHeroHeight('nope')).toBe(HERO_DEFAULT_HEIGHT)
    expect(clampHeroHeight(NaN)).toBe(HERO_DEFAULT_HEIGHT)
  })
})

describe('clampHeroFocalY', () => {
  it('clamps into [0, 1]', () => {
    expect(clampHeroFocalY(-1)).toBe(0)
    expect(clampHeroFocalY(2)).toBe(1)
    expect(clampHeroFocalY(0.3)).toBe(0.3)
  })

  it('defaults non-finite input to center (0.5)', () => {
    expect(clampHeroFocalY(undefined)).toBe(0.5)
    expect(clampHeroFocalY('nope')).toBe(0.5)
  })
})

describe('normalizeHeroHeader (backward-compat / never throws)', () => {
  it('returns null for missing / non-object / legacy values', () => {
    expect(normalizeHeroHeader(undefined)).toBeNull()
    expect(normalizeHeroHeader(null)).toBeNull()
    expect(normalizeHeroHeader('cover')).toBeNull()
    expect(normalizeHeroHeader(42)).toBeNull()
    expect(normalizeHeroHeader([])).toBeNull()
  })

  it('returns null when there is no valid image (even with other fields)', () => {
    expect(normalizeHeroHeader({ height: 200, focalY: 0.5 })).toBeNull()
    expect(normalizeHeroHeader({ imageDataUrl: 'not-a-data-url', height: 200 })).toBeNull()
  })

  it('normalizes a valid cover, clamping height and focal point', () => {
    const result = normalizeHeroHeader({ imageDataUrl: JPEG_DATA_URL, height: 5000, focalY: 9 })
    expect(result).toEqual({ imageDataUrl: JPEG_DATA_URL, height: HERO_MAX_HEIGHT, focalY: 1 })
  })

  it('fills sensible defaults for a cover with only an image', () => {
    const result = normalizeHeroHeader({ imageDataUrl: PNG_DATA_URL })
    expect(result).toEqual({ imageDataUrl: PNG_DATA_URL, height: HERO_DEFAULT_HEIGHT, focalY: 0.5 })
  })

  it('drops an oversized image (appData bloat guard) -> null', () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(MAX_HERO_DATA_URL_LENGTH)
    expect(normalizeHeroHeader({ imageDataUrl: huge, height: 200 })).toBeNull()
  })
})

describe('constants', () => {
  it('keeps the stored cover bounded for synced E2E appData', () => {
    expect(MAX_HERO_DATA_URL_LENGTH).toBeGreaterThan(0)
    expect(MAX_HERO_DATA_URL_LENGTH).toBeLessThanOrEqual(1024 * 1024)
    expect(HERO_MIN_HEIGHT).toBeLessThan(HERO_MAX_HEIGHT)
  })
})
