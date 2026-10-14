import { formatLogTimestampUTC, orderLogEntries } from './adminHelpers'

it('prints precise UTC timestamps independently of the browser timezone and labels missing timestamps', () => {
  expect(formatLogTimestampUTC('2026-10-14T14:23:45.123+02:00')).toBe('2026-10-14 12:23:45.123 UTC')
  expect(formatLogTimestampUTC(null)).toBe('Timestamp unavailable')
  expect(formatLogTimestampUTC('invalid')).toBe('Timestamp unavailable')
  expect(formatLogTimestampUTC('2026-10-14T12:23:45')).toBe('Timestamp unavailable')
})

it('orders known timestamps chronologically and preserves the relative order of untimed legacy lines', () => {
  const entries = [
    { timestamp: null, service: null, level: null, message: 'legacy one' },
    { timestamp: '2026-10-14T12:02:00Z', service: null, level: null, message: 'newer' },
    { timestamp: '2026-10-14T12:01:00Z', service: null, level: null, message: 'older' },
    { timestamp: null, service: null, level: null, message: 'legacy two' },
  ]
  expect(orderLogEntries(entries, 'desc').map((entry) => entry.message)).toEqual([
    'newer',
    'older',
    'legacy one',
    'legacy two',
  ])
  expect(orderLogEntries(entries, 'asc').map((entry) => entry.message)).toEqual([
    'older',
    'newer',
    'legacy one',
    'legacy two',
  ])
  expect(entries[0].message).toBe('legacy one')
})
