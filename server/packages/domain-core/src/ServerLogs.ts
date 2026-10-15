import { promises as fs } from 'fs'
import { safeErrorLogMetadata } from './Domain/Logging/SafeErrorLogMetadata'

export interface ServerLogEntry {
  timestamp: string | null
  service: string | null
  level: string | null
  message: string
}

export interface ServerLogsQuery {
  limit: number
  service?: string
  level?: string
  search?: string
  since?: string
  order?: 'asc' | 'desc'
}

export interface ServerLogsResult {
  entries: ServerLogEntry[]
  truncated: boolean
}

/**
 * Standard Red Notes: filesystem seam so the service is unit-testable without a
 * real log directory. The default implementation reads the container's
 * supervisord log directory (SERVER_LOGS_PATH, default /var/lib/server/logs).
 */
export interface ServerLogFileSystem {
  joinPath(...parts: string[]): string
  readdir(directory: string): Promise<string[]>
  readFile(filePath: string): Promise<string>
  readTail?(filePath: string, maxBytes: number): Promise<string | { content: string; truncated: boolean }>
}

export const MAX_BYTES_PER_LOG_FILE = 512 * 1024

export async function readServerLogTail(
  filePath: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    const bytesToRead = Math.min(stats.size, maxBytes)
    const offset = Math.max(0, stats.size - bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset)
    let content = buffer.subarray(0, bytesRead).toString('utf8')

    if (offset > 0) {
      const firstLineEnd = content.indexOf('\n')
      content = firstLineEnd >= 0 ? content.slice(firstLineEnd + 1) : ''
    }

    return { content, truncated: offset > 0 }
  } finally {
    await handle.close()
  }
}

export async function tailServerLogs(
  fileSystem: ServerLogFileSystem,
  logsDirectory: string,
  query: ServerLogsQuery,
): Promise<ServerLogsResult> {
  const limit =
    Number.isFinite(query.limit) && query.limit > 0 ? Math.min(500, Math.max(1, Math.floor(query.limit))) : 200
  let fileNames: string[]
  try {
    fileNames = await fileSystem.readdir(logsDirectory)
  } catch {
    return { entries: [], truncated: false }
  }
  const serviceFilter = query.service?.toLowerCase()
  const levelFilter = query.level?.toLowerCase()
  const search = query.search?.slice(0, 256).toLowerCase()
  const since = normalizeLogTimestamp(query.since)
  const sinceTime = since ? Date.parse(since) : undefined
  type Candidate = { entry: ServerLogEntry; file: string; line: number }
  const compare = (a: Candidate, b: Candidate, direction = -1): number => {
    const aTime = a.entry.timestamp ? Date.parse(a.entry.timestamp) : undefined
    const bTime = b.entry.timestamp ? Date.parse(b.entry.timestamp) : undefined
    // Unknown timestamps stay after known timestamps, rather than claiming
    // they are the oldest epoch or inventing a cross-file capture time.
    if (aTime === undefined && bTime !== undefined) {
      return 1
    }
    if (aTime !== undefined && bTime === undefined) {
      return -1
    }
    if (aTime !== undefined && bTime !== undefined && aTime !== bTime) {
      return direction * (aTime - bTime)
    }
    if (a.file !== b.file) {
      return direction * a.file.localeCompare(b.file)
    }
    return direction * (a.line - b.line)
  }
  let candidates: Candidate[] = []
  let truncated = false
  for (const fileName of fileNames.filter((name) => /\.(log|err)$/.test(name)).sort()) {
    const serviceFromFile = fileName.replace(/\.(log|err)$/, '')
    let content: string
    try {
      const filePath = fileSystem.joinPath(logsDirectory, fileName)
      const tail = fileSystem.readTail
        ? await fileSystem.readTail(filePath, MAX_BYTES_PER_LOG_FILE)
        : await fileSystem.readFile(filePath)
      content = typeof tail === 'string' ? tail : tail.content
      if (typeof tail !== 'string' && tail.truncated) {
        truncated = true
      }
    } catch {
      continue
    }
    // The injected full-file seam receives the same byte bound as production.
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES_PER_LOG_FILE) {
      const bounded = Buffer.from(content, 'utf8').subarray(-MAX_BYTES_PER_LOG_FILE).toString('utf8')
      const firstLineEnd = bounded.indexOf('\n')
      content = firstLineEnd >= 0 ? bounded.slice(firstLineEnd + 1) : ''
      truncated = true
    }
    const matches: Candidate[] = []
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) {
        continue
      }
      const entry = parseServerLogLine(lines[index], serviceFromFile)
      if (levelFilter !== undefined && entry.level !== levelFilter) {
        continue
      }
      if (serviceFilter !== undefined && entry.service?.toLowerCase() !== serviceFilter) {
        continue
      }
      if (search && !entry.message.toLowerCase().includes(search)) {
        continue
      }
      if (sinceTime !== undefined && (entry.timestamp === null || Date.parse(entry.timestamp) < sinceTime)) {
        continue
      }
      matches.push({ entry, file: fileName, line: index })
    }
    // Source timestamps can arrive out of order; sorting every bounded tail
    // before limiting avoids silently dropping its most recent matching event.
    matches.sort(compare)
    if (matches.length > limit) {
      truncated = true
    }
    candidates.push(...matches.slice(0, limit))
  }
  candidates.sort(compare)
  if (candidates.length > limit) {
    truncated = true
  }
  candidates = candidates.slice(0, limit)
  if (query.order === 'asc') {
    candidates.sort((a, b) => compare(a, b, 1))
  }
  return { entries: candidates.map((candidate) => candidate.entry), truncated }
}

