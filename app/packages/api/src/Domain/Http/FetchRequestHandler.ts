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
import { LoggerInterface } from '@standardnotes/utils'
import { readSharedServerAccessKey, SHARED_SERVER_ACCESS_KEY_HEADER } from './SharedServerAccessKey'

/**
 * WEDGE fix: a half-open socket (e.g. the server vanished but the TCP connection
 * was never reset) makes `fetch` hang indefinitely, which blocks sync forever with
 * no error to trigger the existing backoff/retry. We abort the request after this
 * timeout and return the same network-failure result, so the sync's existing
 * backoff/retry kicks in. The timeout is deliberately generous so it does NOT
 * prematurely abort a legitimately slow-but-progressing large upload; it only
 * fires when NOTHING has resolved within the window. The timer is cleared on
 * completion so a finished request never trips a late abort.
 */
export const FETCH_REQUEST_TIMEOUT_MS = 30_000

export class FetchRequestHandler implements RequestHandlerInterface {
  constructor(
    protected readonly snjsVersion: string,
    protected readonly appVersion: string,
    protected readonly environment: Environment,
    private logger: LoggerInterface,
  ) {}

  async handleRequest<T>(httpRequest: HttpRequest): Promise<HttpResponse<T>> {
    const request = this.createRequest(httpRequest)

    const response = await this.runRequest<T>(request, this.createRequestBody(httpRequest))

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
      credentials: 'include',
    })
  }

  private async runRequest<T>(request: Request, body?: string | Uint8Array | undefined): Promise<HttpResponse<T>> {
    const abortController = new AbortController()
    let didTimeout = false
    const timeoutId = setTimeout(() => {
      didTimeout = true
      abortController.abort()
    }, FETCH_REQUEST_TIMEOUT_MS)

    try {
      const fetchResponse = await fetch(request, {
        body: body as BodyInit | undefined,
        signal: abortController.signal,
      })

      const response = await this.handleFetchResponse<T>(fetchResponse)

      return response
    } catch (error) {
      return {
        status: HttpStatusCode.InternalServerError,
        headers: new Map<string, string | null>(),
        // `networkFailure` lets callers/telemetry distinguish an offline/timeout
        // failure from a real server-side 500. `timedOut` is set only when WE
        // aborted the request because it exceeded FETCH_REQUEST_TIMEOUT_MS. These
        // are additive, non-typed hints (HttpErrorResponseBody only declares
        // `error`), so the shape stays a valid HttpErrorResponse.
        data: {
          networkFailure: true,
          timedOut: didTimeout,
          error: {
            message: didTimeout
              ? 'Request timed out'
              : 'message' in (error as { message: string })
                ? (error as { message: string }).message
                : 'Unknown error',
          },
        } as HttpErrorResponse['data'] & { networkFailure: boolean; timedOut: boolean },
      }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async handleFetchResponse<T>(fetchResponse: Response): Promise<HttpResponse<T>> {
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

        if (contentTypeHeader?.includes('application/json')) {
          body = JSON.parse(await fetchResponse.text())
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
      this.logger.error(JSON.stringify(error))
    }

    if (httpStatus >= HttpStatusCode.Success && httpStatus < HttpStatusCode.InternalServerError) {
      if (httpStatus === HttpStatusCode.Forbidden && isErrorResponse(response)) {
        if (!response.data.error) {
          response.data.error = {
            message: ErrorMessage.RateLimited,
          }
        } else if (!response.data.error.message) {
          response.data.error.message = ErrorMessage.RateLimited
        }
      }
      return response
    } else {
      const errorResponse = response as HttpErrorResponse
      if (!errorResponse.data) {
        errorResponse.data = {
          error: {
            message: 'Unknown error',
          },
        }
      }

      if (isString(errorResponse.data)) {
        errorResponse.data = {
          error: {
            message: errorResponse.data,
          },
        }
      }

      if (!errorResponse.data.error) {
        errorResponse.data.error = {
          message: 'Unknown error',
        }
      }

      return errorResponse
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
