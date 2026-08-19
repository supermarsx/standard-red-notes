import { normalizeChecklistDueAt } from './checklistDueDate'

export const CHECKLIST_RECURRENCE_MAX_INTERVAL = 999
export const CHECKLIST_RECURRENCE_VERSION = 1
export const CHECKLIST_RECURRENCE_MAX_CACHED_FORMATTERS = 64
export const CHECKLIST_RECURRENCE_MAX_FALLBACK_TIME_ZONES = 128

export type ChecklistRecurrenceUnit = 'day' | 'week' | 'month' | 'year'
export type ChecklistRecurrenceFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'custom'

export type ChecklistRecurrenceAnchor = {
  timeZone: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

export type ChecklistRecurrence =
  | {
      version: typeof CHECKLIST_RECURRENCE_VERSION
      frequency: Exclude<ChecklistRecurrenceFrequency, 'custom'>
      anchor: ChecklistRecurrenceAnchor
    }
  | {
      version: typeof CHECKLIST_RECURRENCE_VERSION
      frequency: 'custom'
      interval: number
      unit: ChecklistRecurrenceUnit
      anchor: ChecklistRecurrenceAnchor
    }

export type ChecklistRecurrenceChoice =
  | Exclude<ChecklistRecurrenceFrequency, 'custom'>
  | { frequency: 'custom'; interval: number; unit: ChecklistRecurrenceUnit }

type LocalDateTime = Omit<ChecklistRecurrenceAnchor, 'timeZone'>

const MAX_YEAR = 9999
const MAX_OCCURRENCE_STEPS = 10_000_000
const DAY_MS = 86_400_000
const formatterCache = new Map<string, Intl.DateTimeFormat>()
const fallbackTimeZoneCache = new Map<string, string>()
const invalidTimeZoneCache = new Set<string>()
let fallbackTimeZoneAttempts = 0
let supportedTimeZoneCache: ReadonlyMap<string, string> | undefined

type IntlWithSupportedValuesOf = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[]
}

function integerInRange(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function normalizeChecklistRecurrenceTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return undefined
  }
  if (supportedTimeZone(value) || fallbackTimeZoneCache.has(value)) {
    // Preserve the exact persisted spelling; only the private formatter key is
    // canonicalized so save/load does not churn user data.
    return value
  }
  if (invalidTimeZoneCache.has(value)) {
    return undefined
  }
  if (fallbackTimeZoneAttempts >= CHECKLIST_RECURRENCE_MAX_FALLBACK_TIME_ZONES) {
    return undefined
  }
  fallbackTimeZoneAttempts += 1
  try {
    const probe = new Intl.DateTimeFormat('en-US', { timeZone: value })
    const canonical = probe.resolvedOptions().timeZone
    if (!canonical) {
      invalidTimeZoneCache.add(value)
      return undefined
    }
    fallbackTimeZoneCache.set(value, canonical)
    return value
  } catch {
    invalidTimeZoneCache.add(value)
    return undefined
  }
}

function supportedTimeZone(value: string): string | undefined {
  if (!supportedTimeZoneCache) {
    const supported = new Map<string, string>([['utc', 'UTC']])
    try {
      const values = (Intl as IntlWithSupportedValuesOf).supportedValuesOf?.('timeZone') ?? []
      for (const timeZone of values) {
        supported.set(timeZone.toLowerCase(), timeZone)
      }
    } catch {
      // Older/partial Intl implementations use the bounded validation fallback.
    }
    supportedTimeZoneCache = supported
  }
  return supportedTimeZoneCache.get(value.toLowerCase())
}

function canonicalTimeZone(value: string): string | undefined {
  return supportedTimeZone(value) ?? fallbackTimeZoneCache.get(value)
}

