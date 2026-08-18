export type BoundedSourceFetchErrorCode = 'aborted' | 'invalid-source' | 'network' | 'size-limit' | 'timeout'

export class BoundedSourceFetchError extends Error {
  constructor(
    public readonly code: BoundedSourceFetchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BoundedSourceFetchError'
  }
}

type Options = {
  maximumBytes: number
  idleTimeoutMs: number
  signal?: AbortSignal
  onProgress?: (receivedBytes: number) => void
}

const AllowedSourceProtocols = new Set(['blob:', 'data:', 'http:', 'https:'])

function validateSource(source: string): void {
  try {
    const url = new URL(source, globalThis.location?.href ?? 'https://local.invalid/')
    if (!AllowedSourceProtocols.has(url.protocol)) {
      throw new Error('Unsupported protocol')
    }
  } catch {
    throw new BoundedSourceFetchError('invalid-source', 'The file source is not safe to load')
  }
}

/**
 * Fetches an untrusted attachment source without credentials or referrer data.
 * The response must be streamable so the byte ceiling is enforced before a
 * large allocation. Every received chunk is wiped after it is copied into the
 * single returned buffer.
 */
export async function fetchBoundedSourceBytes(source: string, options: Options): Promise<Uint8Array> {
  const { maximumBytes, idleTimeoutMs, signal, onProgress } = options
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new BoundedSourceFetchError('size-limit', 'The file size limit is invalid')
  }
  if (signal?.aborted) {
    throw new BoundedSourceFetchError('aborted', 'The file load was aborted')
  }
  validateSource(source)

  const controller = new AbortController()
  const chunks: Uint8Array[] = []
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let receivedBytes = 0
  let idleTimeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  const clearIdleTimeout = () => {
    if (idleTimeout !== undefined) {
      clearTimeout(idleTimeout)
      idleTimeout = undefined
    }
  }
  const armIdleTimeout = () => {
    clearIdleTimeout()
    idleTimeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, idleTimeoutMs)
  }
  const abortFromCaller = () => controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    armIdleTimeout()
    const response = await fetch(source, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) {
      throw new BoundedSourceFetchError('network', `Unable to load attachment source (${response.status})`)
    }
    armIdleTimeout()

    const contentLength = response.headers.get('content-length')
    if (contentLength !== null) {
      const declaredLength = Number(contentLength)
      if (Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength > maximumBytes) {
        controller.abort()
        throw new BoundedSourceFetchError('size-limit', 'The attachment exceeds the safe size limit')
      }
    }

    if (!response.body) {
      throw new BoundedSourceFetchError('network', 'This browser cannot safely stream the attachment source')
    }

    reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (controller.signal.aborted) {
        value?.fill(0)
        throw new BoundedSourceFetchError('aborted', 'The file load was aborted')
      }
      if (!value) {
        continue
      }

      armIdleTimeout()
      receivedBytes += value.byteLength
      if (!Number.isSafeInteger(receivedBytes) || receivedBytes > maximumBytes) {
        value.fill(0)
        controller.abort()
        await reader.cancel().catch(() => undefined)
        throw new BoundedSourceFetchError('size-limit', 'The attachment exceeds the safe size limit')
      }
      chunks.push(value)
      onProgress?.(receivedBytes)
    }

    const bytes = new Uint8Array(receivedBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } catch (error) {
    if (timedOut) {
      throw new BoundedSourceFetchError('timeout', 'The attachment source stopped responding')
    }
    if (signal?.aborted) {
      throw new BoundedSourceFetchError('aborted', 'The file load was aborted')
    }
    if (error instanceof BoundedSourceFetchError) {
      throw error
    }
    throw new BoundedSourceFetchError(
      'network',
      error instanceof Error ? error.message : 'The file could not be loaded',
    )
  } finally {
    clearIdleTimeout()
    signal?.removeEventListener('abort', abortFromCaller)
    for (const chunk of chunks) {
      chunk.fill(0)
    }
    chunks.length = 0
    reader?.releaseLock()
  }
}
