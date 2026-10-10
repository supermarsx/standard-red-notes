/**
 * Standard Red Notes: minimal, dependency-free iCalendar (RFC 5545) serializer
 * for the read-only CalDAV todo feed.
 *
 * It emits a VCALENDAR containing VTODO components for the user's EXPLICITLY
 * published reminders/todos. Only the small, plaintext "published calendar"
 * fields are serialized here — never any end-to-end-encrypted note content.
 *
 * Two component types are emitted, into two SEPARATE collections:
 *   - VTODO, the task itself, which is what a task client wants; and
 *   - VEVENT, an opt-in projection of the task's DUE DATE onto the calendar grid
 *     (see `CalendarProjection.ts`), because VTODO is not drawn by calendar
 *     clients — Google Calendar ignores it and Apple routes it to Reminders.
 *
 * RFC 4791 §4.1 requires one component type per calendar object resource, so the
 * two never share a resource; the DAV router serves them from `.../todos/` and
 * `.../events/` respectively. VALARM appears only inside a projected VEVENT and
 * only when the user asked for one.
 */

import {
  CalendarProjectionSettings,
  ProjectedEvent,
  projectTodosToEvents,
  PublishedTodoRecurrence,
} from './CalendarProjection'

export interface PublishedTodo {
  /** Stable per-item identifier; becomes the VTODO UID and the object href. */
  uid: string
  /** Short title shown in the client. */
  summary: string
  /** Optional longer description. */
  description?: string
  /** Optional due date/time (ISO 8601). Emitted as DUE. */
  due?: string
  /** Optional start date/time (ISO 8601). Emitted as DTSTART. */
  start?: string
  /** Whether the todo is completed. Maps to STATUS + PERCENT-COMPLETE. */
  completed?: boolean
  /** Optional completion timestamp (ISO 8601). Emitted as COMPLETED. */
  completedAt?: string
  /** Optional 0 (unspecified), 1 (high) – 9 (low) priority. */
  priority?: number
  /**
   * Free-form labels, emitted as CATEGORIES on both components. The publishing
   * client fills these from the source note's tags, which is what lets a
   * calendar client colour or filter the projected events.
   */
  categories?: string[]
  /**
   * Optional repeat rule. Emitted as RRULE on the projected VEVENT; VTODO stays
   * single-instance because the editor's model always represents the NEXT active
   * occurrence of a repeating task, which is the only one a task client should
   * see as outstanding.
   */
  recurrence?: PublishedTodoRecurrence
  /** ms-epoch of creation; emitted as CREATED. */
  createdAt?: number
  /** ms-epoch of last change; drives DTSTAMP / LAST-MODIFIED + the ETag. */
  updatedAt?: number
}

const PRODID = '-//Standard Red Notes//CalDAV Todo Feed//EN'
const EVENT_PRODID = '-//Standard Red Notes//CalDAV Due Date Feed//EN'

/**
 * Escape a TEXT value per RFC 5545 §3.3.11: backslash, semicolon, comma and
 * newlines must be escaped. CR/LF collapse to the literal "\n".
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Format an ISO 8601 string (or ms-epoch number) as a UTC iCalendar
 * date-time: YYYYMMDDTHHMMSSZ. Returns null when the input is unparseable so
 * the caller can omit the property rather than emit a malformed line.
 */
