import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { Readable, Writable } from 'stream'
import { Logger } from 'winston'

export const DEFAULT_FILE_DOWNLOAD_DEADLINE_MS = 30_000
export const FILE_DOWNLOAD_TIMEOUT_CODE = 'file_download_timed_out'
export const FILE_STORAGE_UNAVAILABLE_CODE = 'file_storage_unavailable'
export const FILE_DOWNLOAD_TIMEOUT_MESSAGE = 'Encrypted file download timed out. Please try again.'
export const FILE_DOWNLOAD_RETRY_AFTER_SECONDS = 1

export type FileDownloadAbortReason = 'deadline' | 'client-disconnect'

/** Owns the request-wide timer and disconnect listeners for one file range. */
export class FileDownloadRequestLifecycle {
  private readonly abortController = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private abortReason: FileDownloadAbortReason | undefined
  private disposed = false

  constructor(
    private readonly request: Request,
    private readonly response: Response,
    private readonly deadlineMs: number,
  ) {
    request.once('aborted', this.onRequestAborted)
    response.once('close', this.onResponseClose)
    response.once('finish', this.onResponseFinish)
    this.timer = setTimeout(this.onDeadline, deadlineMs)
    this.timer.unref()
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  get reason(): FileDownloadAbortReason | undefined {
    return this.abortReason
  }

  get timedOut(): boolean {
    return this.abortReason === 'deadline'
  }

  get clientDisconnected(): boolean {
    return this.abortReason === 'client-disconnect'
  }

  get configuredDeadlineMs(): number {
    return this.deadlineMs
  }

  dispose = (): void => {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.request.removeListener('aborted', this.onRequestAborted)
    this.response.removeListener('close', this.onResponseClose)
    this.response.removeListener('finish', this.onResponseFinish)
  }

  private readonly onDeadline = (): void => this.abort('deadline')
  private readonly onRequestAborted = (): void => this.abort('client-disconnect')
  private readonly onResponseFinish = (): void => this.dispose()
  private readonly onResponseClose = (): void => {
    if (this.response.writableEnded) {
      this.dispose()
    } else {
      this.abort('client-disconnect')
    }
  }

  private abort(reason: FileDownloadAbortReason): void {
    if (this.abortController.signal.aborted) {
      return
    }
    this.abortReason = reason
    this.dispose()
    this.abortController.abort()
  }
}

/** Pipes only after success headers exist; failures terminate the partial body. */
export function pipeFileDownload(
  readStream: Readable,
  response: Response,
  lifecycle: FileDownloadRequestLifecycle,
  logger: Logger,
): Writable {
  let settled = false

  const cleanup = (): void => {
    lifecycle.signal.removeEventListener('abort', onAbort)
    readStream.removeListener('error', onStreamError)
    response.removeListener('close', onResponseClose)
    response.removeListener('finish', onResponseFinish)
    lifecycle.dispose()
  }
  const terminate = (error?: Error): void => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
    if (!readStream.destroyed) {
      readStream.destroy()
    }
    if (!response.destroyed) {
      response.destroy(error)
    }
  }
  const onAbort = (): void => {
    if (lifecycle.timedOut) {
      logger.warn('File download terminated after its server deadline.', {
        code: FILE_DOWNLOAD_TIMEOUT_CODE,
        deadlineMs: lifecycle.configuredDeadlineMs,
        stage: 'stream-body',
      })
    }
    terminate()
  }
  const onStreamError = (error: Error): void => {
    logger.error('Error while streaming file download.', safeErrorLogMetadata(error))
    terminate(error)
  }
  const onResponseClose = (): void => terminate()
  const onResponseFinish = (): void => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
  }

  lifecycle.signal.addEventListener('abort', onAbort, { once: true })
  readStream.once('error', onStreamError)
  response.once('close', onResponseClose)
  response.once('finish', onResponseFinish)

  if (lifecycle.signal.aborted) {
    onAbort()
    return response as unknown as Writable
  }

  try {
    return readStream.pipe(response)
  } catch (error) {
    onStreamError(error instanceof Error ? error : new Error('File stream pipe failed'))
    return response as unknown as Writable
  }
}
