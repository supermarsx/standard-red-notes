/**
 * Standard Red Notes: pure, unit-tested export helpers for the Admin pane's
 * Logs and Audit tabs, plus the single DOM side-effect (`triggerBlobDownload`)
 * that turns their output into a browser download.
 *
 * The formatting/escaping functions are deterministic and covered by
 * `adminExportUtils.spec.ts`; only `triggerBlobDownload` touches the DOM.
 */

import type { LogEntry } from './adminHelpers'

// ---------------------------------------------------------------------------
// Filename timestamp
// ---------------------------------------------------------------------------

/**
 * Compact local timestamp for export filenames: `yyyymmdd-hhmm` (e.g.
 * `20260702-1435`). Uses local time so the stamp matches the admin's clock.
 */
export const exportTimestamp = (now: Date = new Date()): string => {
  const pad = (n: number, width = 2): string => n.toString().padStart(width, '0')
  const yyyy = pad(now.getFullYear(), 4)
  const mm = pad(now.getMonth() + 1)
  const dd = pad(now.getDate())
  const hh = pad(now.getHours())
  const min = pad(now.getMinutes())
  return `${yyyy}${mm}${dd}-${hh}${min}`
}

// ---------------------------------------------------------------------------
// Logs export
// ---------------------------------------------------------------------------

export type LogExportFormat = 'log' | 'json'

/** ISO-ish timestamp for a log export line; blank/invalid passes through raw or ''. */
const logLineTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/**
 * A single plaintext log line: `timestamp [service] level: message`. Missing
 * pieces are omitted (no empty brackets / stray colons) so the line stays
 * readable even for sparse entries.
 */
export const logEntryToLine = (entry: LogEntry): string => {
  const parts: string[] = []
  const timestamp = logLineTimestamp(entry.timestamp)
  if (timestamp) {
    parts.push(timestamp)
  }
  if (entry.service) {
    parts.push(`[${entry.service}]`)
  }
  const level = (entry.level ?? '').trim()
  const message = entry.message ?? ''
  const prefix = parts.join(' ')
  const levelAndMessage = level ? `${level}: ${message}` : message
  return prefix ? `${prefix} ${levelAndMessage}` : levelAndMessage
}

/** Plaintext `.log` body: one {@link logEntryToLine} per entry, newline-joined. */
export const logEntriesToText = (entries: LogEntry[]): string => entries.map(logEntryToLine).join('\n')

/** Pretty-printed JSON array of the raw entries. */
export const logEntriesToJSON = (entries: LogEntry[]): string => JSON.stringify(entries, null, 2)

/** Default filename for a logs export, e.g. `srn-logs-20260702-1435.log`. */
export const logsExportFilename = (format: LogExportFormat, now: Date = new Date()): string =>
  `srn-logs-${exportTimestamp(now)}.${format}`

// ---------------------------------------------------------------------------
// Audit export
// ---------------------------------------------------------------------------

export type AuditExportEntry = {
  uuid: string
  actorUuid: string | null
  action: string
  targetType: string | null
  targetUuid: string | null
  ip: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export type AuditExportFormat = 'csv' | 'json'

const AUDIT_CSV_COLUMNS = ['timestamp', 'actor', 'action', 'target', 'ip', 'metadata'] as const

/**
 * Escape a single CSV field per RFC 4180: wrap in double quotes when the value
 * contains a comma, quote, CR or LF, and double any embedded quotes. Non-string
 * input is coerced to a string first.
 *
 * Additionally neutralises SPREADSHEET FORMULA INJECTION: audit exports include
 * attacker-influenceable fields (ip, action, metadata) that could begin with a
 * formula trigger (`=`, `+`, `-`, `@`) or a control character (tab/CR) some
 * parsers treat as one. Excel/Sheets would then evaluate the cell as a formula.
 * Any such value is prefixed with a single quote `'` (the spreadsheet
 * "treat-as-text" marker) BEFORE the RFC-4180 quoting is applied.
 */
export const csvEscape = (value: unknown): string => {
  let str = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/** Combined "target" cell: `type uuid`, just the uuid, or '' when neither is set. */
const auditTarget = (entry: AuditExportEntry): string => {
  if (entry.targetUuid && entry.targetType) {
    return `${entry.targetType} ${entry.targetUuid}`
  }
  return entry.targetUuid ?? entry.targetType ?? ''
}

/** Compact JSON string for the metadata cell, or '' when there is none. */
const auditMetadataCell = (metadata: Record<string, unknown> | null): string => {
  return metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : ''
}

/** One CSV data row (already escaped) for an audit entry. */
export const auditEntryToCSVRow = (entry: AuditExportEntry): string =>
  [
    entry.createdAt,
    entry.actorUuid ?? '',
    entry.action,
    auditTarget(entry),
    entry.ip ?? '',
    auditMetadataCell(entry.metadata),
  ]
    .map(csvEscape)
    .join(',')

/**
 * Full CSV document: a header row (timestamp, actor, action, target, ip,
 * metadata) followed by one row per entry, CRLF-terminated for Excel-friendly
 * parsing.
 */
export const auditEntriesToCSV = (entries: AuditExportEntry[]): string => {
  const rows = [AUDIT_CSV_COLUMNS.join(','), ...entries.map(auditEntryToCSVRow)]
  return rows.join('\r\n')
}

/** Pretty-printed JSON array of the raw audit entries. */
export const auditEntriesToJSON = (entries: AuditExportEntry[]): string => JSON.stringify(entries, null, 2)

/** Default filename for an audit export, e.g. `srn-audit-20260702-1435.csv`. */
export const auditExportFilename = (format: AuditExportFormat, now: Date = new Date()): string =>
  `srn-audit-${exportTimestamp(now)}.${format}`

// ---------------------------------------------------------------------------
// Download side-effect (the only impure function here)
// ---------------------------------------------------------------------------

/**
 * Trigger a client-side file download of `content` via a Blob + temporary
 * object URL, revoking the URL afterwards. Mirrors the idiom in
 * `Utils/ICS/downloadICS.ts` and the 2FA key download.
 */
export const triggerBlobDownload = (filename: string, content: string, mimeType: string): void => {
  const blob = new Blob([content], { type: mimeType })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}
