import * as http from 'http'
import * as https from 'https'
import { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http'
import { isIP } from 'net'
import { Readable, Transform } from 'stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'

import { ResolveHost, resolveHttpUrlForOutboundConnection } from './SsrfFilter'

export interface PinnedHttpRequestOptions {
  url: string | URL
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  signal?: AbortSignal
  timeoutMs?: number
  redirect?: 'follow' | 'manual' | 'error'
  maxRedirects?: number
  decompress?: boolean
}

export interface PinnedHttpResponseBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(reason?: unknown): Promise<void> | void
    releaseLock?(): void
  }
  cancel(reason?: unknown): Promise<void> | void
}

export interface PinnedHttpResponse {
  readonly status: number
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  readonly body: PinnedHttpResponseBody
  text(): Promise<string>
  discard(): Promise<void>
  cancel(): void
}

export type PinnedRequestFactory = (
  protocol: 'http:' | 'https:',
  options: https.RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest

export interface PinnedHttpTransportOptions {
  /** Exact operator-configured origins that may resolve to private addresses. */
  allowedPrivateOrigins?: readonly string[]
}

export class PinnedHttpError extends Error {
  constructor(
    message: string,
    readonly tag: string,
  ) {
    super(message)
    this.name = 'PinnedHttpError'
  }
}

/**
 * SSRF-safe Node HTTP transport. DNS is resolved and validated once per hop;
 * the selected address is then used as the socket destination. The original
 * authority remains in Host and HTTPS SNI so virtual hosting and certificate
 * verification retain their normal security semantics.
 */
export class PinnedHttpTransport {
  private readonly allowedPrivateOrigins: ReadonlySet<string>

  constructor(
    private readonly resolveHost?: ResolveHost,
    private readonly requestFactory: PinnedRequestFactory = defaultRequestFactory,
    options: PinnedHttpTransportOptions = {},
  ) {
    this.allowedPrivateOrigins = normalizeAllowedOrigins(options.allowedPrivateOrigins)
  }

  async fetch(
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      body?: string | Uint8Array
      signal?: AbortSignal
      redirect?: 'follow' | 'manual' | 'error'
    },
  ): Promise<PinnedHttpResponse> {
    const headers = { ...init.headers }
    if (!hasHeader(headers, 'accept-encoding')) {
      headers['Accept-Encoding'] = 'gzip, deflate, br'
    }

    return this.request({
      url,
      method: init.method,
      headers,
      body: init.body,
      signal: init.signal,
      redirect: init.redirect ?? 'follow',
      maxRedirects: 5,
      decompress: true,
    })
  }

  async request(options: PinnedHttpRequestOptions): Promise<PinnedHttpResponse> {
    const lifecycle = createRequestLifecycle(options.signal, options.timeoutMs)
    const redirectMode = options.redirect ?? 'manual'
    const maxRedirects = normalizeRedirectLimit(options.maxRedirects)
    let currentUrl = asUrl(options.url)
    let method = (options.method ?? 'GET').toUpperCase()
    let headers = { ...(options.headers ?? {}) }
    let body = options.body

    try {
      for (let redirects = 0; ; redirects++) {
        const resolved = await awaitWithSignal(
          resolveHttpUrlForOutboundConnection(currentUrl.toString(), this.resolveHost, {
            allowedPrivateOrigins: this.allowedPrivateOrigins,
          }),
          lifecycle.signal,
        )
        const selectedAddress = resolved.addresses[0]
        const response = await this.requestOnce(
          resolved.url,
          selectedAddress,
          method,
          headers,
          body,
          lifecycle.signal,
          options.decompress ?? false,
        )
        const location = response.headers.get('location')
        const isRedirect = response.status >= 300 && response.status < 400 && location !== null

        if (!isRedirect || redirectMode === 'manual') {
          response.onFinished(lifecycle.cleanup)
          return response
        }
        response.cancel()

        if (redirectMode === 'error') {
          throw new PinnedHttpError('The outbound request returned a redirect.', 'redirect-not-allowed')
        }
        if (redirects >= maxRedirects) {
          throw new PinnedHttpError('The outbound request returned too many redirects.', 'too-many-redirects')
        }

        const nextUrl = redirectUrl(location, currentUrl)
        if (nextUrl.origin !== currentUrl.origin) {
          headers = stripCredentialHeaders(headers)
        }
        if (shouldRewriteToGet(response.status, method)) {
          method = 'GET'
          body = undefined
          headers = stripEntityHeaders(headers)
        }
        currentUrl = nextUrl
      }
    } catch (error) {
      lifecycle.cleanup()
      throw error
    }
  }

  private requestOnce(
    url: URL,
    selectedAddress: { address: string; family: 4 | 6 },
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
    signal: AbortSignal,
    decompress: boolean,
  ): Promise<NodePinnedHttpResponse> {
    return new Promise((resolve, reject) => {
      let settled = false
      let incoming: IncomingMessage | undefined
      let request: ClientRequest
      const requestHeaders = withOriginalHost(headers, url.host)
      const requestOptions: https.RequestOptions = {
        protocol: url.protocol,
        hostname: selectedAddress.address,
        family: selectedAddress.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
        agent: false,
      }
      if (url.protocol === 'https:') {
        requestOptions.rejectUnauthorized = true
        if (!isIP(normalizedHostname(url))) {
          requestOptions.servername = normalizedHostname(url)
        }
      }

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
      }
      const fail = (error: Error): void => {
        cleanup()
        if (incoming && !incoming.destroyed) {
          incoming.destroy(error)
        }
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      const onAbort = (): void => {
        const error = signalError(signal)
        if (incoming && !incoming.destroyed) {
          incoming.destroy(error)
        }
        if (request && !request.destroyed) {
          request.destroy(error)
        }
        fail(error)
      }

      signal.addEventListener('abort', onAbort, { once: true })
      try {
        request = this.requestFactory(url.protocol as 'http:' | 'https:', requestOptions, (response) => {
          incoming = response
          const responseHeaders = { ...response.headers }
          const bodyStream = decodedBodyStream(response, responseHeaders, decompress)
          const pinnedResponse = new NodePinnedHttpResponse(
            response.statusCode ?? 0,
            responseHeaders,
            bodyStream,
            response,
          )
          pinnedResponse.onFinished(cleanup)
          if (!settled) {
            settled = true
            resolve(pinnedResponse)
          }
        })
      } catch (error) {
        fail(error as Error)
        return
      }

      request.on('error', (error) => fail(error))
      try {
        if (body !== undefined) {
          request.write(body)
        }
        request.end()
      } catch (error) {
        request.destroy()
        fail(error as Error)
      }
    })
  }
}

