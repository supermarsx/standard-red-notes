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

  it('decodes a successful body as a string when the caller requests a text response', async () => {
    // Same content type as the ArrayBuffer case above; only `responseType`
    // differs, so this pins the branch rather than the content negotiation.
    const fetchResponse = new Response('a plain text payload', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
      },
    })

    const response = await requestHandler['handleFetchResponse'](fetchResponse, 'text')

    expect(response.status).toBe(200)
    expect(response.data).toBe('a plain text payload')
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

    it('reports a timeout that fires while the response body is being consumed', async () => {
      jest.useFakeTimers()
      const errorLog = jest.fn()
      const handler = new FetchRequestHandler(snjsVersion, appVersion, environment, {
        error: errorLog,
      } as unknown as LoggerInterface)

      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return Promise.resolve({
          status: HttpStatusCode.Success,
          headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
            }),
        } as Response)
      }) as unknown as typeof global.fetch

      const responsePromise = handler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        responseType: 'arraybuffer',
        timeoutMs: 100,
      })
      await Promise.resolve()
      jest.advanceTimersByTime(101)

      const response = await responsePromise
      expect(response.status).toBe(HttpStatusCode.InternalServerError)
      expect(response.data).toMatchObject({
        networkFailure: true,
        timedOut: true,
        error: { message: 'Request timed out' },
      })
      expect(errorLog).not.toHaveBeenCalled()
    })

    it('preserves caller cancellation as a rejected abort instead of a network failure response', async () => {
      const controller = new AbortController()
      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }) as unknown as typeof global.fetch

      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        abortSignal: controller.signal,
      })
      controller.abort()

      await expect(responsePromise).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('preserves caller cancellation while the response body is being consumed', async () => {
      const controller = new AbortController()
      let bodyReadStarted!: () => void
      const bodyReadIsStarted = new Promise<void>((resolve) => {
        bodyReadStarted = resolve
      })
      const errorLog = jest.fn()
      const handler = new FetchRequestHandler(snjsVersion, appVersion, environment, {
        error: errorLog,
      } as unknown as LoggerInterface)

      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return Promise.resolve({
          status: HttpStatusCode.Success,
          headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
          arrayBuffer: () => {
            bodyReadStarted()
            return new Promise<ArrayBuffer>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
            })
          },
        } as Response)
      }) as unknown as typeof global.fetch

      const responsePromise = handler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        responseType: 'arraybuffer',
        abortSignal: controller.signal,
      })
      await bodyReadIsStarted
      controller.abort()

      await expect(responsePromise).rejects.toMatchObject({ name: 'AbortError' })
      expect(errorLog).not.toHaveBeenCalled()
    })

    /**
     * A faithful stand-in for the runtime's `fetch`: it rejects immediately when
     * handed an already-aborted signal, and otherwise only settles when the
     * signal fires. Anything else never settles, which is the half-open socket
     * the wedge fix exists for.
     */
    const fetchThatOnlySettlesOnAbort = () =>
      jest.fn((_request: Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) {
            reject(signal.reason)

            return
          }

          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }) as unknown as typeof global.fetch

    it('rejects with the caller reason when the signal is already aborted before the request starts', async () => {
      // An abort that lands before the handler runs (e.g. the download was
      // cancelled while an earlier chunk was still in flight) must still cancel
      // this request: an already-aborted signal never re-fires 'abort', so
      // subscribing alone would leave the request hanging until the deadline.
      const controller = new AbortController()
      const reason = new Error('caller cancelled before dispatch')
      controller.abort(reason)

      global.fetch = fetchThatOnlySettlesOnAbort()

      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        abortSignal: controller.signal,
        // Short deadline so a regression surfaces as a timed-out response
        // rather than as a 30s hang.
        timeoutMs: 50,
      })

      await expect(responsePromise).rejects.toBe(reason)
    })

    it('keeps a timed-out request a network failure even when the caller aborts immediately after', async () => {
      jest.useFakeTimers()
      global.fetch = fetchThatOnlySettlesOnAbort()

      const controller = new AbortController()
      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/sync',
        verb: HttpVerb.Get,
        abortSignal: controller.signal,
        timeoutMs: 100,
      })
      await Promise.resolve()

      // The deadline wins the race, then the caller gives up too. The late
      // cancellation must not reclassify an already-aborted request as caller
      // control flow, or sync loses the timedOut hint that drives its backoff.
      jest.advanceTimersByTime(101)
      controller.abort(new Error('caller cancelled after the deadline'))

      const response = await responsePromise

      expect(response.status).toBe(HttpStatusCode.InternalServerError)
      expect(response.data).toMatchObject({
        networkFailure: true,
        timedOut: true,
        error: { message: 'Request timed out' },
      })
    })

    it('keeps a caller cancellation a rejection when the deadline elapses right after it', async () => {
      jest.useFakeTimers()
      global.fetch = fetchThatOnlySettlesOnAbort()

      const controller = new AbortController()
      const reason = new Error('caller cancelled first')
      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/sync',
        verb: HttpVerb.Get,
        abortSignal: controller.signal,
        timeoutMs: 100,
      })
      await Promise.resolve()

      controller.abort(reason)
      jest.advanceTimersByTime(101)

      await expect(responsePromise).rejects.toBe(reason)
    })

    it('rethrows the underlying error when the caller signal carries no abort reason', async () => {
      // `AbortSignal.reason` postdates the original spec, so a polyfilled or
      // shimmed signal can abort with no reason at all. Throwing `undefined`
      // there would leave callers with an unloggable, uncatchable failure.
      const abortListeners: Array<() => void> = []
      const reasonlessSignal = {
        aborted: false,
        reason: undefined,
        addEventListener: (_type: string, listener: () => void) => {
          abortListeners.push(listener)
        },
        removeEventListener: () => undefined,
      } as unknown as AbortSignal

      const fetchError = new Error('request cancelled by the runtime')
      global.fetch = jest.fn((_request: Request, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(fetchError), { once: true })
        })
      }) as unknown as typeof global.fetch

      const responsePromise = requestHandler.handleRequest({
        url: 'http://localhost:3000/files',
        verb: HttpVerb.Get,
        abortSignal: reasonlessSignal,
      })
      await Promise.resolve()

      expect(abortListeners).toHaveLength(1)
      abortListeners.forEach((listener) => listener())

      await expect(responsePromise).rejects.toBe(fetchError)
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

  describe('bounded error-body decoding', () => {
    // These bodies are all decoded deliberately, so nothing may reach the
    // generic "could not parse" catch in handleFetchResponse. A logger that
    // fires here means the fallback was an accident, not a decision.
    let errorLog: jest.Mock
    let handler: FetchRequestHandler

    beforeEach(() => {
      errorLog = jest.fn()
      handler = new FetchRequestHandler(snjsVersion, appVersion, environment, {
        error: errorLog,
      } as unknown as LoggerInterface)
    })

    it('falls back to a generic message when a JSON error body is truncated', async () => {
      // A proxy that cuts the response short still advertises application/json.
      const fetchResponse = new Response('{"error":{"message":"upstream ti', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })

      const response = await handler['handleFetchResponse'](fetchResponse)

      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Request failed with HTTP 500.' })
      expect(errorLog).not.toHaveBeenCalled()
    })

    it('reports a bodyless error response without reading a stream that does not exist', async () => {
      const fetchResponse = new Response(null, {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      })
      expect(fetchResponse.body).toBeNull()

      const response = await handler['handleFetchResponse'](fetchResponse, 'arraybuffer')

      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Request failed with HTTP 400.' })
      expect(errorLog).not.toHaveBeenCalled()
    })

    it('does not reflect an HTML error page that a proxy mislabelled as text/plain', async () => {
      // The content type says text/plain, so only the body sniff can catch this.
      const fetchResponse = new Response('  <!doctype html><html><body>upstream 10.0.0.4 refused</body></html>', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })

      const response = await handler['handleFetchResponse'](fetchResponse, 'arraybuffer')

      const message = (response.data as HttpErrorResponseBody).error?.message
      expect(message).toBe('Request failed with HTTP 400.')
      expect(message).not.toContain('10.0.0.4')
      expect(errorLog).not.toHaveBeenCalled()
    })

    it('falls back to a generic message when a plain-text error body is only whitespace', async () => {
      const fetchResponse = new Response('  \n\t  ', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      })

      const response = await handler['handleFetchResponse'](fetchResponse, 'arraybuffer')

      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Request failed with HTTP 400.' })
      expect(errorLog).not.toHaveBeenCalled()
    })
  })
})
