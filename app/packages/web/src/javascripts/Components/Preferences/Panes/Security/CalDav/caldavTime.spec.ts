import {
  convertTemporalInputMode,
  formatCalendarValue,
  isValidDateOnly,
  parseTemporalInput,
  temporalInputValue,
  temporalRangeError,
} from './caldavTime'

describe('CalDAV temporal form helpers', () => {
  it('preserves a date-only value exactly instead of applying a timezone shift', () => {
    expect(temporalInputValue('2026-08-01')).toBe('2026-08-01')
    expect(parseTemporalInput('2026-08-01', 'due', true)).toBe('2026-08-01')
    expect(formatCalendarValue('2026-08-01')).toBe('2026-08-01')
  })

  it('strictly rejects normalized invalid calendar dates', () => {
    expect(isValidDateOnly('2024-02-29')).toBe(true)
    expect(isValidDateOnly('2025-02-29')).toBe(false)
    expect(isValidDateOnly('2026-02-31')).toBe(false)
    expect(() => parseTemporalInput('2026-02-31', 'due', true)).toThrow('Enter a valid due date.')
  })

  it('converts date input modes deliberately', () => {
    expect(convertTemporalInputMode('2026-08-01T14:45', true)).toBe('2026-08-01')
    expect(convertTemporalInputMode('2026-08-01', false)).toBe('2026-08-01T00:00')
  })

  it('rejects mixed value types and non-increasing ranges before publication', () => {
    expect(temporalRangeError('2026-08-01', '2026-08-02T10:00:00Z', true, false)).toMatch(/both/)
    expect(temporalRangeError('2026-08-02', '2026-08-01', true, true)).toBe('Due must be later than start.')
    expect(temporalRangeError('2026-08-01', '2026-08-02', true, true)).toBeNull()
  })
})