export function parseServerLogLine(line: string, serviceFromFile: string): ServerLogEntry {
  let message = line.trim()
  let timestamp: string | null = null
  let service = serviceFromFile
  let level: string | null = null
  const envelope = /^\[([^\]]+)\]\s+\[([a-zA-Z0-9._-]+)\]\s+\[(stdout|stderr)\]\s?(.*)$/.exec(message)
  if (envelope && normalizeLogTimestamp(envelope[1])) {
    timestamp = normalizeLogTimestamp(envelope[1])
    service = envelope[2]
    level = envelope[3] === 'stderr' ? 'error' : 'info'
    message = envelope[4]
  } else {
    // Timestamped console output without a capture envelope, including
    // Winston's ISO timestamp followed by an explicit level prefix.
    const prefix = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\]?\s+(.*)$/.exec(message)
    if (prefix && normalizeLogTimestamp(prefix[1])) {
      timestamp = normalizeLogTimestamp(prefix[1])
      message = prefix[2]
    }
  }
  if (message.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(message)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const value = record.message ?? record.msg ?? ''
        return {
          timestamp: normalizeLogTimestamp(record.timestamp ?? record.time ?? record['@timestamp']) ?? timestamp,
          service: typeof record.service === 'string' ? record.service : service,
          level: normalizeLogLevel(record.level) ?? level,
          message: appendSafeLogClassification(
            appendSafeSyncProgress(typeof value === 'string' ? value : JSON.stringify(value), record),
            record,
          ),
        }
      }
    } catch {
      // Preserve malformed JSON and its real capture metadata verbatim.
    }
  }
  const prefix = /^\[?(error|warn|warning|info|http|verbose|debug|silly|trace|fatal)\]?(?:\s*:\s*|\s+)(.*)$/i.exec(
    message,
  )
  if (prefix) {
    level = normalizeLogLevel(prefix[1])
    message = prefix[2]
  }
  return { timestamp, service, level, message }
}

/** Epoch values follow common seconds/milliseconds conventions; ambiguous or
 * invalid metadata stays unknown. Output is consistently ISO UTC. */
export function normalizeLogTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return null
  }
  const trimmed = typeof value === 'string' ? value.trim() : value
  if (trimmed === '') {
    return null
  }
  let time: number
  if (typeof trimmed === 'number' || /^\d+(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed)
    if (!Number.isFinite(number) || number < 0) {
      return null
    }
    time = number < 100_000_000_000 ? number * 1000 : number
  } else {
    // Require an explicit timezone; server-local dates must not become a
    // different event time depending on the admin gateway's timezone.
    const iso =
      /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(
        trimmed,
      )
    if (!iso) {
      return null
    }
    const day = new Date(`${iso[1]}T00:00:00.000Z`)
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== iso[1]) {
      return null
    }
    time = Date.parse(trimmed)
  }
  if (!Number.isFinite(time)) {
    return null
  }
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeLogLevel(value: unknown): string | null {
  if (typeof value === 'number') {
    return (
      (
        {
          0: 'error',
          1: 'warn',
          2: 'info',
          3: 'http',
          4: 'verbose',
          5: 'debug',
          6: 'silly',
          10: 'trace',
          20: 'debug',
          30: 'info',
          40: 'warn',
          50: 'error',
          60: 'fatal',
        } as Record<number, string>
      )[value] ?? null
    )
  }
  if (typeof value !== 'string') {
    return null
  }
  const level = value.trim().toLowerCase()
  if (level === 'warning') {
    return 'warn'
  }
  return ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly', 'trace', 'fatal'].includes(level) ? level : null
}

