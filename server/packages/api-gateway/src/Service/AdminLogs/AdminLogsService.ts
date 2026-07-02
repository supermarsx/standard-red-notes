import { promises as fs } from 'fs'
import * as path from 'path'

/**
 * Standard Red Notes: one parsed server-log line for the admin panel's Logs
 * tab. `timestamp`/`service`/`level` are best-effort — JSON (winston) lines
 * carry them; plain stdout lines only fill `message` (with `service` inferred
 * from the file name).
 */
export interface LogEntry {
  timestamp: string | null
  service: string | null
  level: string | null
  message: string
}

export interface AdminLogsQuery {
  limit: number
  service?: string
  level?: string
}

export interface AdminLogsResult {
  entries: LogEntry[]
  truncated: boolean
}

/**
 * Standard Red Notes: filesystem seam so the service is unit-testable without a
 * real log directory. The default implementation reads the container's
 * supervisord log directory (SERVER_LOGS_PATH, default /var/lib/server/logs).
 */
export interface LogFileSystem {
  readdir(directory: string): Promise<string[]>
  readFile(filePath: string): Promise<string>
}

const DEFAULT_FS: LogFileSystem = {
  readdir: (directory: string) => fs.readdir(directory),
  readFile: (filePath: string) => fs.readFile(filePath, 'utf8'),
}

/**
 * Standard Red Notes: tails the per-service supervisord log files
 * (`/var/lib/server/logs/<service>.log` and `.err`) and returns a merged,
 * newest-first, parsed view. Read-only. If the directory is missing/unreadable
 * it degrades to an empty result rather than throwing — the endpoint stays 200.
 *
 * SECURITY: this only exposes files the operator already writes; it performs no
 * redaction. At the default `info` log level these lines carry no auth tokens or
 * secrets, but an operator running at `debug` should be aware log lines are
 * surfaced verbatim to admins.
 */
export class AdminLogsService {
  constructor(
    private logsDirectory: string,
    private fileSystem: LogFileSystem = DEFAULT_FS,
  ) {}

  async tail(query: AdminLogsQuery): Promise<AdminLogsResult> {
    const limit = query.limit

    let fileNames: string[]
    try {
      fileNames = await this.fileSystem.readdir(this.logsDirectory)
    } catch {
      // No log directory (e.g. logs not file-based in this deployment) — degrade.
      return { entries: [], truncated: false }
    }

    const logFiles = fileNames.filter((name) => name.endsWith('.log') || name.endsWith('.err'))

    const serviceFilter = query.service?.toLowerCase()
    const levelFilter = query.level?.toLowerCase()

    let candidates: LogEntry[] = []
    let truncated = false

    for (const fileName of logFiles) {
      const serviceFromFile = fileName.replace(/\.(log|err)$/, '')
      if (serviceFilter !== undefined && serviceFromFile.toLowerCase() !== serviceFilter) {
        // Fast path: skip whole files that cannot match the service filter.
        // (JSON lines may still carry a different `service`, but the filename is
        // authoritative for these supervisord-captured stdout/stderr streams.)
        continue
      }

      let content: string
      try {
        content = await this.fileSystem.readFile(path.join(this.logsDirectory, fileName))
      } catch {
        continue
      }

      const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')

      // Tail with filters applied: scan from the newest line backwards, keeping
      // matching entries until we have `limit` from this file. This yields the
      // last N MATCHING lines (a plain last-N-then-filter would drop older
      // matches) while still bounding work per file.
      let keptFromThisFile = 0
      for (let index = lines.length - 1; index >= 0; index--) {
        const entry = this.parseLine(lines[index], serviceFromFile)
        if (levelFilter !== undefined && (entry.level?.toLowerCase() ?? '') !== levelFilter) {
          continue
        }
        if (serviceFilter !== undefined && (entry.service?.toLowerCase() ?? '') !== serviceFilter) {
          continue
        }
        if (keptFromThisFile >= limit) {
          // More matching lines exist in this file than the caller asked for.
          truncated = true
          break
        }
        candidates.push(entry)
        keptFromThisFile++
      }
    }

    candidates.sort((a, b) => this.timeValue(b.timestamp) - this.timeValue(a.timestamp))

    if (candidates.length > limit) {
      truncated = true
      candidates = candidates.slice(0, limit)
    }

    return { entries: candidates, truncated }
  }

  private parseLine(line: string, serviceFromFile: string): LogEntry {
    const trimmed = line.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const timestamp = parsed.timestamp ?? parsed.time ?? parsed['@timestamp']
        const message = parsed.message ?? parsed.msg ?? ''

        return {
          timestamp: typeof timestamp === 'string' ? timestamp : timestamp != null ? String(timestamp) : null,
          service: typeof parsed.service === 'string' ? parsed.service : serviceFromFile,
          level: typeof parsed.level === 'string' ? parsed.level : null,
          message: typeof message === 'string' ? message : JSON.stringify(message),
        }
      } catch {
        // Fall through to plain-line handling.
      }
    }

    return { timestamp: null, service: serviceFromFile, level: null, message: trimmed }
  }

  private timeValue(timestamp: string | null): number {
    if (timestamp === null) {
      return 0
    }
    const asNumber = Number(timestamp)
    if (Number.isFinite(asNumber) && timestamp.trim() !== '') {
      return asNumber
    }
    const parsed = Date.parse(timestamp)

    return Number.isNaN(parsed) ? 0 : parsed
  }
}
