import {
  HttpErrorResponse,
  HttpRequest,
  HttpRequestParams,
  HttpResponse,
  HttpStatusCode,
  HttpVerb,
  isErrorResponse,
} from '@standardnotes/responses'
import { RequestHandlerInterface } from './RequestHandlerInterface'
import { Environment } from '@standardnotes/models'
import { isString } from 'lodash'
import { ErrorMessage } from '../Error'
import { LoggerInterface, safeErrorLogMetadata } from '@standardnotes/utils'
import { readSharedServerAccessKey, SHARED_SERVER_ACCESS_KEY_HEADER } from './SharedServerAccessKey'

/**
 * WEDGE fix: a half-open socket (e.g. the server vanished but the TCP connection
 * was never reset) makes `fetch` hang indefinitely, which blocks sync forever with
 * no error to trigger the existing backoff/retry. We abort the request after this
 * timeout and return the same network-failure result, so the sync's existing
 * backoff/retry kicks in. Large bounded transfers can provide a longer
 * `timeoutMs`; the timer is cleared on completion so a finished request never
 * trips a late abort.
 */
export const FETCH_REQUEST_TIMEOUT_MS = 30_000
export const MAX_ERROR_RESPONSE_BYTES = 8 * 1024

function stripUnsafeControlCharacters(value: string): string {
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    if ((code >= 0x20 && code !== 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d) {
      result += character
    }
  }
  return result
}

export class FetchRequestHandler implements RequestHandlerInterface {
  constructor(
    protected readonly snjsVersion: string,
    protected readonly appVersion: string,
    protected readonly environment: Environment,
    private logger: LoggerInterface,
  ) {}

  async handleRequest<T>(httpRequest: HttpRequest): Promise<HttpResponse<T>> {
    const request = this.createRequest(httpRequest)

    const response = await this.runRequest<T>(
      request,
      this.createRequestBody(httpRequest),
      this.resolveTimeoutMs(httpRequest.timeoutMs),
      httpRequest.responseType,
      httpRequest.abortSignal,
    )

    return response
  }

  private createRequest(httpRequest: HttpRequest): Request {
    if (httpRequest.params && httpRequest.verb === HttpVerb.Get && Object.keys(httpRequest.params).length > 0) {
      httpRequest.url = this.urlForUrlAndParams(httpRequest.url, httpRequest.params)
    }

    const headers: Record<string, string> = {}

    if (!httpRequest.external) {
      headers['X-SNJS-Version'] = this.snjsVersion

      const appVersionHeaderValue = `${Environment[this.environment]}-${this.appVersion}`
      headers['X-Application-Version'] = appVersionHeaderValue

      if (httpRequest.authentication) {
        headers['Authorization'] = 'Bearer ' + httpRequest.authentication
      }

      // Standard Red Notes: if the operator's self-hosted instance is gated by a
      // server-wide shared access key, attach it to every (non-external) request
      // so the official client can pass the gate. This is per-device operator
      // config stored locally (NOT a synced item) and is OBFUSCATION/access-
      // gating, not E2E security. When unset, no header is sent and behavior is
      // identical to upstream.
      const sharedServerAccessKey = readSharedServerAccessKey()
      if (sharedServerAccessKey !== undefined && sharedServerAccessKey.length > 0) {
        headers[SHARED_SERVER_ACCESS_KEY_HEADER] = sharedServerAccessKey
      }
    }

    let contentTypeIsSet = false
    if (httpRequest.customHeaders && httpRequest.customHeaders.length > 0) {
      httpRequest.customHeaders.forEach(({ key, value }) => {
        headers[key] = value
        if (key === 'Content-Type') {
          contentTypeIsSet = true
        }
      })
    }
    if (!contentTypeIsSet && !httpRequest.external) {
      headers['Content-Type'] = 'application/json'
    }

    return new Request(httpRequest.url, {
      method: httpRequest.verb,
      headers,
      credentials: httpRequest.external ? 'omit' : 'include',
    })
  }

