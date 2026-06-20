import { ICSEvent, toICS } from './toICS'

/** Local YYYY-MM-DD for "today" (filename stamp). */
const todayStamp = (now: Date = new Date()): string =>
  `${now.getFullYear().toString().padStart(4, '0')}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`

/** Build a default export filename like `standard-red-notes-2026-06-20.ics`. */
export const defaultICSFilename = (prefix = 'standard-red-notes', now: Date = new Date()): string =>
  `${prefix}-${todayStamp(now)}.ics`

/**
 * Generate an `.ics` from events and trigger a browser download via a Blob +
 * temporary anchor (the same approach used by the 2FA key download). Pure ICS
 * generation lives in {@link toICS}; this is the thin DOM side-effect layer.
 */
export const downloadICS = (events: ICSEvent[], filename: string = defaultICSFilename()): void => {
  const ics = toICS(events)
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}
