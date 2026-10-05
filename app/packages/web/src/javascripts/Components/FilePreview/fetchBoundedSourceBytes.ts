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

/**
 * True only for a source an attachment renderer may put in an `<img>`/`<video>`
 * `src`, or hand to the reader below.
 *
 * Pasted and imported HTML is the reason this exists. A `<img src="file:///…">`
 * — which Word, Outlook and Windows Explorer all place in the `text/html`
 * clipboard flavour — is refused outright by the browser on an https page
 * ("Security Error: Content at https://… may not load or link to file:///…"),
 * so a node must never be built around one, and an already-saved one must never
 * reach the DOM.
 */
export function isRenderableAttachmentSource(source: string): boolean {
  try {
    const url = new URL(source, globalThis.location?.href ?? 'https://local.invalid/')
    return AllowedSourceProtocols.has(url.protocol)
  } catch {
    return false
  }
}

function validateSource(source: string): void {
  if (!isRenderableAttachmentSource(source)) {
    throw new BoundedSourceFetchError('invalid-source', 'The file source is not safe to load')
  }
}

/**
 * Decodes a `data:` URL without going through `fetch`.
 *
 * `fetch('data:…')` is governed by CSP `connect-src`, and a hardened policy
 * (the one this app ships: `connect-src 'self' https: …`) does not list `data:`.
 * The request is then blocked, and the violation report prints the ENTIRE data
 * URL — a whole base64 image — into the console, while the preview and the
 * "save to Files" action both fail. Nothing is fetched from the network for a
 * data URL anyway, so decode it here and depend on no policy at all.
 */
export function decodeDataUrlBytes(source: string, maximumBytes: number): Uint8Array {
  const normalized = source.trimStart()
  if (!normalized.toLowerCase().startsWith('data:')) {
    throw new BoundedSourceFetchError('invalid-source', 'The file source is not safe to load')
  }
  return decodeDataUrl(normalized, maximumBytes)
}

function decodeDataUrl(source: string, maximumBytes: number): Uint8Array {
  const separator = source.indexOf(',')
  if (separator === -1) {
    throw new BoundedSourceFetchError('invalid-source', 'The file source is not safe to load')
  }

  const metadata = source.slice('data:'.length, separator)
  const payload = source.slice(separator + 1)
  const isBase64 = /;base64(?:;|$)/i.test(metadata)

  if (!isBase64) {
    // Percent-encoded (the only other data-URL form). `decodeURIComponent`
    // yields the raw code units, each of which is one byte here.
    let decoded: string
    try {
      decoded = decodeURIComponent(payload)
    } catch {
      throw new BoundedSourceFetchError('invalid-source', 'The file source is not safe to load')
    }
    if (decoded.length > maximumBytes) {
      throw new BoundedSourceFetchError('size-limit', 'The attachment exceeds the safe size limit')
    }
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0) & 0xff)
  }

  const encoded = payload.replace(/\s/g, '')
  // 4 base64 characters carry 3 bytes. Refuse an oversized payload before
  // allocating anything, rather than after.
  if (Math.floor(encoded.length / 4) * 3 > maximumBytes + 3) {
    throw new BoundedSourceFetchError('size-limit', 'The attachment exceeds the safe size limit')
  }

  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    throw new BoundedSourceFetchError('invalid-source', 'The file source is not safe to load')
  }

  if (binary.length > maximumBytes) {
    throw new BoundedSourceFetchError('size-limit', 'The attachment exceeds the safe size limit')
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
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

  if (source.trimStart().toLowerCase().startsWith('data:')) {
    const bytes = decodeDataUrl(source.trimStart(), maximumBytes)
    if (signal?.aborted) {
      bytes.fill(0)
      throw new BoundedSourceFetchError('aborted', 'The file load was aborted')
    }
    onProgress?.(bytes.byteLength)
    return bytes
  }

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