export function toICalDateTimeUTC(value: string | number | undefined): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const pad = (n: number, width = 2): string => `${n}`.padStart(width, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

function toICalDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

/**
 * Fold a content line to <=75 octets per RFC 5545 §3.1 by inserting CRLF +
 * single space continuations. Folding on octet boundaries keeps multi-byte
 * UTF-8 sequences intact.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) {
    return line
  }
  const pieces: Buffer[] = []
  let offset = 0
  // First line: 75 octets. Continuation lines: 74 octets (1 reserved for the
  // leading space). Never split inside a UTF-8 multi-byte sequence.
  let limit = 75
  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length)
    // Walk back so we don't cut a continuation byte (0b10xxxxxx) in half.
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end--
    }
    pieces.push(bytes.subarray(offset, end))
    offset = end
    limit = 74
  }
  return pieces.map((piece, index) => (index === 0 ? '' : ' ') + piece.toString('utf8')).join('\r\n')
}

function line(name: string, value: string): string {
  return foldLine(`${name}:${value}`)
}

/**
 * CATEGORIES is a COMMA-separated list of TEXT values (RFC 5545 §3.8.1.2), so
 * each value is escaped individually — including its own commas — and the
 * separators stay unescaped. Escaping the joined string instead would collapse
 * the list into one category.
 */
function categoriesLine(categories: readonly string[]): string | undefined {
  const values = categories.map((category) => category.trim()).filter((category) => category.length > 0)
  return values.length === 0 ? undefined : line('CATEGORIES', values.map(escapeText).join(','))
}

/**
 * Serialize a single published todo as a VTODO component (without the enclosing
 * VCALENDAR). `dtstamp` is the generation time used for DTSTAMP when the item
 * carries no updatedAt.
 */
export function serializeVTodo(todo: PublishedTodo): string {
  const lines: string[] = ['BEGIN:VTODO']

  lines.push(line('UID', escapeText(todo.uid)))

  // Legacy rows may lack timestamps. A fixed fallback keeps the representation
  // stable across requests so strong ETags remain truthful.
  const stamp = toICalDateTimeUTC(todo.updatedAt ?? todo.createdAt ?? 0) as string
  lines.push(line('DTSTAMP', stamp))

  if (todo.createdAt !== undefined) {
    const created = toICalDateTimeUTC(todo.createdAt)
    if (created) {
      lines.push(line('CREATED', created))
    }
  }
  if (todo.updatedAt !== undefined) {
    const modified = toICalDateTimeUTC(todo.updatedAt)
    if (modified) {
      lines.push(line('LAST-MODIFIED', modified))
    }
  }

  lines.push(line('SUMMARY', escapeText(todo.summary ?? '')))

  if (todo.description) {
    lines.push(line('DESCRIPTION', escapeText(todo.description)))
  }

  if (todo.start) {
    const startDate = toICalDate(todo.start)
    const startDateTime = toICalDateTimeUTC(todo.start)
    if (startDate) {
      lines.push(line('DTSTART;VALUE=DATE', startDate))
    } else if (startDateTime) {
      lines.push(line('DTSTART', startDateTime))
    }
  }

  if (todo.due) {
    const dueDate = toICalDate(todo.due)
    const dueDateTime = toICalDateTimeUTC(todo.due)
    if (dueDate) {
      lines.push(line('DUE;VALUE=DATE', dueDate))
    } else if (dueDateTime) {
      lines.push(line('DUE', dueDateTime))
    }
  }

  if (todo.priority !== undefined && Number.isFinite(todo.priority)) {
    const clamped = Math.min(9, Math.max(0, Math.round(todo.priority)))
    lines.push(line('PRIORITY', `${clamped}`))
  }

  if (todo.categories !== undefined) {
    const categories = categoriesLine(todo.categories)
    if (categories) {
      lines.push(categories)
    }
  }

  if (todo.completed) {
    lines.push(line('STATUS', 'COMPLETED'))
    lines.push(line('PERCENT-COMPLETE', '100'))
    const completedAt = toICalDateTimeUTC(todo.completedAt ?? todo.updatedAt ?? todo.createdAt ?? 0)
    if (completedAt) {
      lines.push(line('COMPLETED', completedAt))
    }
  } else {
    lines.push(line('STATUS', 'NEEDS-ACTION'))
  }

  lines.push('END:VTODO')
  return lines.join('\r\n')
}

/**
 * Serialize a full VCALENDAR wrapping the given todos. Passing a single todo
 * produces the per-object body served by GET / calendar-multiget; passing all
 * of them produces the collection body served by a calendar-query REPORT.
 */
export function serializeCalendar(todos: PublishedTodo[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    line('VERSION', '2.0'),
    line('PRODID', PRODID),
    line('CALSCALE', 'GREGORIAN'),
  ]
  for (const todo of [...todos].sort((left, right) => left.uid.localeCompare(right.uid))) {
    lines.push(serializeVTodo(todo))
  }
  lines.push('END:VCALENDAR')
  // RFC 5545 requires CRLF line endings and a trailing CRLF.
  return lines.join('\r\n') + '\r\n'
}

/** `YYYYMMDD` for an all-day DATE value. */
function toICalDateCompact(value: string): string | null {
  return toICalDate(value)
}

/**
 * Render a VALARM lead time as an RFC 5545 DURATION.
 *
 * A zero lead is `PT0S` with no sign: `-PT0S` is legal but several clients read
 * the sign before the magnitude and schedule it a day out.
 */
export function alarmTriggerDuration(leadMinutes: number): string {
  if (!Number.isFinite(leadMinutes) || leadMinutes <= 0) {
    return 'PT0S'
  }
  const total = Math.round(leadMinutes)
  const days = Math.floor(total / 1_440)
  const hours = Math.floor((total % 1_440) / 60)
  const minutes = total % 60
  const dayPart = days > 0 ? `${days}D` : ''
  const timeParts = `${hours > 0 ? `${hours}H` : ''}${minutes > 0 ? `${minutes}M` : ''}`
  return `-P${dayPart}${timeParts.length > 0 ? `T${timeParts}` : ''}`
}

/**
 * Serialize one projected due date as a VEVENT component (without the enclosing
 * VCALENDAR).
 *
 * The UID is the projection's own (`srn-due-…`), never the task's: the event and
 * the task are two calendar objects describing the same work, and a client that
 * merges both collections by UID must not fuse them into one.
 */
export function serializeVEvent(event: ProjectedEvent): string {
  const lines: string[] = ['BEGIN:VEVENT']

  lines.push(line('UID', escapeText(event.uid)))
  const stamp = toICalDateTimeUTC(event.updatedAt ?? event.createdAt ?? 0) as string
  lines.push(line('DTSTAMP', stamp))

  if (event.createdAt !== undefined) {
    const created = toICalDateTimeUTC(event.createdAt)
    if (created) {
      lines.push(line('CREATED', created))
    }
  }
  if (event.updatedAt !== undefined) {
    const modified = toICalDateTimeUTC(event.updatedAt)
    if (modified) {
      lines.push(line('LAST-MODIFIED', modified))
    }
  }

  lines.push(line('SUMMARY', escapeText(event.summary)))
  if (event.description) {
    lines.push(line('DESCRIPTION', escapeText(event.description)))
  }

  if (event.allDay) {
    const start = event.startDate ? toICalDateCompact(event.startDate) : null
    const end = event.endDate ? toICalDateCompact(event.endDate) : null
    if (!start || !end) {
      // Unreachable from projectTodoToEvent, which derives both dates from the
      // same validated instant; a malformed pair is dropped rather than folded
      // into a VEVENT with no start.
      return ''
    }
    lines.push(line('DTSTART;VALUE=DATE', start))
    lines.push(line('DTEND;VALUE=DATE', end))
  } else {
    const start = toICalDateTimeUTC(event.startAt)
    const end = toICalDateTimeUTC(event.endAt)
    if (!start || !end) {
      return ''
    }
    lines.push(line('DTSTART', start))
    lines.push(line('DTEND', end))
  }

  if (event.rrule) {
    lines.push(line('RRULE', event.rrule))
  }
  if (event.recurrenceTimeZone) {
    // The editor anchors a repeat to a wall time in this zone while DTSTART is
    // UTC; see recurrenceToRRule for the DST consequence. Carrying the zone in
    // the feed keeps that difference diagnosable from a client's own export.
    lines.push(line('X-SRN-TZID', escapeText(event.recurrenceTimeZone)))
  }

  if (event.categories !== undefined) {
    const categories = categoriesLine(event.categories)
    if (categories) {
      lines.push(categories)
    }
  }

  if (event.priority !== undefined && Number.isFinite(event.priority)) {
    lines.push(line('PRIORITY', `${Math.min(9, Math.max(0, Math.round(event.priority)))}`))
  }

  if (event.cancelled) {
    // A finished deadline still occupies its slot in history, but it must not
    // make the user look busy: CANCELLED is what clients render struck through,
    // and TRANSPARENT keeps it out of free/busy.
    lines.push(line('STATUS', 'CANCELLED'))
    lines.push(line('TRANSP', 'TRANSPARENT'))
  } else {
    lines.push(line('STATUS', 'CONFIRMED'))
  }

  if (event.alarmLeadMinutes !== undefined) {
    lines.push('BEGIN:VALARM')
    lines.push(line('ACTION', 'DISPLAY'))
    lines.push(line('DESCRIPTION', escapeText(event.summary)))
    const duration = alarmTriggerDuration(event.alarmLeadMinutes)
    lines.push(
      event.alarmRelatedToEnd ? line('TRIGGER;RELATED=END', duration) : line('TRIGGER;VALUE=DURATION', duration),
    )
    lines.push('END:VALARM')
  }

  lines.push('END:VEVENT')
  return lines.join('\r\n')
}

/**
 * Serialize a VCALENDAR of projected due-date events. An empty projection still
 * produces a valid, empty VCALENDAR so a subscribed client sees "nothing due"
 * rather than a broken collection.
 */
export function serializeEventCalendar(events: readonly ProjectedEvent[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    line('VERSION', '2.0'),
    line('PRODID', EVENT_PRODID),
    line('CALSCALE', 'GREGORIAN'),
  ]
  for (const event of [...events].sort((left, right) => left.uid.localeCompare(right.uid))) {
    const component = serializeVEvent(event)
    if (component.length > 0) {
      lines.push(component)
    }
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

/** Project then serialize, the form the DAV router uses. */
export function serializeProjectedEventCalendar(
  todos: readonly PublishedTodo[],
  settings: CalendarProjectionSettings,
): string {
  return serializeEventCalendar(projectTodosToEvents(todos, settings))
}
