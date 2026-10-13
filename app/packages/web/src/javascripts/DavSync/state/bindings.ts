import { isKnownZone } from '@/Timezone/wallClock'

/**
 * Standard Red Notes: which calendars are linked to which notes, and how.
 *
 * A BINDING pairs one note with one collection on one connected account. The
 * list lives in a synced preference, so every device of the person has the same
 * links; it holds no password and nothing of the calendar itself. What has been
 * synced is recorded with the note (see `noteState.ts`), not here.
 *
 * The preference key is written as a literal, for the reason
 * `todoCalendarPublication.ts` documents: web runs a prebuilt models bundle in
 * which a new `PrefKey` member is `undefined`, and a preference stored under
 * `undefined` is a preference that silently does nothing.
 */
export const DAV_SYNC_PREF_KEY = 'davSync'

export type DavBindingKind = 'events' | 'tasks'

/** Which way changes travel. A read-only import is `pull`. */
export type DavDirection = 'pull' | 'push' | 'two-way'

/** What happens when the same entry was changed in both places. */
export type DavConflictPolicy = 'keep-both' | 'remote-wins' | 'app-wins' | 'ask'

export type DavBinding = {
  id: string
  /** The connected account on the Standard Red Notes server that reaches the collection. */
  accountId: string
  /** How to name that account when the server cannot be asked: `alice @ cloud.example.org`. */
  accountLabel: string
  kind: DavBindingKind
  noteUuid: string
  /** The collection's path on the account's origin, ending in `/`, in the one spelling the engine uses. */
  collectionPath: string
  collectionName: string
  direction: DavDirection
  /** Minutes between passes while the app is open; 0 for "only when asked". */
  intervalMinutes: number
  onConflict: DavConflictPolicy
  /** How far back entries are brought in, in days. */
  windowDaysBack: number
  /** How far ahead entries are brought in, in months. */
  windowMonthsAhead: number
  /** The zone a time tied to no zone is read in. Fixed when the link is made; never the device's. */
  zone: string
  /** The most entries the note may hold for this link. Reaching it stops the pass and says so. */
  cap: number
  enabled: boolean
}

export type DavSyncSettings = {
  version: 1
  bindings: DavBinding[]
}

export const DAV_INTERVALS = [0, 5, 15, 30, 60] as const
export const DAV_DEFAULT_INTERVAL = 15
export const DAV_DEFAULT_WINDOW_DAYS_BACK = 30
export const DAV_DEFAULT_WINDOW_MONTHS_AHEAD = 12
export const DAV_DEFAULT_CAP = 1_000
export const DAV_MAX_CAP = 3_000
export const DAV_MAX_BINDINGS = 50

export const EMPTY_DAV_SYNC_SETTINGS: DavSyncSettings = { version: 1, bindings: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | undefined => {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

const wholeNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * One binding as stored, or undefined when it cannot be used. A binding that
 * does not say which note, which account and which collection is dropped, not
 * guessed at; every other setting falls back to its default, and to the more
 * careful one where there is a choice (an unknown direction is read-only).
 */
function normalizeBinding(raw: unknown): DavBinding | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const id = text(raw.id, 128)
  const accountId = text(raw.accountId, 128)
  const noteUuid = text(raw.noteUuid, 128)
  const collectionPath = text(raw.collectionPath, 2_048)
  if (
    !id ||
    !accountId ||
    !noteUuid ||
    !collectionPath ||
    !collectionPath.startsWith('/') ||
    !collectionPath.endsWith('/')
  ) {
    return undefined
  }
  const interval = wholeNumber(raw.intervalMinutes, 0, 60, DAV_DEFAULT_INTERVAL)
  const zone = text(raw.zone, 128)
  return {
    id,
    accountId,
    accountLabel: text(raw.accountLabel, 512) ?? '',
    kind: oneOf(raw.kind, ['events', 'tasks'] as const, 'events'),
    noteUuid,
    collectionPath,
    collectionName: text(raw.collectionName, 512) ?? '',
    direction: oneOf(raw.direction, ['pull', 'push', 'two-way'] as const, 'pull'),
    intervalMinutes: (DAV_INTERVALS as readonly number[]).includes(interval) ? interval : DAV_DEFAULT_INTERVAL,
    onConflict: oneOf(raw.onConflict, ['keep-both', 'remote-wins', 'app-wins', 'ask'] as const, 'keep-both'),
    windowDaysBack: wholeNumber(raw.windowDaysBack, 0, 3_650, DAV_DEFAULT_WINDOW_DAYS_BACK),
    windowMonthsAhead: wholeNumber(raw.windowMonthsAhead, 1, 120, DAV_DEFAULT_WINDOW_MONTHS_AHEAD),
    zone: zone && isKnownZone(zone) ? zone : 'UTC',
    cap: wholeNumber(raw.cap, 1, DAV_MAX_CAP, DAV_DEFAULT_CAP),
    enabled: raw.enabled !== false,
  }
}

/** The settings as stored, with everything unusable removed. Never throws. */
export function normalizeDavSyncSettings(raw: unknown): DavSyncSettings {
  if (!isRecord(raw) || !Array.isArray(raw.bindings)) {
    return { version: 1, bindings: [] }
  }
  const bindings: DavBinding[] = []
  const ids = new Set<string>()
  const notes = new Set<string>()
  for (const entry of raw.bindings) {
    const binding = normalizeBinding(entry)
    // One note is linked to one collection: a second link to the same note would have two
    // calendars writing into one list of events.
    if (!binding || ids.has(binding.id) || notes.has(binding.noteUuid) || bindings.length >= DAV_MAX_BINDINGS) {
      continue
    }
    ids.add(binding.id)
    notes.add(binding.noteUuid)
    bindings.push(binding)
  }
  return { version: 1, bindings }
}

/** The days a pass brings in: from midnight UTC `daysBack` days before today to midnight `monthsAhead` months after. */
export function windowOf(
  binding: Pick<DavBinding, 'windowDaysBack' | 'windowMonthsAhead'>,
  nowMs: number,
): { day: string; startMs: number; endMs: number } {
  const now = new Date(nowMs)
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const end = new Date(today)
  end.setUTCMonth(end.getUTCMonth() + binding.windowMonthsAhead)
  return {
    // The day is in UTC so that two devices in different zones agree on the window, and so on what the note holds.
    day: new Date(today).toISOString().slice(0, 10),
    startMs: today - binding.windowDaysBack * 86_400_000,
    endMs: end.getTime(),
  }
}
