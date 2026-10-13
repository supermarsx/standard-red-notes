import {
  CALENDAR_DOCUMENT_VERSION,
  CalendarEvent,
  parseCalendarDocument,
  serializeCalendarDocument,
} from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { parseCalendarObject } from '../ical/parseCalendarObject'
import { ZoneBook } from '../ical/zoneBook'
import { isInboundId, localIdForUid } from '../identity'
import { EventModel, fingerprintOfEvent } from '../model/eventModel'
import { eventFromModel, modelFromEvent } from '../model/eventNote'
import { DavFailure, fetchEntries, listEntries, readCollectionState } from '../protocol/caldav'
import { DavBinding, windowOf } from '../state/bindings'
import { DAV_NOTE_BYTES_LIMIT, noteBytesOf } from '../state/noteSize'
import { DavNoteState, readNoteState, storedNoteState } from '../state/noteState'
import { DavTransport } from '../transport/DavTransport'
import { Brake, PullPlanInput, RemoteEntry, brakeFor, planPull } from './pullPlan'

/**
 * Standard Red Notes: one read-only pass of a linked calendar.
 *
 * Ask whether the collection changed; if it did, list what is in the window,
 * fetch what is new or different, work out the plan, and put it into the note
 * in ONE change. Then, and only then, remember what was seen. A pass that stops
 * anywhere before that leaves the note as it was and is simply run again.
 *
 * Everything the pass writes is a function of the note and of what the server
 * said, with no clock and nothing random in it. Two of a person's devices that
 * run the same pass therefore write the same note, and equal notes are not a
 * conflict.
 */

/** Why a linked note cannot be synced as it is. Nothing is written anywhere while one of these holds. */
export type NoteProblem = 'missing' | 'trashed' | 'protected' | 'conflicted-copy' | 'not-a-calendar'

export type LinkedNote = {
  text: string
  /** The app-data value the note holds for calendar sync, as stored. */
  state: unknown
}

export interface NoteAccess {
  /** The linked note as it is right now. */
  read(): { ok: true; note: LinkedNote } | { ok: false; problem: NoteProblem }
  /** Replace the note's text and sync state in one change, and return once the note has been saved and synced. */
  write(text: string, state: DavNoteState, eventCount: number): Promise<void>
}

/** What a device remembers between passes. A cache: losing it costs requests, never correctness. */
export type PullCursor = {
  /** The collection's tag when it was last listed. */
  ctag?: string
  /** The UTC day the window was computed for. */
  day: string
  /** The ETag last seen for each entry, by name. */
  etags: Record<string, string>
}

export interface CursorStore {
  read(bindingId: string): PullCursor | undefined
  write(bindingId: string, cursor: PullCursor): void
}

export type PullDeps = {
  transport: DavTransport
  note: NoteAccess
  cursor: CursorStore
  now: () => number
}

export type PullCounts = { added: number; changed: number; removed: number; unchanged: number; unreadable: number }

/** How large the note is after a pass: every event it holds, and its bytes as `noteBytesOf` counts them. */
export type NoteSize = { bytes: number; events: number }

export type PassOutcome =
  | {
      kind: 'synced'
      counts: PullCounts
      /** Whether the note was changed. A pass after a pass that converged must say false. */
      wrote: boolean
      /** True when the collection's tag had not moved and nothing was listed. */
      skipped: boolean
      /** Entries that could not be read this time, by name, with the reason. */
      unreadable: Record<string, string>
      note: NoteSize
    }
  | { kind: 'paused'; problem: NoteProblem }
  | { kind: 'failed'; failure: DavFailure }
  /** The window holds more entries than the note may. Nothing was brought in. */
  | { kind: 'too-many'; count: number; cap: number }
  /** With what the window holds the note would pass the size it may have. Nothing was brought in. */
  | { kind: 'too-large'; bytes: number; limit: number; events: number }
  /** The plan would remove a large part of the calendar. Nothing was changed. */
  | { kind: 'brake'; brake: Brake }
  /** The note changed while the pass was working. Nothing was written; run it again. */
  | { kind: 'interrupted' }

export type PullOptions = {
  /** List and compare even when the collection's tag has not moved. */
  force?: boolean
  /** The person has seen what the brake reported and said to go ahead, this once. */
  pastBrake?: boolean
}

const NO_COUNTS: PullCounts = { added: 0, changed: 0, removed: 0, unchanged: 0, unreadable: 0 }

/** Reasons that come from reading an entry's content, and are therefore the same on every device. */
const isLastingReason = (reason: string): boolean => !['not-in-answer', 'no-data', 'too-large'].includes(reason)

