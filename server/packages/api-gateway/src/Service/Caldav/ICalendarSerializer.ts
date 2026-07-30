/**
 * Standard Red Notes: minimal, dependency-free iCalendar (RFC 5545) serializer
 * for the read-only CalDAV todo feed.
 *
 * It emits a VCALENDAR containing VTODO components for the user's EXPLICITLY
 * published reminders/todos. Only the small, plaintext "published calendar"
 * fields are serialized here — never any end-to-end-encrypted note content.
 *
 * This implementation intentionally exposes VTODO only (todos/reminders).
 * VEVENT and VALARM are not advertised by the server.
 */

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
  /** ms-epoch of creation; emitted as CREATED. */
  createdAt?: number
  /** ms-epoch of last change; drives DTSTAMP / LAST-MODIFIED + the ETag. */
  updatedAt?: number
}

const PRODID = '-//Standard Red Notes//CalDAV Todo Feed//EN'

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
