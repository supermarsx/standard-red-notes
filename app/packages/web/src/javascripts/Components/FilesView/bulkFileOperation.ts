import { FileItem } from '@standardnotes/snjs'

export type BulkFileFailure = {
  uuid: string
  name: string
  message: string
}

export type BulkFileResult = {
  succeeded: FileItem[]
  failed: BulkFileFailure[]
}

export type BulkFileProgress = {
  completed: number
  total: number
}

export type RunBulkFileOperationOptions = {
  onProgress?: (progress: BulkFileProgress) => void
  concurrency?: number
}

/**
 * Files are fetched and mutated over the network one at a time, so a handful of
 * requests in flight keeps a large selection moving without saturating sync.
 */
const DefaultConcurrency = 4

export const describeBulkFileError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || error.name || 'Unknown error'
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  // ClientDisplayableError carries its message on `text` and is not an Error
  // subclass, so it would otherwise be reported as "Unknown error".
  if (error && typeof error === 'object') {
    const { text, message } = error as { text?: unknown; message?: unknown }
    if (typeof text === 'string' && text.trim().length > 0) {
      return text
    }
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
  }
  return 'Unknown error'
}

/**
 * Standard Red Notes: runs a per-file operation across a selection and always
 * resolves with a per-item verdict.
 *
 * Bulk file management used to funnel through `Promise.all`, which rejects on
 * the first failure — the remaining files were left in an unknown state and the
 * user was told nothing about which ones had actually been processed. Every file
 * is attempted here regardless of its neighbours, and both the successes and the
 * individually-attributed failures are returned so the caller can report honestly
 * and deselect only what genuinely completed.
 */
export async function runBulkFileOperation(
  files: FileItem[],
  operation: (file: FileItem) => Promise<void>,
  { onProgress, concurrency = DefaultConcurrency }: RunBulkFileOperationOptions = {},
): Promise<BulkFileResult> {
  const total = files.length
  const succeededByIndex = new Map<number, FileItem>()
  const failedByIndex = new Map<number, BulkFileFailure>()

  let completed = 0
  let cursor = 0

  onProgress?.({ completed: 0, total })

  if (total === 0) {
    return { succeeded: [], failed: [] }
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const file = files[index]
      if (!file) {
        return
      }

      try {
        await operation(file)
        succeededByIndex.set(index, file)
      } catch (error) {
        failedByIndex.set(index, {
          uuid: file.uuid,
          name: file.name,
          message: describeBulkFileError(error),
        })
      }

      completed += 1
      onProgress?.({ completed, total })
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  // Report in the caller's original order rather than completion order, so the
  // failure list lines up with what the user sees in the table.
  const byIndex = <Value>(entries: Map<number, Value>): Value[] =>
    Array.from(entries.entries())
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)

  return { succeeded: byIndex(succeededByIndex), failed: byIndex(failedByIndex) }
}
