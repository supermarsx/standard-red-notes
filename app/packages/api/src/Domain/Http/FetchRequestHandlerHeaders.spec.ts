import { Environment } from '@standardnotes/models'
import { LoggerInterface } from '@standardnotes/utils'
import { HttpErrorResponseBody, HttpRequest, HttpStatusCode, HttpVerb } from '@standardnotes/responses'
import { ErrorMessage } from '../Error'
import { FetchRequestHandler } from './FetchRequestHandler'
import { readSharedServerAccessKey } from './SharedServerAccessKey'

jest.mock('./SharedServerAccessKey', () => ({
  SHARED_SERVER_ACCESS_KEY_HEADER: 'X-Shared-Server-Key',
  readSharedServerAccessKey: jest.fn().mockReturnValue(undefined),
}))

const readKeyMock = readSharedServerAccessKey as jest.MockedFunction<typeof readSharedServerAccessKey>

describe('FetchRequestHandler headers and response handling', () => {
  let logger: jest.Mocked<LoggerInterface>
  let handler: FetchRequestHandler

  beforeEach(() => {
    readKeyMock.mockReturnValue(undefined)
    logger = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), setLevel: jest.fn() }
    handler = new FetchRequestHandler('snjs-1', 'app-2', Environment.Web, logger)
  })

  const createRequest = (httpRequest: HttpRequest): Request =>
    (handler as unknown as { createRequest(request: HttpRequest): Request }).createRequest(httpRequest)

  const handleFetchResponse = (response: Response) =>
    (
      handler as unknown as {
        handleFetchResponse(response: Response): Promise<{ status: number; data: unknown }>
      }
    ).handleFetchResponse(response)

  describe('shared server access key header', () => {
    it('should not be sent when the operator has not configured a key', () => {
      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get })

      expect(request.headers.get('X-Shared-Server-Key')).toBeNull()
    })

    it('should not be sent when the configured key is empty', () => {
      readKeyMock.mockReturnValue('')

      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get })

      expect(request.headers.get('X-Shared-Server-Key')).toBeNull()
    })

    it('should be sent when the operator has configured a key', () => {
      readKeyMock.mockReturnValue('operator-key')

      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get })

      expect(request.headers.get('X-Shared-Server-Key')).toBe('operator-key')
    })

    it('should never be sent on an external request', () => {
      readKeyMock.mockReturnValue('operator-key')

      const request = createRequest({ url: 'https://third-party/data', verb: HttpVerb.Get, external: true })

      expect(request.headers.get('X-Shared-Server-Key')).toBeNull()
      expect(request.headers.get('X-SNJS-Version')).toBeNull()
      expect(request.headers.get('Content-Type')).toBeNull()
    })
  })

  describe('createRequest', () => {
    it('should append params to the URL for a GET', () => {
      const request = createRequest({
        url: 'https://host/v1/items',
        verb: HttpVerb.Get,
        params: { limit: 10, cursor: 'a b' },
      })

      expect(request.url).toBe('https://host/v1/items?limit=10&cursor=a%20b')
    })

    it('should append params with an ampersand when the URL already has a query', () => {
      const request = createRequest({
        url: 'https://host/v1/items?existing=1',
        verb: HttpVerb.Get,
        params: { limit: 10 },
      })

      expect(request.url).toBe('https://host/v1/items?existing=1&limit=10')
    })

    it('should not append an empty params object to the URL', () => {
      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get, params: {} })

      expect(request.url).toBe('https://host/v1/items')
    })

    it('should not append params for a POST', () => {
      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Post, params: { limit: 10 } })

      expect(request.url).toBe('https://host/v1/items')
    })

    it('should send no Authorization header without authentication', () => {
      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get })

      expect(request.headers.get('Authorization')).toBeNull()
    })

    it('should send a bearer Authorization header with authentication', () => {
      const request = createRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get, authentication: 'token' })

      expect(request.headers.get('Authorization')).toBe('Bearer token')
    })

    it('should apply custom headers', () => {
      const request = createRequest({
        url: 'https://host/v1/items',
        verb: HttpVerb.Get,
        customHeaders: [{ key: 'x-server-password', value: 'secret' }],
      })

      expect(request.headers.get('x-server-password')).toBe('secret')
      expect(request.headers.get('Content-Type')).toBe('application/json')
    })

    it('should let a custom Content-Type win over the JSON default', () => {
      const request = createRequest({
        url: 'https://host/v1/items',
        verb: HttpVerb.Post,
        customHeaders: [{ key: 'Content-Type', value: 'application/octet-stream' }],
      })

      expect(request.headers.get('Content-Type')).toBe('application/octet-stream')
    })
  })

  describe('createRequestBody', () => {
    const createRequestBody = (httpRequest: HttpRequest) =>
      (
        handler as unknown as {
          createRequestBody(request: HttpRequest): string | Uint8Array | undefined
        }
      ).createRequestBody(httpRequest)

    it('should serialise params for PUT, PATCH and DELETE as well as POST', () => {
      for (const verb of [HttpVerb.Post, HttpVerb.Put, HttpVerb.Patch, HttpVerb.Delete]) {
        expect(createRequestBody({ url: 'u', verb, params: { key: 'value' } })).toBe('{"key":"value"}')
      }
    })

    it('should fall back to raw bytes when there are no params', () => {
      const rawBytes = new Uint8Array([1, 2, 3])

      expect(createRequestBody({ url: 'u', verb: HttpVerb.Post, rawBytes })).toBe(rawBytes)
    })
  })

  describe('handleFetchResponse', () => {
    it('should leave the data empty for a 204 without reading the body', async () => {
      const response = await handleFetchResponse(new Response(null, { status: HttpStatusCode.NoContent }))

      expect(response.status).toBe(HttpStatusCode.NoContent)
      expect(response.data).toEqual({})
    })

    it('should keep an explicit top-level data object rather than nesting it again', async () => {
      const response = await handleFetchResponse(
        new Response('{"data":{"key":"value"},"meta":{"auth":{}}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      expect(response.data).toEqual({ key: 'value' })
    })

    it('should log and continue when the JSON body is malformed', async () => {
      const response = await handleFetchResponse(
        new Response('not json at all', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )

      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(200)
      expect(response.data).toEqual({})
    })

    it('should fill in the rate-limit message for a 403 whose error has no message', async () => {
      const response = await handleFetchResponse(
        new Response('{"error":{}}', { status: 403, headers: { 'Content-Type': 'application/json' } }),
      )

      expect((response.data as HttpErrorResponseBody).error?.message).toBe(ErrorMessage.RateLimited)
    })

    it('should keep an existing 403 error message', async () => {
      const response = await handleFetchResponse(
        new Response('{"error":{"message":"Captcha required"}}', {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      expect((response.data as HttpErrorResponseBody).error?.message).toBe('Captcha required')
    })

    it('should synthesise an unknown error for a 5xx whose data is null', async () => {
      const response = await handleFetchResponse(
        new Response('{"data":null}', { status: 503, headers: { 'Content-Type': 'application/json' } }),
      )

      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Unknown error' })
    })

    it('should wrap a string 5xx body as the error message', async () => {
      const response = await handleFetchResponse(
        new Response('"Service unavailable"', { status: 503, headers: { 'Content-Type': 'application/json' } }),
      )

      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Service unavailable' })
    })

    it('should synthesise an unknown error for a 5xx whose data has no error key', async () => {
      const response = await handleFetchResponse(
        new Response('{"detail":"boom"}', { status: 503, headers: { 'Content-Type': 'application/json' } }),
      )

      expect((response.data as HttpErrorResponseBody).error).toEqual({ message: 'Unknown error' })
    })
  })

  describe('handleRequest', () => {
    const realFetch = global.fetch

    afterEach(() => {
      global.fetch = realFetch
    })

    it('should send the built request and body and return the parsed response', async () => {
      const fetchMock = jest.fn(
        async () => new Response('{"key":"value"}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      global.fetch = fetchMock as unknown as typeof global.fetch

      const response = await handler.handleRequest({
        url: 'https://host/v1/items',
        verb: HttpVerb.Post,
        params: { key: 'value' },
      })

      expect(response.status).toBe(200)
      expect(response.data).toEqual({ key: 'value' })
      const [request, init] = fetchMock.mock.calls[0] as unknown as [Request, RequestInit]
      expect(request.url).toBe('https://host/v1/items')
      expect(init.body).toBe('{"key":"value"}')
    })

    it('should report a network failure that is not a timeout', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Failed to fetch')) as unknown as typeof global.fetch

      const response = await handler.handleRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get })

      expect(response.status).toBe(HttpStatusCode.InternalServerError)
      const data = response.data as HttpErrorResponseBody & { networkFailure: boolean; timedOut: boolean }
      expect(data.networkFailure).toBe(true)
      expect(data.timedOut).toBe(false)
      expect(data.error?.message).toBe('Failed to fetch')
    })

    it('should report "Unknown error" when the rejection carries no message', async () => {
      global.fetch = jest.fn().mockRejectedValue({}) as unknown as typeof global.fetch

      const response = await handler.handleRequest({ url: 'https://host/v1/items', verb: HttpVerb.Get })

      expect((response.data as HttpErrorResponseBody).error?.message).toBe('Unknown error')
    })
  })
})
