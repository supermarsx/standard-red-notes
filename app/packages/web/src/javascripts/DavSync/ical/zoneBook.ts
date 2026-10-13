import ICAL from 'ical.js'
import { instantToWall, isKnownZone, utcMsFromWall, wallFromUtcMs, wallToInstant } from '@/Timezone/wallClock'
import { ZoneRules } from '../time/zoneRules'

const DAY_MS = 86_400_000

/**
 * Zone rules for one calendar entry (or one note).
 *
 * A zone the platform knows is converted by the platform's own database, which
 * is current and complete. Only for a name it does not know is the definition
 * embedded in the entry used: a `VTIMEZONE` is a simplified copy of the rules,
 * but for a zone with a made-up name it is the only description there is.
 */
export class ZoneBook implements ZoneRules {
  private readonly foreign = new Map<string, ICAL.Timezone>()
  private readonly texts = new Map<string, string>()

  /** Register an embedded definition. Ignored when the platform knows the name, or the text is not a definition. */
  add(tzid: string, vtimezone: string): void {
    if (tzid.length === 0 || isKnownZone(tzid) || this.foreign.has(tzid)) {
      return
    }
    try {
      const component = new ICAL.Component(ICAL.parse(vtimezone))
      if (component.name !== 'vtimezone') {
        return
      }
      this.foreign.set(tzid, new ICAL.Timezone({ component, tzid }))
      this.texts.set(tzid, vtimezone)
    } catch {
      // A definition that does not parse is the same as no definition.
    }
  }

  /** Register every definition a calendar object carries. */
  addAllFrom(vcalendar: ICAL.Component): void {
    for (const vtimezone of vcalendar.getAllSubcomponents('vtimezone')) {
      const tzid = vtimezone.getFirstPropertyValue('tzid')
      if (typeof tzid === 'string') {
        this.add(tzid, vtimezone.toString())
      }
    }
  }

  /** The text of the embedded definition registered for `tzid`, if one is. */
  definitionOf(tzid: string): string | undefined {
    return this.texts.get(tzid)
  }

  knows(zone: string): boolean {
    return isKnownZone(zone) || this.foreign.has(zone)
  }

  toInstant(zone: string, wall: string): number {
    if (isKnownZone(zone)) {
      return wallToInstant(zone, wall)
    }
    const timezone = this.foreign.get(zone)
    if (!timezone || Number.isNaN(utcMsFromWall(wall))) {
      return Number.NaN
    }
    return this.foreignInstant(timezone, wall)
  }

  toWall(zone: string, epochMs: number): string {
    if (isKnownZone(zone)) {
      return instantToWall(zone, epochMs)
    }
    const timezone = this.foreign.get(zone)
    if (!timezone || !Number.isFinite(epochMs)) {
      return ''
    }
    // The library answers "which offset applies to this WALL time". Ask it for
    // the walls a day either side, which are clear of any change, and keep the
    // offset that leads back to the instant asked about.
    const seconds = Math.floor(epochMs / 1000) * 1000
    const before = this.foreignOffsetMs(timezone, wallFromUtcMs(seconds - DAY_MS))
    const after = this.foreignOffsetMs(timezone, wallFromUtcMs(seconds + DAY_MS))
    for (const offset of [before, after]) {
      const wall = wallFromUtcMs(seconds + offset)
      if (this.foreignInstant(timezone, wall) === seconds) {
        return wall
      }
    }
    return wallFromUtcMs(seconds + before)
  }

  private foreignOffsetMs(timezone: ICAL.Timezone, wall: string): number {
    return timezone.utcOffset(ICAL.Time.fromDateTimeString(wall)) * 1000
  }

  private foreignInstant(timezone: ICAL.Timezone, wall: string): number {
    return utcMsFromWall(wall) - this.foreignOffsetMs(timezone, wall)
  }
}
