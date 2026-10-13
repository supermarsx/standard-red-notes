/**
 * @jest-environment node
 */
import { instantToWall, isKnownZone } from '@/Timezone/wallClock'
import { WINDOWS_ZONES } from './windowsZones'
import { resolveZoneName } from './zoneNames'

describe('resolveZoneName', () => {
  it.each([
    ['Europe/Berlin', 'Europe/Berlin'],
    ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['UTC', 'UTC'],
    ['  Europe/Lisbon ', 'Europe/Lisbon'],
  ])('keeps a name the platform knows, %j', (tzid, zone) => {
    expect(resolveZoneName(tzid)).toBe(zone)
  })

  it('returns a name as it was written, not as the platform would rename it', () => {
    // Two devices with different zone databases must store the same string for the same entry.
    expect(resolveZoneName('Asia/Calcutta')).toBe('Asia/Calcutta')
    expect(resolveZoneName('Europe/Kiev')).toBe('Europe/Kiev')
  })

  it.each([
    ['/mozilla.org/20050126_1/Europe/Berlin', 'Europe/Berlin'],
    ['/freeassociation.sourceforge.net/Tzfile/Europe/Lisbon', 'Europe/Lisbon'],
    ['/freeassociation.sourceforge.net/Tzfile/America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['/citadel.org/20190914_1/America/New_York', 'America/New_York'],
  ])('finds the zone inside a prefixed name, %j', (tzid, zone) => {
    expect(resolveZoneName(tzid)).toBe(zone)
  })

  // A handful a person can check against a Windows clock. The table itself is generated from CLDR.
  it.each([
    ['W. Europe Standard Time', 'Europe/Berlin'],
    ['GMT Standard Time', 'Europe/London'],
    ['Romance Standard Time', 'Europe/Paris'],
    ['Eastern Standard Time', 'America/New_York'],
    ['Pacific Standard Time', 'America/Los_Angeles'],
    ['Tokyo Standard Time', 'Asia/Tokyo'],
    ['India Standard Time', 'Asia/Calcutta'],
    ['AUS Eastern Standard Time', 'Australia/Sydney'],
    ['E. South America Standard Time', 'America/Sao_Paulo'],
    ['Nepal Standard Time', 'Asia/Katmandu'],
  ])('reads the Windows name %j as %j', (windows, zone) => {
    expect(resolveZoneName(windows)).toBe(zone)
  })

  it.each([
    'Customized Time Zone',
    'Mars/Olympus_Mons',
    '',
    'Europe',
    '/',
    'w. europe standard time',
    'constructor',
    'toString',
    '__proto__',
  ])('knows no zone for %j', (tzid) => {
    expect(resolveZoneName(tzid)).toBeUndefined()
  })
})

describe('the table of Windows zone names', () => {
  it('has every name Windows has, each pointing at a zone the platform knows', () => {
    const names = Object.keys(WINDOWS_ZONES)
    expect(names).toHaveLength(139)
    for (const name of names) {
      expect(isKnownZone(WINDOWS_ZONES[name])).toBe(true)
    }
  })

  it('points each "… Standard Time" at a zone that really has the offset the name implies', () => {
    // Winter offsets, in minutes, that are not in doubt. A row pointing at the wrong zone would move
    // every meeting sent from Outlook in that zone.
    const january = Date.UTC(2026, 0, 15, 12)
    const offsetOf = (windows: string): number => {
      const wall = instantToWall(WINDOWS_ZONES[windows], january)
      return (Date.parse(`${wall}Z`) - january) / 60_000
    }
    expect(
      Object.fromEntries(
        [
          'W. Europe Standard Time',
          'GMT Standard Time',
          'Eastern Standard Time',
          'Central Standard Time',
          'Mountain Standard Time',
          'Pacific Standard Time',
          'India Standard Time',
          'China Standard Time',
          'Tokyo Standard Time',
          'Nepal Standard Time',
          'UTC',
          'Hawaiian Standard Time',
          'FLE Standard Time',
          'Russian Standard Time',
        ].map((windows) => [windows, offsetOf(windows)]),
      ),
    ).toEqual({
      'W. Europe Standard Time': 60,
      'GMT Standard Time': 0,
      'Eastern Standard Time': -300,
      'Central Standard Time': -360,
      'Mountain Standard Time': -420,
      'Pacific Standard Time': -480,
      'India Standard Time': 330,
      'China Standard Time': 480,
      'Tokyo Standard Time': 540,
      'Nepal Standard Time': 345,
      UTC: 0,
      'Hawaiian Standard Time': -600,
      'FLE Standard Time': 120,
      'Russian Standard Time': 180,
    })
  })
})
