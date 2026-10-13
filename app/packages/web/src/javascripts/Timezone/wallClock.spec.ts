import {
  addDays,
  daysBetween,
  daysInRange,
  instantToWall,
  isIsoDate,
  isKnownZone,
  isWallTime,
  offsetMinutesAt,
  utcMsFromWall,
  wallFromUtcMs,
  wallToInstant,
} from './wallClock'

const iso = (ms: number): string => (Number.isNaN(ms) ? 'NaN' : new Date(ms).toISOString())

/**
 * Known answers, worked out from the published rules of each zone and not from
 * this code. They hold for as long as those rules do; if a government changes
 * its clocks for 2026 after the fact, the row for that zone is what is wrong.
 */
const KNOWN_ANSWERS: [zone: string, wall: string, instant: string, why: string][] = [
  ['Europe/Berlin', '2026-01-15T09:00:00', '2026-01-15T08:00:00.000Z', 'winter, +1'],
  ['Europe/Berlin', '2026-07-15T09:00:00', '2026-07-15T07:00:00.000Z', 'summer, +2'],
  ['Europe/Berlin', '2026-03-29T01:59:59', '2026-03-29T00:59:59.000Z', 'the last second before clocks go forward'],
  ['Europe/Berlin', '2026-03-29T03:00:00', '2026-03-29T01:00:00.000Z', 'the first second after'],
  ['Europe/Berlin', '2026-10-25T03:00:00', '2026-10-25T02:00:00.000Z', 'after clocks went back'],
  ['America/New_York', '2026-07-04T12:00:00', '2026-07-04T16:00:00.000Z', 'summer, -4'],
  ['America/New_York', '2026-12-25T12:00:00', '2026-12-25T17:00:00.000Z', 'winter, -5'],
  ['Asia/Kathmandu', '2026-01-01T00:00:00', '2025-12-31T18:15:00.000Z', 'a 45-minute offset'],
  ['Pacific/Kiritimati', '2026-01-01T00:00:00', '2025-12-31T10:00:00.000Z', '+14, the far edge'],
  ['Asia/Tokyo', '2026-06-01T09:30:00', '2026-06-01T00:30:00.000Z', 'no daylight saving'],
  ['UTC', '2026-02-28T23:59:59', '2026-02-28T23:59:59.000Z', 'UTC itself'],
]

/** A wall time that the clocks skip. RFC 5545 reads it with the offset from before the gap. */
const SKIPPED: [zone: string, wall: string, instant: string, shownAs: string][] = [
  ['Europe/Berlin', '2026-03-29T02:30:00', '2026-03-29T01:30:00.000Z', '2026-03-29T03:30:00'],
  ['America/New_York', '2026-03-08T02:30:00', '2026-03-08T07:30:00.000Z', '2026-03-08T03:30:00'],
  ['America/Los_Angeles', '2026-03-08T02:00:00', '2026-03-08T10:00:00.000Z', '2026-03-08T03:00:00'],
  ['Europe/Lisbon', '2026-03-29T01:30:00', '2026-03-29T01:30:00.000Z', '2026-03-29T02:30:00'],
  ['Australia/Lord_Howe', '2026-10-04T02:15:00', '2026-10-03T15:45:00.000Z', '2026-10-04T02:45:00'],
]

