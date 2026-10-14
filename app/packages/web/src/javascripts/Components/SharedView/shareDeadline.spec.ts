import { localShareDeadline } from './shareDeadline'

it('uses the remaining server window even when the browser clock is years ahead', () => {
  const received = Date.parse('2030-01-01T00:00:00Z')
  expect(localShareDeadline('2026-10-09T10:56:37Z', '2026-10-09T10:56:35Z', received, 0)).toBe(received + 2000)
  expect(localShareDeadline('2026-10-09T10:56:37Z', '2026-10-09T10:56:35Z', received, 100)).toBe(received + 1950)
})

it('keeps past deadlines expired and only falls back to an absolute deadline when no valid server clock exists', () => {
  const received = Date.now()
  expect(localShareDeadline('2026-10-09T10:56:37Z', '2026-10-09T10:56:38Z', received, 0)).toBe(received - 1000)
  expect(localShareDeadline('2026-10-09T10:56:37Z', undefined, received, 0)).toBe(Date.parse('2026-10-09T10:56:37Z'))
  expect(localShareDeadline(undefined, undefined, received, 0)).toBeUndefined()
})
