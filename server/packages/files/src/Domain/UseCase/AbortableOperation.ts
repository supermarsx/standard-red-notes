export class FileDownloadAbortedError extends Error {
  constructor() {
    super('File download operation was aborted')
    this.name = 'FileDownloadAbortedError'
  }
}

/**
 * Bounds an operation even when an implementation cannot cancel its underlying
 * system call. Implementations should still receive the same signal so storage
 * SDKs that support cancellation can release their resources promptly.
 */
export function executeAbortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation()
  }
  if (signal.aborted) {
    return Promise.reject(new FileDownloadAbortedError())
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(new FileDownloadAbortedError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          reject(error)
        },
      )
  })
}
