import { promises as fs } from 'fs'
import * as path from 'path'
import {
  readServerLogTail,
  tailServerLogs,
  ServerLogEntry,
  ServerLogsQuery,
  ServerLogsResult,
  ServerLogFileSystem,
} from '@standardnotes/domain-core'
export { normalizeLogTimestamp } from '@standardnotes/domain-core'
export type LogEntry = ServerLogEntry
export type AdminLogsQuery = ServerLogsQuery
export type AdminLogsResult = ServerLogsResult
export type LogFileSystem = Omit<ServerLogFileSystem, 'joinPath'>

const DEFAULT_FS: LogFileSystem = {
  readdir: (directory) => fs.readdir(directory),
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  readTail: readServerLogTail,
}

/** Read-only admin view of bounded captured logs. Historical unknown metadata
 * remains unknown. Logs must already be safely written by their producers. */
export class AdminLogsService {
  constructor(
    private logsDirectory: string,
    private fileSystem: LogFileSystem = DEFAULT_FS,
  ) {}
  tail(query: AdminLogsQuery): Promise<AdminLogsResult> {
    return tailServerLogs(
      {
        readdir: (directory) => this.fileSystem.readdir(directory),
        readFile: (filePath) => this.fileSystem.readFile(filePath),
        readTail: this.fileSystem.readTail?.bind(this.fileSystem),
        joinPath: (...parts) => path.join(...parts),
      },
      this.logsDirectory,
      query,
    )
  }
}