class NodePinnedHttpResponse implements PinnedHttpResponse {
  private webBody?: PinnedHttpResponseBody
  private readonly finishCallbacks = new Set<() => void>()
  private finished = false

  readonly ok: boolean
  readonly headers: { get(name: string): string | null }

  constructor(
    readonly status: number,
    responseHeaders: IncomingHttpHeaders,
    private readonly bodyStream: Readable,
    private readonly incoming: IncomingMessage,
  ) {
    this.ok = status >= 200 && status < 300
    this.headers = {
      get: (name: string) => headerValue(responseHeaders, name),
    }
    const finish = (): void => this.finish()
    bodyStream.once('end', finish)
    bodyStream.once('close', finish)
    bodyStream.once('error', finish)
  }

  get body(): PinnedHttpResponseBody {
    if (!this.webBody) {
      this.webBody = Readable.toWeb(this.bodyStream) as unknown as PinnedHttpResponseBody
    }
    return this.webBody
  }

  async text(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of this.bodyStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async discard(): Promise<void> {
    for await (const _chunk of this.bodyStream) {
      // Drain without buffering so the connection can close cleanly.
    }
  }

  cancel(): void {
    if (!this.bodyStream.destroyed) {
      this.bodyStream.destroy()
    }
    if (this.bodyStream !== this.incoming && !this.incoming.destroyed) {
      this.incoming.destroy()
    }
    this.finish()
  }

  onFinished(callback: () => void): void {
    if (this.finished) {
      callback()
      return
    }
    this.finishCallbacks.add(callback)
  }

  private finish(): void {
    if (this.finished) {
      return
    }
    this.finished = true
    for (const callback of this.finishCallbacks) {
      callback()
    }
    this.finishCallbacks.clear()
  }
}

function createRequestLifecycle(
  externalSignal?: AbortSignal,
  timeoutMs?: number,
): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const onExternalAbort = (): void => controller.abort(signalError(externalSignal as AbortSignal))
  if (externalSignal?.aborted) {
    onExternalAbort()
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new PinnedHttpError('The outbound request timed out.', 'request-timeout'))
    }, timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) {
        clearTimeout(timer)
      }
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined)
    return Promise.reject(signalError(signal))
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(signalError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function signalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error('The outbound request was aborted.')
  error.name = 'AbortError'
  return error
}

