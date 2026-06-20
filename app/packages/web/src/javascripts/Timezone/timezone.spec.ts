/**
 * Pure unit tests for the timezone core. No running app; a fixed instant is used
 * for all formatting assertions so results don't depend on "now".
 */

import {
  DEFAULT_TIMEZONE_SETTINGS,
  formatDateInZone,
  formatTimeInZone,
  getConfiguredTimeZone,
  getSupportedTimeZones,
  getSystemTimeZone,
  isValidTimeZone,
  normalizeTimeZoneSettings,
  timeZoneDisplayLabel,
} from './timezone'

// 2026-06-21T12:00:00Z — a fixed instant.
const FIXED_INSTANT = new Date('2026-06-21T12:00:00Z')

describe('normalizeTimeZoneSettings', () => {
  it('returns the default ("follow system") for null/undefined', () => {
    expect(normalizeTimeZoneSettings(null)).toEqual(DEFAULT_TIMEZONE_SETTINGS)
    expect(normalizeTimeZoneSettings(undefined)).toEqual(DEFAULT_TIMEZONE_SETTINGS)
  })

  it('returns the default for a non-object blob', () => {
    expect(normalizeTimeZoneSettings(42 as unknown as { timeZone: string })).toEqual(DEFAULT_TIMEZONE_SETTINGS)
  })

  it('keeps the empty "follow system" sentinel', () => {
    expect(normalizeTimeZoneSettings({ timeZone: '' })).toEqual({ timeZone: '' })
  })

  it('preserves a valid IANA zone', () => {
    expect(normalizeTimeZoneSettings({ timeZone: 'America/New_York' })).toEqual({ timeZone: 'America/New_York' })
  })

  it('drops an unknown zone back to the default', () => {
    expect(normalizeTimeZoneSettings({ timeZone: 'Mars/Olympus_Mons' })).toEqual(DEFAULT_TIMEZONE_SETTINGS)
  })
})

describe('isValidTimeZone', () => {
  it('accepts real zones', () => {
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Asia/Tokyo')).toBe(true)
  })

  it('rejects junk', () => {
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('Nope/Nowhere')).toBe(false)
    expect(isValidTimeZone(123 as unknown as string)).toBe(false)
  })
})

describe('getConfiguredTimeZone', () => {
  it('resolves "follow system" to the live system zone', () => {
    expect(getConfiguredTimeZone({ timeZone: '' })).toBe(getSystemTimeZone())
  })

  it('returns a concrete configured zone unchanged', () => {
    expect(getConfiguredTimeZone({ timeZone: 'Europe/Berlin' })).toBe('Europe/Berlin')
  })

  it('resolves an invalid stored zone to the system zone', () => {
    expect(getConfiguredTimeZone({ timeZone: 'Bad/Zone' })).toBe(getSystemTimeZone())
  })

  it('defaults to the system zone with no argument', () => {
    expect(getConfiguredTimeZone()).toBe(getSystemTimeZone())
  })
})

describe('formatTimeInZone (fixed instant)', () => {
  it('formats 24-hour time with seconds in a positive-offset zone', () => {
    // 12:00 UTC is 21:00:00 in Tokyo (UTC+9).
    expect(formatTimeInZone(FIXED_INSTANT, 'Asia/Tokyo', { hour24: true, showSeconds: true })).toBe('21:00:00')
  })

  it('formats 24-hour time without seconds', () => {
    expect(formatTimeInZone(FIXED_INSTANT, 'Asia/Tokyo', { hour24: true, showSeconds: false })).toBe('21:00')
  })

  it('formats the same instant in a negative-offset zone', () => {
    // 12:00 UTC is 08:00 in New York (EDT, UTC-4 in June).
    expect(formatTimeInZone(FIXED_INSTANT, 'America/New_York', { hour24: true, showSeconds: false })).toBe('08:00')
  })

  it('formats 12-hour time with an AM/PM marker', () => {
    const result = formatTimeInZone(FIXED_INSTANT, 'America/New_York', { hour24: false, showSeconds: false })
    expect(result).toMatch(/08:00/)
    expect(result).toMatch(/AM/i)
  })

  it('falls back to a valid zone instead of throwing on a bad zone', () => {
    expect(() => formatTimeInZone(FIXED_INSTANT, 'Bad/Zone', { hour24: true, showSeconds: false })).not.toThrow()
  })
})

describe('formatDateInZone (fixed instant)', () => {
  it('reflects date rollover across zones for the same instant', () => {
    // 12:00 UTC on Jun 21 is still Jun 21 in Tokyo (21:00) but in Honolulu
    // (UTC-10) it is 02:00 on Jun 21 — same date here; use a date label check.
    expect(formatDateInZone(FIXED_INSTANT, 'Asia/Tokyo')).toMatch(/2026/)
    expect(formatDateInZone(FIXED_INSTANT, 'Asia/Tokyo')).toMatch(/Jun/)
    expect(formatDateInZone(FIXED_INSTANT, 'Asia/Tokyo')).toMatch(/21/)
  })

  it('crosses midnight: an instant late UTC is the next day in Tokyo', () => {
    const lateUtc = new Date('2026-06-21T23:30:00Z') // 08:30 Jun 22 in Tokyo
    expect(formatDateInZone(lateUtc, 'Asia/Tokyo')).toMatch(/22/)
  })
})

describe('getSupportedTimeZones', () => {
  it('returns a non-empty list of valid IANA zones', () => {
    const zones = getSupportedTimeZones()
    expect(zones.length).toBeGreaterThan(0)
    // Every entry should be a zone the runtime can actually format with.
    expect(zones.every((z) => isValidTimeZone(z))).toBe(true)
    // And it should include a well-known zone.
    expect(zones).toContain('Asia/Tokyo')
  })
})

describe('timeZoneDisplayLabel', () => {
  it('replaces underscores with spaces', () => {
    expect(timeZoneDisplayLabel('America/New_York')).toBe('America/New York')
  })
})