function normalizeAnchor(value: unknown): ChecklistRecurrenceAnchor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const anchor = value as Record<string, unknown>
  const timeZone = normalizeChecklistRecurrenceTimeZone(anchor.timeZone)
  const year = integerInRange(anchor.year, 1970, MAX_YEAR)
  const month = integerInRange(anchor.month, 1, 12)
  const hour = integerInRange(anchor.hour, 0, 23)
  const minute = integerInRange(anchor.minute, 0, 59)
  const second = integerInRange(anchor.second, 0, 59)
  const millisecond = integerInRange(anchor.millisecond, 0, 999)
  if (
    !timeZone ||
    year === undefined ||
    month === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    millisecond === undefined
  ) {
    return undefined
  }
  const day = integerInRange(anchor.day, 1, daysInMonth(year, month))
  if (day === undefined) {
    return undefined
  }
  return { timeZone, year, month, day, hour, minute, second, millisecond }
}

export function normalizeChecklistRecurrence(value: unknown): ChecklistRecurrence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const rule = value as Record<string, unknown>
  if (rule.version !== undefined && rule.version !== CHECKLIST_RECURRENCE_VERSION) {
    return undefined
  }
  const anchor = normalizeAnchor(rule.anchor)
  if (!anchor || typeof rule.frequency !== 'string') {
    return undefined
  }
  if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(rule.frequency)) {
    return {
      version: CHECKLIST_RECURRENCE_VERSION,
      frequency: rule.frequency as Exclude<ChecklistRecurrenceFrequency, 'custom'>,
      anchor,
    }
  }
  if (rule.frequency !== 'custom') {
    return undefined
  }
  const interval = integerInRange(rule.interval, 1, CHECKLIST_RECURRENCE_MAX_INTERVAL)
  if (!interval || !['day', 'week', 'month', 'year'].includes(String(rule.unit))) {
    return undefined
  }
  return {
    version: CHECKLIST_RECURRENCE_VERSION,
    frequency: 'custom',
    interval,
    unit: rule.unit as ChecklistRecurrenceUnit,
    anchor,
  }
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const canonical = canonicalTimeZone(timeZone)
  if (!canonical) {
    throw new RangeError(`Unsupported time zone: ${timeZone}`)
  }
  let cached = formatterCache.get(canonical)
  if (cached) {
    formatterCache.delete(canonical)
    formatterCache.set(canonical, cached)
    return cached
  }
  cached = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: canonical,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  if (formatterCache.size >= CHECKLIST_RECURRENCE_MAX_CACHED_FORMATTERS) {
    const oldest = formatterCache.keys().next()
    if (!oldest.done) {
      formatterCache.delete(oldest.value)
    }
  }
  formatterCache.set(canonical, cached)
  return cached
}

function zonedParts(timestamp: number, timeZone: string): LocalDateTime | undefined {
  if (!Number.isFinite(timestamp)) {
    return undefined
  }
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(timestamp))) {
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) {
      values[part.type] = Number(part.value)
    }
  }
  const year = values.year
  const month = values.month
  const day = values.day
  const hour = values.hour
  const minute = values.minute
  const second = values.second
  if ([year, month, day, hour, minute, second].some((part) => part === undefined || !Number.isFinite(part))) {
    return undefined
  }
  return {
    year: year as number,
    month: month as number,
    day: day as number,
    hour: hour as number,
    minute: minute as number,
    second: second as number,
    millisecond: new Date(timestamp).getUTCMilliseconds(),
  }
}

function sameLocalDateTime(first: LocalDateTime, second: LocalDateTime): boolean {
  return (
    first.year === second.year &&
    first.month === second.month &&
    first.day === second.day &&
    first.hour === second.hour &&
    first.minute === second.minute &&
    first.second === second.second &&
    first.millisecond === second.millisecond
  )
}

function pseudoUtc(parts: LocalDateTime): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond)
}

function offsetAt(timestamp: number, timeZone: string): number | undefined {
  const parts = zonedParts(timestamp, timeZone)
  if (!parts) {
    return undefined
  }
  return pseudoUtc(parts) - timestamp
}

