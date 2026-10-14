import { shareExpiresAt, shareStatus } from './shareExpiry'

const share = { revoked: false, viewExpiresMinutes: 15, firstOpenedAt: '2026-10-09T10:41:37Z' }
const expiry = new Date('2026-10-09T10:56:37Z').getTime()

it('expires exactly fifteen minutes after first open even before the server marks the row revoked', () => {
  expect(shareExpiresAt(share)).toBe(expiry)
  expect(shareStatus(share, expiry - 1)).toBe('Active')
  expect(shareStatus(share, expiry)).toBe('Expired')
  expect(shareStatus(share, Date.parse('2026-10-14T00:00:00Z'))).toBe('Expired')
  expect(shareStatus({ ...share, revoked: true }, expiry)).toBe('Expired')
})

it('keeps unopened timed links active and distinguishes consumed one-time links from windowed links', () => {
  expect(shareStatus({ revoked: false, viewExpiresMinutes: 15, firstOpenedAt: null }, expiry)).toBe('Active')
  expect(shareStatus({ revoked: true }, expiry)).toBe('Revoked')
  expect(shareStatus({ revoked: false, oneTimeView: true, firstOpenedAt: share.firstOpenedAt }, expiry)).toBe(
    'Burned (opened)',
  )
  expect(shareStatus({ ...share, oneTimeView: true }, expiry - 1)).toBe('Active')
  expect(shareStatus({ ...share, oneTimeView: true, revoked: true }, expiry - 1)).toBe('Revoked')
})
