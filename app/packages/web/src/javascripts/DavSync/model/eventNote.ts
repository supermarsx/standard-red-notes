import {
  CalendarEvent,
  CalendarOccurrenceFields,
  CalendarOccurrenceOverride,
} from '@/Components/NoteView/CalendarEditor/CalendarDocument'
import { addDays, daysBetween, utcMsFromWall } from '@/Timezone/wallClock'
import { localIdForUid } from '../identity'
import { ZoneRules } from '../time/zoneRules'
import {
  EventModel,
  ModelTime,
  OccurrenceModel,
  OverrideModel,
  ruleOfSimpleRecurrence,
  simpleRecurrenceOf,
} from './eventModel'

/**
 * Standard Red Notes: an entry's model as an event in a calendar note, and
 * back.
 *
 * The two directions have to be exact inverses on everything the model holds.
 * A sync pass compares the fingerprint of what the note holds with the
 * fingerprint of what the server holds; if writing a model into the note and
 * reading it back gave a model that differed in any way, that entry would look
 * edited on every pass, for ever. The spec checks the round trip over every
 * entry of the corpus and over generated ones.
 *
 * Writing is also deterministic: the same model always becomes the same event,
 * with no clock and nothing random in it, on every device. Two of a person's
 * devices that import the same entry at the same moment then hold equal notes,
 * and equal notes are not a conflict.
 */

export type EventNoteContext = {
  /**
   * The zone a time tied to no zone is given an instant in, for builds that
   * only understand instants. Fixed per linked calendar, never the device's.
   */
  bindingZone: string
  zones: ZoneRules
}

const isoInstant = (epochMs: number): string => new Date(epochMs).toISOString()

/** The zone a time is read on, and whether it is tied to none. */
const zoneOf = (time: Exclude<ModelTime, { kind: 'date' }>, bindingZone: string): string => {
  if (time.kind === 'zoned') {
    return time.zone
  }
  return time.kind === 'utc' ? 'UTC' : bindingZone
}

/**
 * The instant of a wall time. A zone no rule can explain is read as UTC: wrong
 * by that zone's offset for a build that only knows instants, but the same
 * wrong on every device, and never used by a build that knows the wall time.
 */
const instantOf = (zone: string, wall: string, zones: ZoneRules): number => {
  const instant = zones.knows(zone) ? zones.toInstant(zone, wall) : Number.NaN
  return Number.isNaN(instant) ? utcMsFromWall(wall) : instant
}

type Written = { fields: CalendarOccurrenceFields; date: string; instants?: { startMs: number; endMs?: number } }

/** The version 2 keys of one occurrence, and its instants when it is timed. */
function writeOccurrence(occurrence: OccurrenceModel, context: EventNoteContext): Written {
  const fields: CalendarOccurrenceFields = {}
  let date: string
  let instants: Written['instants']

  const { start, end } = occurrence
  if (start.kind === 'date') {
    date = start.value
    const days = end && end.kind === 'date' ? daysBetween(start.value, end.value) : 1
    if (days >= 2) {
      fields.days = days
    }
  } else {
    const zone = zoneOf(start, context.bindingZone)
    date = start.value.slice(0, 10)
    fields.zone = zone
    const startMs = instantOf(zone, start.value, context.zones)
    instants = { startMs }
    if (end && end.kind !== 'date') {
      const endZone = zoneOf(end, context.bindingZone)
      if (endZone !== zone) {
        fields.endZone = endZone
      }
      // An event that starts at a wall time the clocks skip is read an hour on, which can put the
      // instant of its start after the instant of its end. A build that only knows instants drops
      // an end that is not after the start, so the end is kept just after it rather than lost.
      instants.endMs = Math.max(instantOf(endZone, end.value, context.zones), startMs + 1000)
    }
    if (start.kind === 'floating') {
      fields.floating = true
    }
    fields.localStart = start.value
    if (end && end.kind !== 'date') {
      fields.localEnd = end.value
    }
  }

  if (occurrence.description.length > 0) {
    fields.description = occurrence.description
  }
  if (occurrence.location.length > 0) {
    fields.location = occurrence.location
  }
  if (occurrence.status !== '') {
    fields.status = occurrence.status
  }
  if (occurrence.clipped.length > 0) {
    fields.clipped = occurrence.clipped
  }
  return { fields, date, instants }
}

const writeOverride = (override: OverrideModel, context: EventNoteContext): CalendarOccurrenceOverride => {
  const { fields, date } = writeOccurrence(override, context)
  return { rid: override.recurrenceId, date, title: override.title, ...fields }
}

