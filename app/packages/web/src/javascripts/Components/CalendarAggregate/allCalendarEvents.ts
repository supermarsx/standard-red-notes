import { SNNote } from '@standardnotes/snjs'
import { CalendarEvent, parseCalendarDocument } from '../NoteView/CalendarEditor/CalendarDocument'
import { CalendarEditorIdentifier } from '../NoteView/CalendarEditor/CalendarEditor'

/**
 * Standard Red Notes: cross-note Calendar aggregate collector.
 *
 * Calendar notes mark themselves via `note.editorIdentifier ===
 * CalendarEditorIdentifier` and store their events as JSON in `note.text` (see
 * {@link parseCalendarDocument}). This module gathers every calendar note's
 * events onto one timeline, each event keeping a back-reference to its source
 * note so the aggregate view can open it. Pure, in-memory — no polling.
 */

/** A calendar event paired with the source note it came from. */
export type AggregatedCalendarEvent = {
  event: CalendarEvent
  note: SNNote
}

/** True if a note is a Calendar note type. */
export function isCalendarNote(note: SNNote): boolean {
  return note.editorIdentifier === CalendarEditorIdentifier
}

/**
 * Collect every event from every (non-trashed) calendar note. Malformed/empty
 * calendar notes contribute nothing (parseCalendarDocument never throws).
 */
export function collectAllCalendarEvents(notes: SNNote[]): AggregatedCalendarEvent[] {
  const all: AggregatedCalendarEvent[] = []
  for (const note of notes) {
    if (note.trashed || !isCalendarNote(note)) {
      continue
    }
    const { document } = parseCalendarDocument(note.text)
    for (const event of document.events) {
      all.push({ event, note })
    }
  }
  return all
}

/**
 * Index aggregated events by their ISO YYYY-MM-DD date for O(1) per-cell lookup
 * when rendering a month grid. Events on the same day preserve insertion order.
 */
export function indexCalendarEventsByDate(
  events: AggregatedCalendarEvent[],
): Map<string, AggregatedCalendarEvent[]> {
  const map = new Map<string, AggregatedCalendarEvent[]>()
  for (const aggregated of events) {
    const key = aggregated.event.date
    const existing = map.get(key)
    if (existing) {
      existing.push(aggregated)
    } else {
      map.set(key, [aggregated])
    }
  }
  return map
}