/** Resolve a local wall time without relying on the host process time zone. */
function instantForLocal(parts: LocalDateTime, timeZone: string): number | undefined {
  const desired = pseudoUtc(parts)
  if (!Number.isFinite(desired) || parts.year < 1970 || parts.year > MAX_YEAR) {
    return undefined
  }
  const offsets = new Set<number>()
  for (const delta of [-2 * DAY_MS, -DAY_MS, 0, DAY_MS, 2 * DAY_MS]) {
    const offset = offsetAt(desired + delta, timeZone)
    if (offset !== undefined) {
      offsets.add(offset)
    }
  }
  const candidates = [...offsets]
    .map((offset) => desired - offset)
    .filter((candidate) => Number.isFinite(candidate))
    .sort((first, second) => first - second)
  for (const candidate of candidates) {
    const projected = zonedParts(candidate, timeZone)
    if (projected && sameLocalDateTime(projected, parts)) {
      // A repeated wall time during the autumn transition has two instants.
      // Choosing the earlier one is stable on every device.
      return candidate
    }
  }

  // A spring-forward gap has no exact instant. Preserve minutes/seconds by
  // choosing the closest offset-derived wall time after the requested one.
  const after = candidates
    .map((candidate) => ({ candidate, projected: zonedParts(candidate, timeZone) }))
    .filter(
      (entry): entry is { candidate: number; projected: LocalDateTime } =>
        Boolean(entry.projected) && pseudoUtc(entry.projected as LocalDateTime) > desired,
    )
    .sort(
      (first, second) =>
        pseudoUtc(first.projected) - desired - (pseudoUtc(second.projected) - desired) ||
        first.candidate - second.candidate,
    )
  return after[0]?.candidate
}

