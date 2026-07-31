/* eslint-disable @typescript-eslint/no-explicit-any */

import { redactLogValue, safeErrorLogMetadata } from '@standardnotes/utils'

function safeSNLogValue(value: unknown): unknown {
  return value instanceof Error ? safeErrorLogMetadata(value) : redactLogValue(value)
}

export class SNLog {
  static log(...message: any): void {
    this.onLog(...message.map(safeSNLogValue))
  }
  static error<T extends Error>(error: T): T {
    const metadata = safeErrorLogMetadata(error)
    const safeError = Object.assign(new Error('A Standard Notes operation failed.'), metadata)
    safeError.name = String(metadata.errorType)
    this.onError(safeError)
    return error
  }
  static onLog: (...message: any) => void
  static onError: (error: Error) => void
}
