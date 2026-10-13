import { instantToWall, isKnownZone, wallToInstant } from '@/Timezone/wallClock'

/** Converts between a wall time in a zone and an instant. */
export interface ZoneRules {
  /** Whether a conversion for `zone` is possible at all. */
  knows(zone: string): boolean
  /** Milliseconds since the epoch, or NaN. */
  toInstant(zone: string, wall: string): number
  /** `YYYY-MM-DDTHH:MM:SS`, or `''`. */
  toWall(zone: string, epochMs: number): string
}

/** The rules of the zones the platform knows by name, from its own zone database. */
export const platformZoneRules: ZoneRules = {
  knows: isKnownZone,
  toInstant: wallToInstant,
  toWall: instantToWall,
}
