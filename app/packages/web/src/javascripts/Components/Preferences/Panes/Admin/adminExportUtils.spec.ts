import {
  auditEntriesToCSV,
  auditEntriesToJSON,
  auditEntryToCSVRow,
  auditExportFilename,
  csvEscape,
  exportTimestamp,
  logEntriesToJSON,
  logEntriesToText,
  logEntryToLine,
  logsExportFilename,
  type AuditExportEntry,
} from './adminExportUtils'
import type { LogEntry } from './adminHelpers'

const logEntry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: '2026-07-02T14:35:00.000Z',
  service: 'auth',
  level: 'info',
  message: 'user signed in',
  ...overrides,
})

const auditEntry = (overrides: Partial<AuditExportEntry> = {}): AuditExportEntry => ({
  uuid: 'u-1',
  actorUuid: 'actor-1',
  action: 'user.ban',
  targetType: 'user',
  targetUuid: 'target-1',
  ip: '203.0.113.7',
  metadata: { reason: 'spam' },
  createdAt: '2026-07-02T14:35:00.000Z',
  ...overrides,
})

describe('exportTimestamp', () => {
  it('formats yyyymmdd-hhmm in local time, zero-padded', () => {
    // Local time constructor so the assertion is timezone-independent.
    const now = new Date(2026, 6, 2, 9, 4) // 2026-07-02 09:04 local
    expect(exportTimestamp(now)).toBe('20260702-0904')
  })

  it('pads the year to four digits', () => {
    const now = new Date(9, 0, 1, 0, 0)
    now.setFullYear(9)
    expect(exportTimestamp(now).startsWith('0009')).toBe(true)
  })
})

describe('logEntryToLine', () => {
  it('renders timestamp [service] level: message', () => {
    expect(logEntryToLine(logEntry())).toBe('2026-07-02T14:35:00.000Z [auth] info: user signed in')
  })

  it('omits missing pieces without leaving empty brackets or stray colons', () => {
    expect(logEntryToLine(logEntry({ timestamp: null, service: null, level: null }))).toBe('user signed in')
    expect(logEntryToLine(logEntry({ service: null }))).toBe('2026-07-02T14:35:00.000Z info: user signed in')
    expect(logEntryToLine(logEntry({ level: null }))).toBe('2026-07-02T14:35:00.000Z [auth] user signed in')
  })

  it('passes a non-ISO timestamp through unchanged', () => {
    expect(logEntryToLine(logEntry({ timestamp: 'not-a-date' }))).toBe('not-a-date [auth] info: user signed in')
  })
})

describe('logEntriesToText / logEntriesToJSON', () => {
  it('joins one line per entry with newlines', () => {
    const text = logEntriesToText([logEntry(), logEntry({ level: 'error', message: 'boom' })])
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('error: boom')
  })

  it('serialises the raw entries array as pretty JSON', () => {
    const entries = [logEntry()]
    expect(JSON.parse(logEntriesToJSON(entries))).toEqual(entries)
  })
})

describe('csvEscape', () => {
  it('leaves plain values untouched', () => {
    expect(csvEscape('hello')).toBe('hello')
    expect(csvEscape('actor-1')).toBe('actor-1')
  })

  it('quotes and doubles quotes when a comma, quote or newline is present', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape('cr\rlf')).toBe('"cr\rlf"')
  })

  it('coerces null/undefined to an empty field', () => {
    expect(csvEscape(null)).toBe('')
    expect(csvEscape(undefined)).toBe('')
  })
})

describe('auditEntryToCSVRow / auditEntriesToCSV', () => {
  it('builds a row with timestamp, actor, action, combined target, ip and JSON metadata', () => {
    expect(auditEntryToCSVRow(auditEntry())).toBe(
      '2026-07-02T14:35:00.000Z,actor-1,user.ban,user target-1,203.0.113.7,"{""reason"":""spam""}"',
    )
  })

  it('uses empty cells for null actor/ip/target and empty metadata', () => {
    const row = auditEntryToCSVRow(
      auditEntry({ actorUuid: null, ip: null, targetType: null, targetUuid: null, metadata: null }),
    )
    expect(row).toBe('2026-07-02T14:35:00.000Z,,user.ban,,,')
  })

  it('emits a header row and CRLF line endings', () => {
    const csv = auditEntriesToCSV([auditEntry()])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('timestamp,actor,action,target,ip,metadata')
    expect(lines).toHaveLength(2)
  })

  it('serialises the raw audit entries as pretty JSON', () => {
    const entries = [auditEntry()]
    expect(JSON.parse(auditEntriesToJSON(entries))).toEqual(entries)
  })
})

describe('filenames', () => {
  const now = new Date(2026, 6, 2, 14, 35)

  it('names log exports srn-logs-<stamp>.<ext>', () => {
    expect(logsExportFilename('log', now)).toBe('srn-logs-20260702-1435.log')
    expect(logsExportFilename('json', now)).toBe('srn-logs-20260702-1435.json')
  })

  it('names audit exports srn-audit-<stamp>.<ext>', () => {
    expect(auditExportFilename('csv', now)).toBe('srn-audit-20260702-1435.csv')
    expect(auditExportFilename('json', now)).toBe('srn-audit-20260702-1435.json')
  })
})
