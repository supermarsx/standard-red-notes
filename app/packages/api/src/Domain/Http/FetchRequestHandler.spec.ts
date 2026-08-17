import { Environment } from '@standardnotes/models'
import { HttpStatusCode, HttpVerb } from '@standardnotes/responses'
import { FetchRequestHandler, FETCH_REQUEST_TIMEOUT_MS, MAX_ERROR_RESPONSE_BYTES } from './FetchRequestHandler'
import { HttpErrorResponseBody, HttpRequest } from '@standardnotes/responses'

import { ErrorMessage } from '../Error'
import { LoggerInterface } from '@standardnotes/utils'

describe('FetchRequestHandler', () => {
  const snjsVersion = 'snjsVersion'
  const appVersion = 'appVersion'
  const environment = Environment.Web
  const logger: LoggerInterface = {} as jest.Mocked<LoggerInterface>
  const requestHandler = new FetchRequestHandler(snjsVersion, appVersion, environment, logger)

  it('should create a request', () => {
    const httpRequest: HttpRequest = {
      url: 'http://localhost:3000/test',
      verb: HttpVerb.Get,
      external: false,
      authentication: 'authentication',
      customHeaders: [],
      params: {
        key: 'value',
      },
    }

    const request = requestHandler['createRequest'](httpRequest)

    expect(request).toBeInstanceOf(Request)
    expect(request.url).toBe(httpRequest.url)
    expect(request.method).toBe(httpRequest.verb)
    expect(request.headers.get('X-SNJS-Version')).toBe(snjsVersion)
    expect(request.headers.get('X-Application-Version')).toBe(`${Environment[environment]}-${appVersion}`)
    expect(request.headers.get('Content-Type')).toBe('application/json')
  })

  it('should get url for url and params', () => {
    const urlWithoutExistingParams = requestHandler['urlForUrlAndParams']('url', { key: 'value' })
    expect(urlWithoutExistingParams).toBe('url?key=value')

    const urlWithExistingParams = requestHandler['urlForUrlAndParams']('url?key=value', { key2: 'value2' })
    expect(urlWithExistingParams).toBe('url?key=value&key2=value2')
  })

  it('should create request body if not GET', () => {
    const body = requestHandler['createRequestBody']({
      url: 'url',
      verb: HttpVerb.Post,
      external: false,
      authentication: 'authentication',
      customHeaders: [],
      params: {
        key: 'value',
      },
    })

    expect(body).toBe('{"key":"value"}')
  })

  it('should not create request body if GET', () => {
    const body = requestHandler['createRequestBody']({
      url: 'url',
      verb: HttpVerb.Get,
      external: false,
      authentication: 'authentication',
      customHeaders: [],
      params: {
        key: 'value',
      },
    })

    expect(body).toBeUndefined()
  })

  it('should handle json response', async () => {
    const fetchResponse = new Response('{"key":"value"}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse)

    expect(response).toEqual({
      status: 200,
      headers: new Map<string, string | null>([['content-type', 'application/json']]),
      data: {
        key: 'value',
      },
      key: 'value',
    })
  })

  it('should handle non-json response', async () => {
    const fetchResponse = new Response('body', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
      },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse)

    expect(response.status).toBe(200)
    expect(response.headers).toEqual(new Map<string, string | null>([['content-type', 'text/plain']]))
    expect(response.data).toBeInstanceOf(ArrayBuffer)
  })

  it('decodes a text error response even when binary data was requested', async () => {
    const fetchResponse = new Response('File metadata was not found.', {
      status: 400,
      headers: {
        'Content-Type': 'text/plain',
      },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse, 'arraybuffer')

    expect(response.status).toBe(400)
    expect((response.data as HttpErrorResponseBody).error).toEqual({
      message: 'File metadata was not found.',
    })
  })

  it('does not surface an HTML proxy error body', async () => {
    const fetchResponse = new Response('<html><body>proxy internals</body></html>', {
      status: 502,
      headers: {
        'Content-Type': 'text/html',
      },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse, 'arraybuffer')

    expect((response.data as HttpErrorResponseBody).error?.message).toBe('Request failed with HTTP 502.')
  })

  it('cancels and does not retain an oversized streamed error body', async () => {
    const cancel = jest.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ERROR_RESPONSE_BYTES + 1))
      },
      cancel,
    })
    const fetchResponse = new Response(stream, {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse, 'arraybuffer')

    expect(cancel).toHaveBeenCalledTimes(1)
    expect((response.data as HttpErrorResponseBody).error?.message).toBe('Request failed with HTTP 400.')
  })

  it('should have ratelimit error when forbidden', async () => {
    const fetchResponse = new Response('body', {
      status: 403,
      headers: {
        'Content-Type': 'text/plain',
      },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse)

    expect(response.status).toBe(403)
    expect(response.headers).toEqual(new Map<string, string | null>([['content-type', 'text/plain']]))
    expect((response.data as HttpErrorResponseBody).error).toEqual({
      message: ErrorMessage.RateLimited,
    })
  })

  describe('hung-socket timeout (wedge fix)', () => {
    const realFetch = global.fetch

    afterEach(() => {
      global.fetch = realFetch
      jest.useRealTimers()
    })

    it('aborts a request that never resolves and returns the network-failure result', async () => {
      jest.useFakeTimers()

      // Simulate a half-open socket: fetch never resolves on its own, only
      // rejecting (like the browser/runtime) once the AbortController fires.
      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted')
            abortError.name = 'AbortError'
            reject(abortError)
          })
        })
      }) as unknown as typeof global.fetch

      const handler = new FetchRequestHandler(snjsVersion, appVersion, environment, logger)

      const responsePromise = handler['runRequest'](new Request('http://localhost:3000/sync'))

      // Advance past the timeout so the AbortController fires.
      jest.advanceTimersByTime(FETCH_REQUEST_TIMEOUT_MS + 1)

      const response = await responsePromise

      expect(response.status).toBe(HttpStatusCode.InternalServerError)
      const data = response.data as HttpErrorResponseBody & { networkFailure?: boolean; timedOut?: boolean }
      expect(data.networkFailure).toBe(true)
      expect(data.timedOut).toBe(true)
      expect(data.error?.message).toBe('Request timed out')
    })

    it('does not abort and clears the timer when fetch resolves before the timeout', async () => {
      jest.useFakeTimers()
      const clearSpy = jest.spyOn(global, 'clearTimeout')

      global.fetch = jest.fn(
        async () =>
          new Response('{"key":"value"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ) as unknown as typeof global.fetch

      const handler = new FetchRequestHandler(snjsVersion, appVersion, environment, logger)

      const response = await handler['runRequest'](new Request('http://localhost:3000/sync'))

      expect(response.status).toBe(200)
      expect((response.data as { key?: string }).key).toBe('value')
      // Timer cleared so a finished request can never trip a late abort.
      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })

    it('uses a valid per-request timeout override', async () => {
      jest.useFakeTimers()

      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }) as unknown as typeof global.fetch

      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        timeoutMs: FETCH_REQUEST_TIMEOUT_MS * 2,
      })

      jest.advanceTimersByTime(FETCH_REQUEST_TIMEOUT_MS + 1)
      await Promise.resolve()
      expect(global.fetch).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(FETCH_REQUEST_TIMEOUT_MS)
      const response = await responsePromise
      expect((response.data as HttpErrorResponseBody & { timedOut?: boolean }).timedOut).toBe(true)
    })

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'falls back to the default timeout for invalid override %s',
      async (timeoutMs) => {
        expect(requestHandler['resolveTimeoutMs'](timeoutMs)).toBe(FETCH_REQUEST_TIMEOUT_MS)
      },
    )

    it('forwards caller cancellation to the underlying fetch without reporting a timeout', async () => {
      const controller = new AbortController()
      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }) as unknown as typeof global.fetch

      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        abortSignal: controller.signal,
      })
      controller.abort()

      const response = await responsePromise
      const data = response.data as HttpErrorResponseBody & { networkFailure?: boolean; timedOut?: boolean }
      expect(data.networkFailure).toBe(true)
      expect(data.timedOut).toBe(false)
    })
  })

  describe('should return ErrorResponse when status is not >=200 and <500', () => {
    it('should add unknown error message when response has no data', async () => {
      const fetchResponse = new Response('', {
        status: 599,
        headers: {
          'Content-Type': 'text/plain',
        },
      })

      const response = await requestHandler['handleFetchResponse'](fetchResponse)

      expect(response.status).toBe(599)
      expect(response.headers).toEqual(new Map<string, string | null>([['content-type', 'text/plain']]))
      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Request failed with HTTP 599.' })
    })
  })
})