  private async runRequest<T>(
    request: Request,
    body?: string | Uint8Array | undefined,
    timeoutMs = FETCH_REQUEST_TIMEOUT_MS,
    responseType?: XMLHttpRequestResponseType,
    callerSignal?: AbortSignal,
  ): Promise<HttpResponse<T>> {
    const abortController = new AbortController()
    let didTimeout = false
    let abortedByCaller = false
    const abortFromCaller = () => {
      if (abortController.signal.aborted) {
        return
      }

      abortedByCaller = true
      abortController.abort(callerSignal?.reason)
    }
    if (callerSignal?.aborted) {
      abortFromCaller()
    } else {
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    }
    const timeoutId = setTimeout(() => {
      if (abortController.signal.aborted) {
        return
      }

      didTimeout = true
      abortController.abort()
    }, timeoutMs)

    try {
      const fetchResponse = await fetch(request, {
        body: body as BodyInit | undefined,
        signal: abortController.signal,
      })

      const response = await this.handleFetchResponse<T>(fetchResponse, responseType, abortController.signal)

      return response
    } catch (error) {
      // A caller cancellation is control flow, not a server or connectivity
      // failure. Propagating the AbortSignal reason also prevents downstream
      // file-download code from constructing/logging a ClientDisplayableError
      // after its own abort race has already completed normally.
      if (abortedByCaller) {
        if (callerSignal?.reason !== undefined) {
          throw callerSignal.reason
        }

        throw error
      }

      return {
        status: HttpStatusCode.InternalServerError,
        headers: new Map<string, string | null>(),
        // `networkFailure` lets callers/telemetry distinguish an offline/timeout
        // failure from a real server-side 500. `timedOut` is set only when WE
        // aborted the request because it exceeded the request's deadline. These
        // are additive, non-typed hints (HttpErrorResponseBody only declares
        // `error`), so the shape stays a valid HttpErrorResponse.
        data: {
          networkFailure: true,
          timedOut: didTimeout,
          error: {
            message: didTimeout ? 'Request timed out' : 'Network request failed',
          },
        } as HttpErrorResponse['data'] & { networkFailure: boolean; timedOut: boolean },
      }
    } finally {
      clearTimeout(timeoutId)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
  }

  private async handleFetchResponse<T>(
    fetchResponse: Response,
    responseType?: XMLHttpRequestResponseType,
    requestSignal?: AbortSignal,
  ): Promise<HttpResponse<T>> {
    const httpStatus = fetchResponse.status
    const response: HttpResponse<T> = {
      status: httpStatus,
      headers: new Map<string, string | null>(),
      data: {} as T,
    }
    fetchResponse.headers.forEach((value, key) => {
      ;(<Map<string, string | null>>response.headers).set(key, value)
    })

    try {
      if (httpStatus !== HttpStatusCode.NoContent) {
        let body

        const contentTypeHeader = response.headers?.get('content-type') || response.headers?.get('Content-Type')

        if (httpStatus >= HttpStatusCode.BadRequest) {
          body = await this.decodeBoundedErrorBody(fetchResponse, contentTypeHeader, httpStatus)
        } else if (contentTypeHeader?.includes('application/json')) {
          body = JSON.parse(await fetchResponse.text())
        } else if (responseType === 'text') {
          body = await fetchResponse.text()
        } else {
          body = await fetchResponse.arrayBuffer()
        }
        /**
         * v0 APIs do not have a `data` top-level object. In such cases, mimic
         * the newer response body style by putting all the top-level
         * properties inside a `data` object.
         */
        if (!body.data) {
          response.data = body
        }
        if (!isString(body)) {
          Object.assign(response, body)
        }
      }
    } catch (error) {
      if (requestSignal?.aborted) {
        throw error
      }

      this.logger.error('Could not parse HTTP response body', safeErrorLogMetadata(error))
    }

    if (httpStatus >= HttpStatusCode.BadRequest && httpStatus !== HttpStatusCode.Forbidden) {
      this.normalizeErrorResponse(response as HttpErrorResponse)
    }

    if (httpStatus >= HttpStatusCode.Success && httpStatus < HttpStatusCode.InternalServerError) {
      if (httpStatus === HttpStatusCode.Forbidden && isErrorResponse(response)) {
        const forbiddenResponse = response as HttpErrorResponse
        if (isString(forbiddenResponse.data) || !forbiddenResponse.data?.error) {
          forbiddenResponse.data = {
            error: {
              message: ErrorMessage.RateLimited,
            },
          }
        } else if (!forbiddenResponse.data.error.message) {
          forbiddenResponse.data.error.message = ErrorMessage.RateLimited
        }
      }
      return response
    } else {
      const errorResponse = response as HttpErrorResponse
      this.normalizeErrorResponse(errorResponse)

      return errorResponse
    }
  }

  private normalizeErrorResponse(errorResponse: HttpErrorResponse): void {
    if (!errorResponse.data) {
      errorResponse.data = {
        error: {
          message: 'Unknown error',
        },
      }
      return
    }

    if (isString(errorResponse.data)) {
      errorResponse.data = {
        error: {
          message: errorResponse.data,
        },
      }
      return
    }

    if (!errorResponse.data.error) {
      errorResponse.data.error = {
        message: 'Unknown error',
      }
    }
  }

  private urlForUrlAndParams(url: string, params: HttpRequestParams) {
    const keyValueString = Object.keys(params as Record<string, unknown>)
      .map((key) => {
        return key + '=' + encodeURIComponent((params as Record<string, unknown>)[key] as string)
      })
      .join('&')

    if (url.includes('?')) {
      return url + '&' + keyValueString
    } else {
      return url + '?' + keyValueString
    }
  }

  private resolveTimeoutMs(timeoutMs?: number): number {
    if (timeoutMs === undefined) {
      return FETCH_REQUEST_TIMEOUT_MS
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return FETCH_REQUEST_TIMEOUT_MS
    }

    return timeoutMs
  }

  private safeNonJsonErrorMessage(rawBody: string, contentType: string | null | undefined, status: number): string {
    const trimmedBody = rawBody.trim()
    const looksLikeHtml =
      contentType?.toLowerCase().includes('text/html') || /^\s*<(?:!doctype|html|head|body)\b/i.test(rawBody)

    if (!trimmedBody || looksLikeHtml) {
      return `Request failed with HTTP ${status}.`
    }

    // Do not let a proxy reflect an unbounded or control-character-heavy body
    // into a user-facing toast/log. Plain server messages remain actionable.
    return stripUnsafeControlCharacters(trimmedBody).slice(0, 1_000)
  }

  private async decodeBoundedErrorBody(
    response: Response,
    contentType: string | null | undefined,
    status: number,
  ): Promise<unknown> {
    const normalizedContentType = contentType?.split(';', 1)[0].trim().toLowerCase() ?? ''
    const isJson = normalizedContentType === 'application/json' || normalizedContentType.endsWith('+json')
    const isPlainText = normalizedContentType === 'text/plain' && status < HttpStatusCode.InternalServerError

    // Error bodies from binary/file proxies are untrusted. Do not drain HTML,
    // binary, or other unexpected bodies into memory just to report an error.
    if (!isJson && !isPlainText) {
      await response.body?.cancel().catch(() => undefined)
      return `Request failed with HTTP ${status}.`
    }

    const boundedBody = await this.readBoundedResponseText(response)
    if (boundedBody.exceededLimit) {
      return `Request failed with HTTP ${status}.`
    }

    if (isJson) {
      try {
        return JSON.parse(boundedBody.text)
      } catch {
        return `Request failed with HTTP ${status}.`
      }
    }

    return this.safeNonJsonErrorMessage(boundedBody.text, normalizedContentType, status)
  }

  private async readBoundedResponseText(response: Response): Promise<{ text: string; exceededLimit: boolean }> {
    if (!response.body) {
      return { text: '', exceededLimit: false }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const textChunks: string[] = []
    let receivedBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          textChunks.push(decoder.decode())
          return { text: textChunks.join(''), exceededLimit: false }
        }

        receivedBytes += value.byteLength
        if (!Number.isSafeInteger(receivedBytes) || receivedBytes > MAX_ERROR_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined)
          return { text: '', exceededLimit: true }
        }

        textChunks.push(decoder.decode(value, { stream: true }))
      }
    } finally {
      reader.releaseLock()
    }
  }

  private createRequestBody(httpRequest: HttpRequest): string | Uint8Array | undefined {
    if (
      httpRequest.params !== undefined &&
      [HttpVerb.Post, HttpVerb.Put, HttpVerb.Patch, HttpVerb.Delete].includes(httpRequest.verb)
    ) {
      return JSON.stringify(httpRequest.params)
    }

    return httpRequest.rawBytes
  }
}
