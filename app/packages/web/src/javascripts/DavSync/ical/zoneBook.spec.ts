/**
 * @jest-environment node
 */
import { ZoneBook } from './zoneBook'

/** A zone as Outlook writes one it could not name: European rules, one hour ahead in winter and two in summer. */
const CUSTOMIZED = [
  'BEGIN:VTIMEZONE',
  'TZID:Customized Time Zone',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n')

/** A zone with no daylight saving at all, a quarter of an hour off the hour. */
const FIXED = [
  'BEGIN:VTIMEZONE',
  'TZID:Base Camp',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0545',
  'TZOFFSETTO:+0545',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n')

const iso = (ms: number): string => (Number.isNaN(ms) ? 'NaN' : new Date(ms).toISOString())

const book = (): ZoneBook => {
  const zones = new ZoneBook()
  zones.add('Customized Time Zone', CUSTOMIZED)
  zones.add('Base Camp', FIXED)
  return zones
}

describe('ZoneBook', () => {
  it('knows the zones the platform knows, and the ones it was given a definition for', () => {
    const zones = book()
    expect(zones.knows('Europe/Berlin')).toBe(true)
    expect(zones.knows('Customized Time Zone')).toBe(true)
    expect(zones.knows('Base Camp')).toBe(true)
    expect(zones.knows('Somewhere Else')).toBe(false)
    expect(new ZoneBook().knows('Customized Time Zone')).toBe(false)
  })

  it.each([
    ['Customized Time Zone', '2026-01-15T09:00:00', '2026-01-15T08:00:00.000Z'],
    ['Customized Time Zone', '2026-03-23T09:00:00', '2026-03-23T08:00:00.000Z'],
    ['Customized Time Zone', '2026-03-30T09:00:00', '2026-03-30T07:00:00.000Z'],
    ['Customized Time Zone', '2026-07-01T12:00:00', '2026-07-01T10:00:00.000Z'],
    ['Customized Time Zone', '2026-10-24T12:00:00', '2026-10-24T10:00:00.000Z'],
    ['Customized Time Zone', '2026-10-26T12:00:00', '2026-10-26T11:00:00.000Z'],
    ['Base Camp', '2026-01-01T00:00:00', '2025-12-31T18:15:00.000Z'],
    ['Base Camp', '2026-07-01T12:00:00', '2026-07-01T06:15:00.000Z'],
  ])('reads %s %s by its embedded definition as %s', (zone, wall, instant) => {
    const zones = book()
    expect(iso(zones.toInstant(zone, wall))).toBe(instant)
    expect(zones.toWall(zone, Date.parse(instant))).toBe(wall)
  })

  it('gives back the wall time it was given, hour by hour through a year, away from the two clock changes', () => {
    const zones = book()
    let checked = 0
    for (let hour = 0; hour < 365 * 24; hour += 7) {
      const instant = Date.UTC(2026, 0, 1) + hour * 3_600_000
      const day = new Date(instant).toISOString().slice(0, 10)
      // The two days on which this zone's clocks change are read as the library reads them, and are
      // not claimed here: 29 March and 25 October 2026.
      if (day === '2026-03-29' || day === '2026-10-25') {
        continue
      }
      const wall = zones.toWall('Customized Time Zone', instant)
      expect(zones.toInstant('Customized Time Zone', wall)).toBe(instant)
      checked += 1
    }
    expect(checked).toBeGreaterThan(1200)
  })

  it('uses the platform’s own rules for a zone the platform knows, whatever definition comes with it', () => {
    const zones = new ZoneBook()
    // A definition claiming Berlin is nine hours ahead. The platform knows better, and is believed.
    zones.add(
      'Europe/Berlin',
      [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0900',
        'TZOFFSETTO:+0900',
        'END:STANDARD',
        'END:VTIMEZONE',
      ].join('\r\n'),
    )
    expect(iso(zones.toInstant('Europe/Berlin', '2026-01-15T09:00:00'))).toBe('2026-01-15T08:00:00.000Z')
    expect(zones.definitionOf('Europe/Berlin')).toBeUndefined()
  })

  it('keeps the text of a definition it uses, and only of those', () => {
    const zones = book()
    expect(zones.definitionOf('Customized Time Zone')).toBe(CUSTOMIZED)
    expect(zones.definitionOf('Somewhere Else')).toBeUndefined()
  })

  it('keeps the first definition given for a name', () => {
    const zones = book()
    zones.add('Base Camp', FIXED.replace(/\+0545/g, '+0100'))
    expect(iso(zones.toInstant('Base Camp', '2026-01-01T00:00:00'))).toBe('2025-12-31T18:15:00.000Z')
  })

  it.each([
    ['text that is not a definition', 'not a timezone'],
    ['another kind of component', 'BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT'],
    ['nothing', ''],
  ])('ignores %s', (_what, text) => {
    const zones = new ZoneBook()
    zones.add('Odd', text)
    expect(zones.knows('Odd')).toBe(false)
    expect(zones.toInstant('Odd', '2026-01-01T00:00:00')).toBeNaN()
    expect(zones.toWall('Odd', 0)).toBe('')
  })

  it('answers NaN and an empty string for what cannot be converted', () => {
    const zones = book()
    expect(zones.toInstant('Customized Time Zone', 'not a time')).toBeNaN()
    expect(zones.toInstant('Somewhere Else', '2026-01-01T00:00:00')).toBeNaN()
    expect(zones.toWall('Customized Time Zone', Number.NaN)).toBe('')
    expect(zones.toWall('Somewhere Else', 0)).toBe('')
  })
})
