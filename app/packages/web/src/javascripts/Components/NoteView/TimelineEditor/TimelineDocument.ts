/**
 * Timeline / waterfall note document model (full-note editor).
 *
 * A Timeline note stores a flat list of items, each with a label and a start/end
 * date. The editor renders a Gantt-like waterfall: it computes the overall
 * min-start / max-end span and positions each item's bar by its start..end
 * proportion of that span.
 *
 * A sibling agent builds a Super *block* with the same idea — that is a separate
 * surface; this is the full-note editor.
 *
 * Exactly like the Canvas, Base, Sandbox, Calendar, and Kanban note types, the
 * serialized document is stored verbatim in `note.text` (the same slot Super
 * stores its Lexical JSON in). This keeps a Timeline note round-tripping and
 * syncing like any other note with no models/snjs changes — the note is marked
 * as a timeline purely via `note.editorIdentifier`.
 */

export const TIMELINE_DOCUMENT_VERSION = 1

export type TimelineItem = {
  id: string
  label: string
  /** ISO date string (YYYY-MM-DD) for the item's start. */
  start: string
  /** ISO date string (YYYY-MM-DD) for the item's end. */
  end: string
  /** Optional CSS color string for the bar. */
  color?: string
}

export type TimelineDocument = {
  version: number
  title: string
  items: TimelineItem[]
}

export const createEmptyTimelineDocument = (): TimelineDocument => ({
  version: TIMELINE_DOCUMENT_VERSION,
  title: '',
  items: [],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Normalize a candidate date string to YYYY-MM-DD. Accepts full ISO strings and
 * date-only strings. Returns null for anything unparseable.
 */
export const normalizeTimelineDate = (value: unknown): string | null => {
  if (!isString(value) || value.trim().length === 0) {
    return null
  }
  const trimmed = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`
    }
    return null
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear().toString().padStart(4, '0')
  const month = (parsed.getMonth() + 1).toString().padStart(2, '0')
  const day = parsed.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

const sanitizeItem = (raw: unknown): TimelineItem | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }
  const start = normalizeTimelineDate(candidate.start)
  if (!start) {
    return null
  }
  // End defaults to start when missing/invalid (a single-day item).
  const end = normalizeTimelineDate(candidate.end) ?? start
  // Always keep start <= end so bar math never goes negative.
  const orderedStart = start <= end ? start : end
  const orderedEnd = start <= end ? end : start
  return {
    id: candidate.id,
    label: isString(candidate.label) ? candidate.label : '',
    start: orderedStart,
    end: orderedEnd,
    color: isString(candidate.color) ? candidate.color : undefined,
  }
}

/**
 * Parse note text into a TimelineDocument. Never throws: empty, legacy plain
 * text, or otherwise malformed JSON all fall back to an empty timeline. The
 * second return value reports whether the input was recoverable timeline JSON so
 * the editor can surface a non-destructive notice when content was discarded.
 */
export const parseTimelineDocument = (
  text: string | undefined | null,
): { document: TimelineDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyTimelineDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyTimelineDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyTimelineDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A timeline document must at least expose an items array; otherwise it is
  // probably some other note format being switched into Timeline, so treat it as
  // a fresh timeline but flag it as not-recovered.
  const looksLikeTimeline = Array.isArray(candidate.items)
  if (!looksLikeTimeline) {
    return { document: createEmptyTimelineDocument(), recovered: false }
  }

  const items: TimelineItem[] = []
  const seenIds = new Set<string>()
  for (const rawItem of candidate.items as unknown[]) {
    const item = sanitizeItem(rawItem)
    if (item && !seenIds.has(item.id)) {
      seenIds.add(item.id)
      items.push(item)
    }
  }

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : TIMELINE_DOCUMENT_VERSION,
      title: isString(candidate.title) ? candidate.title : '',
      items,
    },
    recovered: true,
  }
}

/** Serialize a TimelineDocument to the string stored in `note.text`. */
export const serializeTimelineDocument = (document: TimelineDocument): string => {
  return JSON.stringify({
    version: document.version ?? TIMELINE_DOCUMENT_VERSION,
    title: document.title ?? '',
    items: document.items,
  })
}

// ---------------------------------------------------------------------------
// Pure waterfall/Gantt bar-layout math.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Parse a YYYY-MM-DD into an epoch ms at local midnight (NaN if invalid). */
const dateToMs = (iso: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) {
    return NaN
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
}

export type TimelineBar = {
  id: string
  /** Left edge as a fraction [0,1] of the overall span. */
  offset: number
  /** Bar width as a fraction (0,1] of the overall span. */
  width: number
}

export type TimelineLayout = {
  /** Earliest start ISO date across all items, or null when empty. */
  minDate: string | null
  /** Latest end ISO date across all items, or null when empty. */
  maxDate: string | null
  /** Total span in whole days (>= 1 when there is at least one item). */
  spanDays: number
  bars: TimelineBar[]
}

/**
 * Compute the waterfall layout for a set of items.
 *
 * - minDate = earliest start, maxDate = latest end.
 * - spanDays = (maxDate - minDate) in days, clamped to a minimum of 1 so a
 *   single same-day item still gets a visible bar and we never divide by zero.
 * - Each bar's `offset` is (item.start - minDate) / span and its `width` is
 *   max(item.end - item.start, 1 day) / span, clamped so offset+width <= 1.
 *
 * Items are processed in the given order; invalid dates are skipped (they were
 * already normalized at parse time, but this stays defensive).
 */
export const computeTimelineLayout = (items: TimelineItem[]): TimelineLayout => {
  let minMs = Infinity
  let maxMs = -Infinity
  let minIso: string | null = null
  let maxIso: string | null = null

  for (const item of items) {
    const startMs = dateToMs(item.start)
    const endMs = dateToMs(item.end)
    if (!Number.isNaN(startMs) && startMs < minMs) {
      minMs = startMs
      minIso = item.start
    }
    if (!Number.isNaN(endMs) && endMs > maxMs) {
      maxMs = endMs
      maxIso = item.end
    }
  }

  if (minIso === null || maxIso === null || !Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return { minDate: null, maxDate: null, spanDays: 0, bars: [] }
  }

  // Inclusive span: a same-day item spans 1 day. Round to whole days.
  const rawSpanDays = Math.round((maxMs - minMs) / MS_PER_DAY)
  const spanDays = Math.max(rawSpanDays, 1)
  const spanMs = spanDays * MS_PER_DAY

  const bars: TimelineBar[] = []
  for (const item of items) {
    const startMs = dateToMs(item.start)
    const endMs = dateToMs(item.end)
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      continue
    }
    const rawOffset = (startMs - minMs) / spanMs
    // Ensure a minimum visible width of one day's fraction.
    const durationMs = Math.max(endMs - startMs, MS_PER_DAY)
    let width = durationMs / spanMs
    let offset = Math.min(Math.max(rawOffset, 0), 1)
    if (offset + width > 1) {
      width = 1 - offset
    }
    bars.push({ id: item.id, offset, width })
  }

  return { minDate: minIso, maxDate: maxIso, spanDays, bars }
}

let idCounter = 0
/** Lightweight unique id generator for items (no crypto dependency). */
export const createTimelineId = (prefix: string): string => {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