/** A wall time that the clocks show twice. RFC 5545 means the first time. */
const REPEATED: [zone: string, wall: string, first: string, second: string][] = [
  ['Europe/Berlin', '2026-10-25T02:30:00', '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
  ['America/New_York', '2026-11-01T01:30:00', '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
  ['Australia/Lord_Howe', '2026-04-05T01:45:00', '2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z'],
]

describe('wallToInstant', () => {
  it.each(KNOWN_ANSWERS)('%s %s is %s (%s)', (zone, wall, instant) => {
    expect(iso(wallToInstant(zone, wall))).toBe(instant)
  })

  it.each(SKIPPED)('reads %s %s, which the clocks skip, with the offset from before the gap', (zone, wall, instant) => {
    expect(iso(wallToInstant(zone, wall))).toBe(instant)
  })

  it.each(SKIPPED)('…so %s %s is the moment the clocks then call %s', (zone, _wall, instant, shownAs) => {
    expect(instantToWall(zone, Date.parse(instant))).toBe(shownAs)
  })

  it.each(REPEATED)('reads %s %s, which the clocks show twice, as the first time', (zone, wall, first, second) => {
    expect(iso(wallToInstant(zone, wall))).toBe(first)
    // Both instants really do show that wall time; the later one is the one not chosen.
    expect(instantToWall(zone, Date.parse(first))).toBe(wall)
    expect(instantToWall(zone, Date.parse(second))).toBe(wall)
  })

  it('accepts a wall time without seconds', () => {
    expect(iso(wallToInstant('UTC', '2026-01-01T10:20'))).toBe('2026-01-01T10:20:00.000Z')
  })

  it('answers NaN for a zone nobody knows and for a wall time that is not one', () => {
    expect(wallToInstant('Nope/Nowhere', '2026-01-01T00:00:00')).toBeNaN()
    expect(wallToInstant('Europe/Berlin', '2026-02-30T00:00:00')).toBeNaN()
    expect(wallToInstant('Europe/Berlin', '2026-01-01T24:00:00')).toBeNaN()
    expect(wallToInstant('Europe/Berlin', '2026-01-01')).toBeNaN()
    expect(wallToInstant('Europe/Berlin', '')).toBeNaN()
  })
})

describe('instantToWall', () => {
  it.each(KNOWN_ANSWERS)('%s shows %s at %s', (zone, wall, instant) => {
    expect(instantToWall(zone, Date.parse(instant))).toBe(wall)
  })

  it('answers an empty string for a zone nobody knows and for a time that is not one', () => {
    expect(instantToWall('Nope/Nowhere', 0)).toBe('')
    expect(instantToWall('UTC', Number.NaN)).toBe('')
  })

  it('reports the offset in minutes', () => {
    expect(offsetMinutesAt('Asia/Kathmandu', Date.UTC(2026, 0, 1))).toBe(345)
    expect(offsetMinutesAt('America/New_York', Date.UTC(2026, 6, 4))).toBe(-240)
    expect(offsetMinutesAt('Nope/Nowhere', 0)).toBeNaN()
  })
})

describe('wall time and instant, both ways', () => {
  // A fixed sequence, so that a failure names the same case on every run.
  const random = (() => {
    let state = 0x9e3779b9
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  })()
  const zones = [
    'Europe/Berlin',
    'America/New_York',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Australia/Lord_Howe',
    'America/Sao_Paulo',
    'Africa/Casablanca',
    'Asia/Tehran',
    'Pacific/Apia',
    'UTC',
  ]

  it('gives back the instant it was given, or the earlier of two that share a wall time', () => {
    const from = Date.UTC(1995, 0, 1)
    const span = Date.UTC(2040, 0, 1) - from
    let checked = 0
    let sharedWallTimes = 0
    for (let index = 0; index < 4000; index++) {
      const zone = zones[index % zones.length]
      const instant = Math.floor((from + random() * span) / 1000) * 1000
      const wall = instantToWall(zone, instant)
      const back = wallToInstant(zone, wall)
      if (back !== instant) {
        expect(back).toBeLessThan(instant)
        expect(instantToWall(zone, back)).toBe(wall)
        sharedWallTimes += 1
      }
      checked += 1
    }
    expect(checked).toBe(4000)
    // Shared wall times are an hour a year; nearly every case must be an exact round trip.
    expect(sharedWallTimes).toBeLessThan(10)
  })
})

describe('dates and wall times as text', () => {
  it('reads and writes a wall time as UTC milliseconds', () => {
    expect(utcMsFromWall('1970-01-01T00:00:00')).toBe(0)
    expect(utcMsFromWall('2026-03-23T09:00:00')).toBe(Date.UTC(2026, 2, 23, 9))
    expect(wallFromUtcMs(Date.UTC(2026, 2, 23, 9, 5, 7))).toBe('2026-03-23T09:05:07')
    expect(wallFromUtcMs(Number.NaN)).toBe('')
  })

  it('keeps a year below 100 as written', () => {
    expect(wallFromUtcMs(utcMsFromWall('0099-12-31T23:59:59'))).toBe('0099-12-31T23:59:59')
  })

  it('tells a real wall time and a real date from text that only looks like one', () => {
    expect(isWallTime('2026-02-28T23:59:59')).toBe(true)
    expect(isWallTime('2024-02-29T00:00')).toBe(true)
    expect(isWallTime('2026-02-29T00:00:00')).toBe(false)
    expect(isWallTime('2026-13-01T00:00:00')).toBe(false)
    expect(isWallTime('2026-01-01T00:60:00')).toBe(false)
    expect(isWallTime('2026-01-01T00:00:00Z')).toBe(false)
    expect(isWallTime('2026-01-01')).toBe(false)
    expect(isWallTime(20260101)).toBe(false)
    expect(isIsoDate('2026-12-31')).toBe(true)
    expect(isIsoDate('2026-04-31')).toBe(false)
    expect(isIsoDate('2026-1-1')).toBe(false)
    expect(isIsoDate('2026-01-01T00:00:00')).toBe(false)
    expect(isIsoDate(undefined)).toBe(false)
  })

  it('moves a date by days across month, year and leap day', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(addDays('not a date', 1)).toBe('')
  })

  it('counts days between dates, a clock change in between or not', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(daysBetween('2026-03-30', '2026-03-28')).toBe(-2)
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366)
    expect(daysBetween('nope', '2026-01-01')).toBeNaN()
  })

  it('lists the days of a range, and always ends', () => {
    expect(daysInRange('2026-02-27', '2026-03-02', 10)).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ])
    expect(daysInRange('2026-02-27', '2026-02-27', 10)).toEqual(['2026-02-27'])
    expect(daysInRange('2026-02-27', '2026-03-02', 2)).toEqual(['2026-02-27', '2026-02-28'])
    expect(daysInRange('2026-03-02', '2026-02-27', 10)).toEqual([])
    expect(daysInRange('2026-02-31', '2026-03-02', 10)).toEqual([])
    expect(daysInRange('', '2026-03-02', 10)).toEqual([])
  })
})

describe('isKnownZone', () => {
  it('knows real zones and nothing else', () => {
    expect(isKnownZone('Europe/Berlin')).toBe(true)
    expect(isKnownZone('UTC')).toBe(true)
    expect(isKnownZone('W. Europe Standard Time')).toBe(false)
    expect(isKnownZone('')).toBe(false)
    expect(isKnownZone('x'.repeat(200))).toBe(false)
  })

  it('still answers after being asked about more unknown names than it remembers', () => {
    for (let index = 0; index < 900; index++) {
      expect(isKnownZone(`Nowhere/Place_${index}`)).toBe(false)
    }
    expect(isKnownZone('Asia/Tokyo')).toBe(true)
    expect(instantToWall('Asia/Tokyo', Date.UTC(2026, 5, 1, 0, 30))).toBe('2026-06-01T09:30:00')
  })
})
