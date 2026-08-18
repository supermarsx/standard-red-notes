import type { TextPreviewLanguage } from './isFilePreviewable'
import { MAX_TEXT_PREVIEW_BYTES, prepareTextPreview, PreparedTextPreview } from './textPreviewContent'
import type { TextPreviewWorkerRequest, TextPreviewWorkerResponse } from './textPreviewWorkerProtocol'
import * as TextPreviewWorkerModule from './textPreview.worker'

const TextPreviewWorker = ((TextPreviewWorkerModule as { default?: { new (): Worker } }).default ??
  (TextPreviewWorkerModule as unknown as { new (): Worker })) as { new (): Worker }

export const TEXT_PREVIEW_WORKER_TIMEOUT_MS = 10_000

function abortError(): Error {
  const error = new Error('Text preview preparation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Decode, sniff, bidi-neutralize, and (when bounded) tokenize text away from the
 * UI thread. A copied buffer is transferred so the FilePreview-owned decrypted
 * bytes are never detached. Worker failures/timeouts take the same safe bounded
 * pure-function path on the main thread; cancellation never falls back.
 */
export function prepareTextPreviewOffThread(
  bytes: Uint8Array,
  language: TextPreviewLanguage,
  signal?: AbortSignal,
): Promise<PreparedTextPreview> {
  if (signal?.aborted) {
    return Promise.reject(abortError())
  }

  // Avoid even the transfer-copy allocation when a direct caller bypasses the
  // outer FilePreview size gate with an oversized buffer.
  if (bytes.byteLength > MAX_TEXT_PREVIEW_BYTES || typeof Worker === 'undefined') {
    return Promise.resolve(prepareTextPreview(bytes, language))
  }

  let worker: Worker
  try {
    worker = new TextPreviewWorker()
  } catch {
    return Promise.resolve(prepareTextPreview(bytes, language))
  }

  return new Promise<PreparedTextPreview>((resolve, reject) => {
    let settled = false
    const requestId = 1
    const workerBytes = bytes.slice()

    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    const settle = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    const fallBack = () => {
      settle(() => {
        if (signal?.aborted) {
          reject(abortError())
        } else {
          resolve(prepareTextPreview(bytes, language))
        }
      })
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timeout = setTimeout(fallBack, TEXT_PREVIEW_WORKER_TIMEOUT_MS)

    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<TextPreviewWorkerResponse>) => {
      const response = event.data
      if (response.requestId !== requestId) {
        return
      }
      if (response.type === 'prepared') {
        settle(() => resolve(response.result))
      } else {
        fallBack()
      }
    }
    worker.onerror = fallBack

    try {
      const request: TextPreviewWorkerRequest = {
        type: 'prepare',
        requestId,
        bytes: workerBytes,
        language,
      }
      worker.postMessage(request, [workerBytes.buffer])
    } catch {
      fallBack()
    }
  })
}