/** The event a calendar note holds for an entry with this model. */
export function eventFromModel(model: EventModel, context: EventNoteContext): CalendarEvent {
  const { fields, date, instants } = writeOccurrence(model, context)
  const event: CalendarEvent = { id: localIdForUid(model.uid), date, title: model.title }
  if (instants) {
    event.allDay = false
    event.start = isoInstant(instants.startMs)
    event.localOf = [Math.floor(instants.startMs / 1000)]
    if (instants.endMs !== undefined) {
      event.end = isoInstant(instants.endMs)
      event.localOf.push(Math.floor(instants.endMs / 1000))
    }
  }
  Object.assign(event, fields)

  const isPlainSeries = model.exdates.length === 0 && model.rdates.length === 0 && model.overrides.length === 0
  const simple = isPlainSeries ? simpleRecurrenceOf(model.rule) : undefined
  if (simple) {
    event.recurrence = simple
  } else if (model.rule.length > 0) {
    event.rrule = model.rule
  }
  // Sorted here as well as where a model is made: the text of the note must not depend on the order
  // in which a server happened to list the parts of a series.
  if (model.exdates.length > 0) {
    event.exdates = [...model.exdates].sort()
  }
  if (model.rdates.length > 0) {
    event.rdates = [...model.rdates].sort()
  }
  if (model.overrides.length > 0) {
    event.overrides = [...model.overrides]
      .sort((a, b) => (a.recurrenceId < b.recurrenceId ? -1 : a.recurrenceId > b.recurrenceId ? 1 : 0))
      .map((override) => writeOverride(override, context))
  }
  if (model.guests) {
    event.guests = true
  }
  if (model.alarm) {
    event.alarm = true
  }
  return event
}

type Read = Pick<OccurrenceModel, 'start' | 'end'>

const timeIn = (zone: string, floating: boolean, value: string): ModelTime => {
  if (floating) {
    return { kind: 'floating', value }
  }
  return zone === 'UTC' ? { kind: 'utc', value } : { kind: 'zoned', value, zone }
}

/** The start and end an event or a changed occurrence states, from its version 2 keys. */
function readTimes(fields: CalendarOccurrenceFields, date: string): Read {
  if (fields.zone && fields.localStart) {
    const floating = fields.floating === true
    const times: Read = { start: timeIn(fields.zone, floating, fields.localStart) }
    if (fields.localEnd) {
      times.end = timeIn(fields.endZone ?? fields.zone, floating && fields.endZone === undefined, fields.localEnd)
    }
    return times
  }
  const times: Read = { start: { kind: 'date', value: date } }
  if (fields.days && fields.days >= 2) {
    times.end = { kind: 'date', value: addDays(date, fields.days) }
  }
  return times
}

const readOccurrence = (fields: CalendarOccurrenceFields, date: string, title: string): OccurrenceModel => ({
  title,
  description: fields.description ?? '',
  location: fields.location ?? '',
  clipped: fields.clipped ?? '',
  status: fields.status ?? '',
  ...readTimes(fields, date),
})

/**
 * The model of an event as a calendar note holds it. `uid` is not something the
 * event knows (its id is a digest of it); a fingerprint does not cover it.
 *
 * An event with a time but no zone of its own was made by the version 1 editor,
 * which only has instants. It is modelled as that instant in UTC, which is the
 * one reading of it that does not depend on the device.
 */
export function modelFromEvent(event: CalendarEvent, uid = ''): EventModel {
  let occurrence: OccurrenceModel
  if (event.allDay === false && event.start && !(event.zone && event.localStart)) {
    occurrence = {
      ...readOccurrence({ ...event, days: undefined }, event.date, event.title),
      start: { kind: 'utc', value: event.start.slice(0, 19) },
    }
    if (event.end) {
      occurrence.end = { kind: 'utc', value: event.end.slice(0, 19) }
    }
  } else {
    occurrence = readOccurrence(event, event.date, event.title)
  }
  return {
    ...occurrence,
    uid,
    rule: event.recurrence ? ruleOfSimpleRecurrence(event.recurrence) : (event.rrule ?? ''),
    exdates: [...(event.exdates ?? [])].sort(),
    rdates: [...(event.rdates ?? [])].sort(),
    overrides: (event.overrides ?? []).map((override) => ({
      ...readOccurrence(override, override.date, override.title),
      recurrenceId: override.rid,
    })),
    guests: event.guests === true,
    alarm: event.alarm === true,
  }
}
