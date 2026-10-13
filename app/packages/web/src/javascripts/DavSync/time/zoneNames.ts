import { isKnownZone } from '@/Timezone/wallClock'
import { WINDOWS_ZONES } from './windowsZones'

/**
 * The name under which the platform knows the zone a `TZID` refers to, or
 * undefined when it knows none.
 *
 * Most servers send an IANA name as it is. Some prefix it
 * (`/mozilla.org/20050126_1/Europe/Berlin`,
 * `/freeassociation.sourceforge.net/Tzfile/Europe/Berlin`), so the trailing
 * path segments are tried, longest first. Outlook and Exchange use Windows
 * names, which are looked up in the CLDR table. An IANA name is returned as
 * written, not as the platform would canonicalise it: two devices with
 * different zone databases must store the same string.
 */
export function resolveZoneName(tzid: string): string | undefined {
  const trimmed = tzid.trim()
  if (isKnownZone(trimmed)) {
    return trimmed
  }
  if (Object.prototype.hasOwnProperty.call(WINDOWS_ZONES, trimmed) && isKnownZone(WINDOWS_ZONES[trimmed])) {
    return WINDOWS_ZONES[trimmed]
  }
  if (!trimmed.includes('/')) {
    return undefined
  }
  const segments = trimmed.split('/').filter((segment) => segment.length > 0)
  for (let take = Math.min(3, segments.length - 1); take >= 2; take--) {
    const candidate = segments.slice(segments.length - take).join('/')
    if (isKnownZone(candidate)) {
      return candidate
    }
  }
  return undefined
}