/** The order events are stored in: by day, then time, then id. Fixed, so that the note's text is too. */
const inStoredOrder = (a: CalendarEvent, b: CalendarEvent): number => {
  const [keyA, keyB] = [`${a.date}\n${a.localStart ?? ''}\n${a.id}`, `${b.date}\n${b.localStart ?? ''}\n${b.id}`]
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
}

const zonesUsedBy = (events: CalendarEvent[]): Set<string> => {
  const used = new Set<string>()
  for (const event of events) {
    for (const occurrence of [event, ...(event.overrides ?? [])]) {
      if (occurrence.zone) {
        used.add(occurrence.zone)
      }
      if (occurrence.endZone) {
        used.add(occurrence.endZone)
      }
    }
  }
  return used
}

export async function runPullPass(
  binding: DavBinding,
  deps: PullDeps,
  options: PullOptions = {},
): Promise<PassOutcome> {
  const before = deps.note.read()
  if (!before.ok) {
    return { kind: 'paused', problem: before.problem }
  }
  const { document, recovered } = parseCalendarDocument(before.note.text)
  if (!recovered) {
    return { kind: 'paused', problem: 'not-a-calendar' }
  }
  const noteState = readNoteState(before.note.state, binding.id)
  const window = windowOf(binding, deps.now())
  const cursor = deps.cursor.read(binding.id)
  const prefix = binding.collectionPath

  // What the note holds that came from the server, and whether it still is what was agreed.
  const local = new Map<string, string>()
  const diverged = new Set<string>()
  for (const event of document.events) {
    if (isInboundId(event.id) || noteState.entries[event.id] !== undefined) {
      const fingerprint = fingerprintOfEvent(modelFromEvent(event))
      local.set(event.id, fingerprint)
      if (noteState.entries[event.id]?.b !== fingerprint) {
        diverged.add(event.id)
      }
    }
  }
  for (const id of Object.keys(noteState.entries)) {
    if (!local.has(id)) {
      diverged.add(id)
    }
  }

  const collection = await readCollectionState(deps.transport, prefix)
  if (!collection.ok) {
    return { kind: 'failed', failure: collection.failure }
  }
  const { ctag } = collection.value
  const nothingMoved =
    options.force !== true &&
    cursor !== undefined &&
    ctag !== undefined &&
    cursor.ctag === ctag &&
    cursor.day === window.day &&
    diverged.size === 0
  if (nothingMoved) {
    return {
      kind: 'synced',
      counts: { ...NO_COUNTS, unchanged: local.size },
      wrote: false,
      skipped: true,
      unreadable: noteState.unreadable ?? {},
      note: { bytes: noteBytesOf(before.note.text, storedNoteState(noteState)), events: document.events.length },
    }
  }

  const listing = await listEntries(deps.transport, prefix, 'VEVENT', { startMs: window.startMs, endMs: window.endMs })
  if (!listing.ok) {
    return { kind: 'failed', failure: listing.failure }
  }
  if (listing.value.size > binding.cap) {
    return { kind: 'too-many', count: listing.value.size, cap: binding.cap }
  }
  const listed = new Map<string, string>()
  for (const [path, etag] of listing.value) {
    listed.set(path.slice(prefix.length), etag)
  }

  // Fetch what is new, what changed, and what the note no longer holds as agreed. An entry that
  // could not be read last time is fetched again only once its ETag has moved.
  const idOfName = new Map<string, string>()
  for (const id of Object.keys(noteState.entries)) {
    idOfName.set(noteState.entries[id].h, id)
  }
  const knownUnreadable = noteState.unreadable ?? {}
  const toFetch = new Set<string>()
  for (const [name, etag] of listed) {
    const id = idOfName.get(name)
    const seenAsIs = cursor?.etags[name] === etag
    const stillUnreadable = seenAsIs && knownUnreadable[name] !== undefined
    if (!stillUnreadable && (!seenAsIs || id === undefined || diverged.has(id))) {
      toFetch.add(name)
    }
  }
  const fetched = await fetchEntries(
    deps.transport,
    prefix,
    [...toFetch].map((name) => `${prefix}${name}`),
  )
  if (!fetched.ok) {
    return { kind: 'failed', failure: fetched.failure }
  }

  const models = new Map<string, { model: EventModel; zones: Record<string, string> }>()
  const passingReasons: Record<string, string> = {}
  const remote: RemoteEntry[] = []
  for (const [name] of listed) {
    if (!toFetch.has(name)) {
      remote.push(
        knownUnreadable[name] !== undefined
          ? { name, state: 'unreadable', reason: knownUnreadable[name] }
          : { name, state: 'unchanged' },
      )
      continue
    }
    const entry = fetched.value.get(`${prefix}${name}`)
    if (!entry || entry.state === 'gone') {
      // Deleted between the listing and the fetch: as if it had not been listed.
      listed.delete(name)
      continue
    }
    if (entry.state === 'unreadable') {
      remote.push({ name, state: 'unreadable', reason: entry.reason })
      passingReasons[name] = entry.reason
      continue
    }
    const parsed = parseCalendarObject(entry.data)
    if (!parsed.ok) {
      remote.push({ name, state: 'unreadable', reason: parsed.reason })
      continue
    }
    const id = localIdForUid(parsed.model.uid)
    models.set(name, { model: parsed.model, zones: parsed.zoneDefinitions })
    remote.push({ name, state: 'fetched', id, fingerprint: fingerprintOfEvent(parsed.model) })
  }

  const input: PullPlanInput = { local, records: noteState.entries, remote }
  const plan = planPull(input)
  const brake = brakeFor(plan, input)
  if (brake && options.pastBrake !== true) {
    return { kind: 'brake', brake }
  }

  // Put the plan into the document.
  const replaced = new Set<string>([...plan.remove, ...plan.write.map((entry) => entry.id)])
  const events = document.events.filter((event) => !replaced.has(event.id))
  const zones: Record<string, string> = { ...(noteState.zones ?? {}) }
  for (const entry of plan.write) {
    const source = models.get(entry.name)
    if (!source) {
      continue
    }
    const book = new ZoneBook()
    for (const tzid of Object.keys(source.zones)) {
      book.add(tzid, source.zones[tzid])
      zones[tzid] = source.zones[tzid]
    }
    events.push(eventFromModel(source.model, { bindingZone: binding.zone, zones: book }))
  }
  events.sort(inStoredOrder)
  const used = zonesUsedBy(events)
  for (const tzid of Object.keys(zones)) {
    if (!used.has(tzid)) {
      delete zones[tzid]
    }
  }
  // Only reasons every device would reach are kept with the note; one that came from this fetch
  // alone would make two devices write two different notes.
  const lasting: Record<string, string> = {}
  for (const name of Object.keys(plan.unreadable)) {
    if (isLastingReason(plan.unreadable[name])) {
      lasting[name] = plan.unreadable[name]
    }
  }
  const state = storedNoteState({ v: 1, binding: binding.id, entries: plan.records, zones, unreadable: lasting })
  // The text is only rewritten when an entry goes in or out. A note another build wrote in its own
  // way (another key order, other spacing) is left byte for byte as it is until then, so that a
  // pass with nothing to do is not a save, and two builds do not take turns reformatting one note.
  const entriesChanged = plan.write.length > 0 || plan.remove.length > 0
  const text = entriesChanged
    ? serializeCalendarDocument({
        ...document,
        version: Math.max(document.version, CALENDAR_DOCUMENT_VERSION),
        events,
      })
    : before.note.text

  // The stored state is compared in the form it is written in, so that a store which hands the
  // same records back with their keys in another order is not taken for a change.
  const stateBefore = JSON.stringify(storedNoteState(noteState))
  const bytes = noteBytesOf(text, state)
  let wrote = false
  if (text !== before.note.text || JSON.stringify(state) !== stateBefore) {
    // A note past its bound takes nothing more in, and says so. It may always get smaller: a pass
    // that only takes entries out is how a note that is too large gets back under.
    if (bytes > DAV_NOTE_BYTES_LIMIT && bytes > noteBytesOf(before.note.text, storedNoteState(noteState))) {
      return { kind: 'too-large', bytes, limit: DAV_NOTE_BYTES_LIMIT, events: events.length }
    }
    const current = deps.note.read()
    if (!current.ok) {
      return { kind: 'paused', problem: current.problem }
    }
    if (
      current.note.text !== before.note.text ||
      JSON.stringify(current.note.state) !== JSON.stringify(before.note.state)
    ) {
      return { kind: 'interrupted' }
    }
    await deps.note.write(text, state, events.length)
    wrote = true
  }

  // Only now is what was seen remembered. An entry whose fetch failed in passing keeps no ETag, so
  // that the next pass asks for it again.
  const etags: Record<string, string> = {}
  for (const [name, etag] of listed) {
    if (passingReasons[name] === undefined) {
      etags[name] = etag
    }
  }
  deps.cursor.write(binding.id, ctag === undefined ? { day: window.day, etags } : { ctag, day: window.day, etags })

  return {
    kind: 'synced',
    counts: plan.counts,
    wrote,
    skipped: false,
    unreadable: plan.unreadable,
    note: { bytes, events: events.length },
  }
}