/** Closed progress vocabulary only: unrelated structured metadata is never
 * folded into the admin/CLI text, where it could expose request payloads. */
function appendSafeSyncProgress(message: string, record: Record<string, unknown>): string {
  if (message !== '[ws-sync] operation did not complete') {
    return message
  }
  const fields: string[] = []
  if (record.operation === 'command' || record.operation === 'status') {
    fields.push(`operation=${record.operation}`)
  }
  if (
    typeof record.phase === 'string' &&
    ['lease-acquisition', 'authorization', 'pre-execute-authorization', 'backend-execute', 'backend-status'].includes(
      record.phase,
    )
  ) {
    fields.push(`phase=${record.phase}`)
  }
  if (typeof record.outcome === 'string' && ['error', 'aborted', 'socket-closed', 'timeout'].includes(record.outcome)) {
    fields.push(`outcome=${record.outcome}`)
  }
  if (typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0) {
    fields.push(`elapsedMs=${record.elapsedMs}`)
  }
  return fields.length ? `${message} ${fields.join(' ')}` : message
}

const KnownLogActions = new Set([
  'session.validate',
  'service-proxy.request',
  'service-proxy.retry-exhausted',
  'service-proxy.grpc-fallback',
  'service-proxy.grpc-fallback-refused',
  'service-proxy.grpc-fallback-failed',
])
const KnownFailureClasses = new Set([
  'channel-unavailable',
  'deadline-exceeded',
  'method-unimplemented',
  'transport-internal',
  'message-limit',
  'cancelled',
  'server-fault',
  'never-dispatched',
  'application',
])
const KnownRouteCategories = new Set(['session-validation', 'authentication', 'items-sync'])

/** Only fixed categories are returned; origins, paths and query values never enter the rendered log. */
function safeLogRoute(record: Record<string, unknown>): string | undefined {
  if (typeof record.routeCategory === 'string' && KnownRouteCategories.has(record.routeCategory)) {
    return record.routeCategory
  }
  if (record.action === 'session.validate') {
    return 'session-validation'
  }
  if (typeof record.endpoint !== 'string' || record.endpoint.length > 2048) {
    return undefined
  }
  try {
    const path = new URL(record.endpoint, 'http://log.invalid').pathname
    if (path === '/sessions/validate' || path === '/v1/sessions/validate') {
      return 'session-validation'
    }
    if (path === '/items/sync' || path === '/v1/items/sync') {
      return 'items-sync'
    }
    if (path === '/auth/sign_in' || path === '/v1/auth/sign_in') {
      return 'authentication'
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Appending metadata uses a closed vocabulary, never serialization of arbitrary logger fields. */
function appendSafeLogClassification(message: string, record: Record<string, unknown>): string {
  const fields: string[] = []
  const error = safeErrorLogMetadata({ name: record.errorType, code: record.errorCode })
  if (typeof record.errorType === 'string' && error.errorType === record.errorType) {
    fields.push(`errorType=${error.errorType}`)
  }
  if (error.errorCode !== undefined) {
    fields.push(`errorCode=${error.errorCode}`)
  }
  if (
    typeof record.status === 'number' &&
    Number.isSafeInteger(record.status) &&
    ((record.status >= 100 && record.status <= 599) || (record.status >= 0 && record.status <= 16))
  ) {
    fields.push(`status=${record.status}`)
  }
  if (typeof record.action === 'string' && KnownLogActions.has(record.action)) {
    fields.push(`action=${record.action}`)
  }
  if (typeof record.failureClass === 'string' && KnownFailureClasses.has(record.failureClass)) {
    fields.push(`failureClass=${record.failureClass}`)
  }
  if (record.lane === 'session-validation' || record.lane === 'items-sync') {
    fields.push(`lane=${record.lane}`)
  }
  const route = safeLogRoute(record)
  if (route) {
    fields.push(`route=${route}`)
  }
  return fields.length ? `${message} ${fields.join(' ')}` : message
}