export function createChecklistRecurrence(
  choice: ChecklistRecurrenceChoice,
  dueAt: string,
  requestedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ChecklistRecurrence | undefined {
  const normalizedDueAt = normalizeChecklistDueAt(dueAt)
  const dueTimestamp = normalizedDueAt ? Date.parse(normalizedDueAt) : Number.NaN
  const timeZone = normalizeChecklistRecurrenceTimeZone(requestedTimeZone)
  if (!Number.isFinite(dueTimestamp) || !timeZone) {
    return undefined
  }
  const local = zonedParts(dueTimestamp, timeZone)
  if (!local || local.year < 1970 || local.year > MAX_YEAR) {
    return undefined
  }
  const anchor: ChecklistRecurrenceAnchor = {
    ...local,
    timeZone,
  }
  if (typeof choice === 'string') {
    return normalizeChecklistRecurrence({ frequency: choice, anchor })
  }
  return normalizeChecklistRecurrence({ ...choice, anchor })
}

function addDays(parts: LocalDateTime, days: number): LocalDateTime | undefined {
  if (!Number.isSafeInteger(days)) {
    return undefined
  }
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  const year = date.getUTCFullYear()
  if (year < 1970 || year > MAX_YEAR) {
    return undefined
  }
  return { ...parts, year, month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function addWeekdays(parts: LocalDateTime, weekdays: number): LocalDateTime | undefined {
  if (!Number.isSafeInteger(weekdays) || weekdays < 1) {
    return undefined
  }
  let current = parts
  let remaining = weekdays
  let weekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay()

  if (weekday === 0 || weekday === 6) {
    const monday = addDays(current, weekday === 6 ? 2 : 1)
    if (!monday) {
      return undefined
    }
    current = monday
    remaining -= 1
    if (remaining === 0) {
      return current
    }
  }

  const fullWeeks = Math.floor(remaining / 5)
  if (fullWeeks > 0) {
    const jumped = addDays(current, fullWeeks * 7)
    if (!jumped) {
      return undefined
    }
    current = jumped
    remaining -= fullWeeks * 5
  }
  while (remaining > 0) {
    const next = addDays(current, 1)
    if (!next) {
      return undefined
    }
    current = next
    weekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay()
    if (weekday >= 1 && weekday <= 5) {
      remaining -= 1
    }
  }
  return current
}

function occurrenceLocalParts(
  current: LocalDateTime,
  rule: ChecklistRecurrence,
  steps: number,
): LocalDateTime | undefined {
  const anchor = rule.anchor
  const withAnchorTime = (parts: LocalDateTime): LocalDateTime => ({
    ...parts,
    hour: anchor.hour,
    minute: anchor.minute,
    second: anchor.second,
    millisecond: anchor.millisecond,
  })
  const frequency = rule.frequency
  if (frequency === 'weekdays') {
    const result = addWeekdays(current, steps)
    return result ? withAnchorTime(result) : undefined
  }
  let unit: ChecklistRecurrenceUnit
  let interval = 1
  switch (frequency) {
    case 'daily':
      unit = 'day'
      break
    case 'weekly':
      unit = 'week'
      break
    case 'monthly':
      unit = 'month'
      break
    case 'yearly':
      unit = 'year'
      break
    case 'custom':
      unit = rule.unit
      interval = rule.interval
      break
  }
  const total = steps * interval
  if (!Number.isSafeInteger(total)) {
    return undefined
  }
  if (unit === 'day' || unit === 'week') {
    const result = addDays(current, total * (unit === 'week' ? 7 : 1))
    return result ? withAnchorTime(result) : undefined
  }
  if (unit === 'month') {
    const monthIndex = current.year * 12 + (current.month - 1) + total
    const year = Math.floor(monthIndex / 12)
    const month = (monthIndex % 12) + 1
    if (year < 1970 || year > MAX_YEAR) {
      return undefined
    }
    const lastDay = daysInMonth(year, month)
    return withAnchorTime({
      ...current,
      year,
      month,
      day: Math.min(anchor.day, lastDay),
    })
  }
  const year = current.year + total
  if (year < 1970 || year > MAX_YEAR) {
    return undefined
  }
  const lastDay = daysInMonth(year, anchor.month)
  return withAnchorTime({
    ...current,
    year,
    month: anchor.month,
    day: Math.min(anchor.day, lastDay),
  })
}

/**
 * Return the first scheduled occurrence strictly after both the current due
 * instant and completion time. The binary search bounds even extremely stale
 * tasks without replaying years of individual occurrences.
 */
export function advanceChecklistDueAt(
  dueAt: string,
  value: ChecklistRecurrence,
  completedAt = Date.now(),
): string | undefined {
  const rule = normalizeChecklistRecurrence(value)
  const normalizedDueAt = normalizeChecklistDueAt(dueAt)
  const dueTimestamp = normalizedDueAt ? Date.parse(normalizedDueAt) : Number.NaN
  if (!rule || !Number.isFinite(dueTimestamp) || !Number.isFinite(completedAt)) {
    return undefined
  }
  const { timeZone: _timeZone, ...anchorLocal } = rule.anchor
  const threshold = Math.max(dueTimestamp, completedAt)
  const occurrence = (steps: number): number | undefined => {
    const parts = occurrenceLocalParts(anchorLocal, rule, steps)
    return parts ? instantForLocal(parts, rule.anchor.timeZone) : undefined
  }

  let lower = 0
  let upper = 1
  while (upper < MAX_OCCURRENCE_STEPS) {
    const candidate = occurrence(upper)
    if (candidate === undefined || candidate > threshold) {
      break
    }
    lower = upper
    upper = Math.min(MAX_OCCURRENCE_STEPS, upper * 2)
  }
  const upperCandidate = occurrence(upper)
  if (upper === MAX_OCCURRENCE_STEPS && upperCandidate !== undefined && upperCandidate <= threshold) {
    return undefined
  }

  let left = lower + 1
  let right = upper
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2)
    const candidate = occurrence(middle)
    if (candidate === undefined || candidate > threshold) {
      right = middle
    } else {
      left = middle + 1
    }
  }
  const next = occurrence(left)
  if (next === undefined || next <= threshold) {
    return undefined
  }
  const result = new Date(next)
  return result.getUTCFullYear() >= 1970 && result.getUTCFullYear() <= MAX_YEAR ? result.toISOString() : undefined
}

export type ChecklistPropagatedSchedule = {
  dueAt: string
  recurrence: ChecklistRecurrence
}

/**
 * Resolve the schedule a nested task should carry once its recurring ancestor
 * rolls forward to `parentNextDueAt`.
 *
 * A descendant keeps a recurrence rule it already owns; only a descendant with
 * no rule of its own adopts the ancestor's, anchored on its own deadline when
 * it has one so a deliberately chosen time of day survives. Returning
 * `undefined` means "leave this task exactly as it is": every branch that
 * cannot be resolved with certainty fails closed rather than guessing at user
 * data.
 *
 * The result is idempotent. Propagation only ever moves a descendant that is
 * still due before the ancestor's new occurrence, so re-running it against the
 * same occurrence is a no-op and repeated rolls cannot compound.
 */
export function propagatedChecklistDescendantSchedule(
  parentNextDueAt: string,
  parentRecurrence: ChecklistRecurrence,
  descendant: { dueAt?: string; recurrence?: ChecklistRecurrence },
  completedAt = Date.now(),
): ChecklistPropagatedSchedule | undefined {
  const nextDueAt = normalizeChecklistDueAt(parentNextDueAt)
  const parentRule = normalizeChecklistRecurrence(parentRecurrence)
  const target = nextDueAt ? Date.parse(nextDueAt) : Number.NaN
  if (!nextDueAt || !parentRule || !Number.isFinite(target) || !Number.isFinite(completedAt)) {
    return undefined
  }

  const inheritedChoice = checklistRecurrenceChoice(parentRule)
  if (!inheritedChoice) {
    return undefined
  }
  const inherit = (anchoredOn: string): ChecklistRecurrence | undefined =>
    createChecklistRecurrence(inheritedChoice, anchoredOn, parentRule.anchor.timeZone)

  const descendantDueAt = normalizeChecklistDueAt(descendant.dueAt)
  if (!descendantDueAt) {
    // An unscheduled subtask becomes due with the occurrence it belongs to.
    const inherited = inherit(nextDueAt)
    return inherited ? { dueAt: nextDueAt, recurrence: inherited } : undefined
  }

  const own = normalizeChecklistRecurrence(descendant.recurrence)
  const rule = own ?? inherit(descendantDueAt)
  if (!rule) {
    return undefined
  }

  const descendantTimestamp = Date.parse(descendantDueAt)
  if (!Number.isFinite(descendantTimestamp)) {
    return undefined
  }
  if (descendantTimestamp >= target) {
    // Already due at or after the new occurrence: only a missing rule is added.
    return own ? undefined : { dueAt: descendantDueAt, recurrence: rule }
  }

  // The first occurrence of the descendant's own cadence that lands at or after
  // the ancestor's new deadline. `advanceChecklistDueAt` returns the first
  // occurrence strictly after its threshold, so the threshold is one
  // millisecond before the ancestor's occurrence.
  const advanced = advanceChecklistDueAt(descendantDueAt, rule, target - 1)
  return advanced ? { dueAt: advanced, recurrence: rule } : undefined
}

export function checklistRecurrenceChoice(value: ChecklistRecurrence): ChecklistRecurrenceChoice | undefined {
  const rule = normalizeChecklistRecurrence(value)
  if (!rule) {
    return undefined
  }
  return rule.frequency === 'custom'
    ? { frequency: 'custom', interval: rule.interval, unit: rule.unit }
    : rule.frequency
}

export function checklistRecurrenceSummary(value: unknown, includeTimeZone = false): string | undefined {
  const rule = normalizeChecklistRecurrence(value)
  if (!rule) {
    return undefined
  }
  let summary: string
  switch (rule.frequency) {
    case 'daily':
      summary = 'Repeats daily'
      break
    case 'weekdays':
      summary = 'Repeats on weekdays'
      break
    case 'weekly':
      summary = 'Repeats weekly'
      break
    case 'monthly':
      summary = 'Repeats monthly'
      break
    case 'yearly':
      summary = 'Repeats yearly'
      break
    case 'custom': {
      const unit = rule.interval === 1 ? rule.unit : `${rule.unit}s`
      summary = `Repeats every ${rule.interval} ${unit}`
      break
    }
  }
  return includeTimeZone ? `${summary} · ${rule.anchor.timeZone} wall time` : summary
}

export function checklistRecurrencesEqual(
  first: ChecklistRecurrence | undefined,
  second: ChecklistRecurrence | undefined,
): boolean {
  return JSON.stringify(normalizeChecklistRecurrence(first)) === JSON.stringify(normalizeChecklistRecurrence(second))
}
