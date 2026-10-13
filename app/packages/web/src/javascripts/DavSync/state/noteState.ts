/**
 * Standard Red Notes: what a linked note remembers about its sync.
 *
 * For every entry: the name it has on the other server, and the fingerprint of
 * the last version both sides agreed on (the BASE). That is all change
 * detection needs, and it has to change in the same save as the events
 * themselves, so it lives in the note: in its encrypted app data, under one key,
 * the way reminders do.
 *
 * Not in the note's text. An older build that opens the note rewrites the text
 * from what it understands of it; app data it copies whole. And nothing here is
 * load-bearing for safety: an entry's identity is computed from its UID, so a
 * note that lost these records entirely is matched up again entry by entry, not
 * duplicated.
 */
export const DAV_NOTE_STATE_KEY = 'davSync'

export type DavEntryRecord = {
  /** The entry's name inside its collection, escaped as the engine spells paths: `abc.ics`. */
  h: string
  /** The fingerprint of the version both sides last agreed on. */
  b: string
}

export type DavNoteState = {
  v: 1
  /** The binding these records belong to. Records of another binding are not this link's. */
  binding: string
  /** By event id. */
  entries: Record<string, DavEntryRecord>
  /** Definitions of zones the platform has no name for, by zone name, as the entries carried them. */
  zones?: Record<string, string>
  /** Entries on the server that could not be read, by name, with the reason. Shown; never touched. */
  unreadable?: Record<string, string>
}

const MAX_RECORD_TEXT = 1_024
const MAX_ZONE_DEFINITION = 16_384

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const shortText = (value: unknown, max = MAX_RECORD_TEXT): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

/** A copy with its keys in order, so that the same records are always the same stored value. */
const sorted = <T>(record: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {}
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key]
  }
  return out
}

const textRecord = (raw: unknown, maxValue: number): Record<string, string> | undefined => {
  if (!isRecord(raw)) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (shortText(key) && shortText(value, maxValue)) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? sorted(out) : undefined
}

/**
 * The state as stored for `bindingId`, or an empty one when there is none, it
 * is unreadable, or it belongs to another binding. Never throws.
 */
export function readNoteState(raw: unknown, bindingId: string): DavNoteState {
  const state: DavNoteState = { v: 1, binding: bindingId, entries: {} }
  if (!isRecord(raw) || raw.v !== 1 || raw.binding !== bindingId || !isRecord(raw.entries)) {
    return state
  }
  const entries: Record<string, DavEntryRecord> = {}
  for (const id of Object.keys(raw.entries)) {
    const record = raw.entries[id]
    if (shortText(id) && isRecord(record) && shortText(record.h) && shortText(record.b)) {
      entries[id] = { h: record.h, b: record.b }
    }
  }
  state.entries = sorted(entries)
  const zones = textRecord(raw.zones, MAX_ZONE_DEFINITION)
  if (zones) {
    state.zones = zones
  }
  const unreadable = textRecord(raw.unreadable, MAX_RECORD_TEXT)
  if (unreadable) {
    state.unreadable = unreadable
  }
  return state
}

/** The value to store: keys in a fixed order at every level, and nothing empty. */
export function storedNoteState(state: DavNoteState): DavNoteState {
  const stored: DavNoteState = { v: 1, binding: state.binding, entries: sorted(state.entries) }
  if (state.zones && Object.keys(state.zones).length > 0) {
    stored.zones = sorted(state.zones)
  }
  if (state.unreadable && Object.keys(state.unreadable).length > 0) {
    stored.unreadable = sorted(state.unreadable)
  }
  return stored
}
