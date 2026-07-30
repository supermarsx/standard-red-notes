export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function toDatetimeLocalValue(value: string | undefined): string {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    return ''
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function temporalInputValue(value: string | undefined): string {
  return value && DATE_ONLY_PATTERN.test(value) ? value : toDatetimeLocalValue(value)
}

export function convertTemporalInputMode(value: string, toDateOnly: boolean): string {
  if (!value) {
    return ''
  }
  const date = value.slice(0, 10)
  return toDateOnly ? date : `${date}T00:00`
}

export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return false
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function formatCalendarValue(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'Never'
  }
  if (typeof value === 'string' && DATE_ONLY_PATTERN.test(value)) {
    return isValidDateOnly(value) ? value : 'Unknown'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

export function parseTemporalInput(value: string, label: string, dateOnly = false): string | undefined {
  if (!value) {
    return undefined
  }
  if (dateOnly) {
    if (!isValidDateOnly(value)) {
      throw new Error(`Enter a valid ${label} date.`)
    }
    return value
  }
  const parsed = new Date(value)
  if (isNaN(parsed.getTime())) {
    throw new Error(`Enter a valid ${label} date and time.`)
  }
  return parsed.toISOString()
}

export function temporalRangeError(
  start: string | undefined,
  due: string | undefined,
  startDateOnly: boolean,
  dueDateOnly: boolean,
): string | null {
  if (!start || !due) {
    return null
  }
  if (startDateOnly !== dueDateOnly) {
    return 'Start and due must both be dates or both include a time.'
  }
  if (Date.parse(due) <= Date.parse(start)) {
    return 'Due must be later than start.'
  }
  return null
}