/* istanbul ignore next -- thin Node adapter; security options are tested through the injectable factory. */
function defaultRequestFactory(
  protocol: 'http:' | 'https:',
  options: https.RequestOptions,
  onResponse: (response: IncomingMessage) => void,
): ClientRequest {
  return protocol === 'https:' ? https.request(options, onResponse) : http.request(options, onResponse)
}

function decodedBodyStream(incoming: IncomingMessage, headers: IncomingHttpHeaders, decompress: boolean): Readable {
  if (!decompress) {
    return incoming
  }
  const encoding = headerValue(headers, 'content-encoding')?.trim().toLowerCase()
  let decoder: Transform | undefined
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = createGunzip()
  } else if (encoding === 'deflate') {
    decoder = createInflate()
  } else if (encoding === 'br') {
    decoder = createBrotliDecompress()
  }
  if (!decoder) {
    return incoming
  }

  deleteHeader(headers, 'content-encoding')
  deleteHeader(headers, 'content-length')
  const activeDecoder = decoder
  incoming.on('error', (error) => activeDecoder.destroy(error))
  incoming.on('aborted', () => activeDecoder.destroy(new Error('The encoded response ended unexpectedly.')))
  activeDecoder.once('error', () => {
    incoming.unpipe(activeDecoder)
    if (!incoming.destroyed) {
      // The decoder already carries the original error. Destroy the encoded
      // source without re-emitting it and creating a source/decoder error loop.
      incoming.destroy()
    }
  })
  incoming.pipe(activeDecoder)
  return activeDecoder
}

function asUrl(value: string | URL): URL {
  try {
    return value instanceof URL ? new URL(value.toString()) : new URL(value)
  } catch {
    throw new PinnedHttpError('The outbound URL is malformed.', 'invalid-url')
  }
}

function normalizeAllowedOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const value of values ?? []) {
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        origins.add(url.origin)
      }
    } catch {
      // Invalid operator input remains untrusted and fails during the request.
    }
  }
  return origins
}

function redirectUrl(location: string, currentUrl: URL): URL {
  try {
    return new URL(location, currentUrl)
  } catch {
    throw new PinnedHttpError('The redirect target is malformed.', 'invalid-redirect')
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function withOriginalHost(headers: Record<string, string>, authority: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'host') {
      result[name] = value
    }
  }
  result.Host = authority
  return result
}

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!/(authorization|cookie|signature|token|secret|api[-_]?key)/i.test(name)) {
      result[name] = value
    }
  }
  return result
}

function stripEntityHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!['content-length', 'content-type', 'content-encoding'].includes(name.toLowerCase())) {
      result[name] = value
    }
  }
  return result
}

function shouldRewriteToGet(status: number, method: string): boolean {
  return (status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')
}

function normalizeRedirectLimit(value?: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function headerValue(headers: IncomingHttpHeaders, requestedName: string): string | null {
  const expected = requestedName.toLowerCase()
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== expected || value === undefined) {
      continue
    }
    return Array.isArray(value) ? value.join(', ') : String(value)
  }
  return null
}

function deleteHeader(headers: IncomingHttpHeaders, requestedName: string): void {
  const expected = requestedName.toLowerCase()
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === expected) {
      delete headers[name]
    }
  }
}

function hasHeader(headers: Record<string, string>, requestedName: string): boolean {
  const expected = requestedName.toLowerCase()
  return Object.keys(headers).some((name) => name.toLowerCase() === expected)
}
