import type { AxiosInstance } from 'axios'

import { HttpFilesServiceStorage } from './HttpFilesServiceStorage'
import type { MultiContainerFileStorageTarget } from './MultiContainerSyncFilesAdapter'

type RequestConfig = {
  method: string
  url: string
  headers: Record<string, string>
  data?: unknown
  responseType?: string
  signal?: AbortSignal
  timeout?: number
  maxContentLength?: number
}

type StubResponse = {
  status: number
  data?: unknown
  headers?: Record<string, string>
}

const PERSONAL_TARGET: MultiContainerFileStorageTarget = {
  ownershipType: 'user',
  storageOwnerUuid: 'user-1',
  remoteIdentifier: 'resource-1',
  valetToken: 'valet.token.1',
}

const SHARED_TARGET: MultiContainerFileStorageTarget = {
  ownershipType: 'shared-vault',
  storageOwnerUuid: 'vault-1',
  remoteIdentifier: 'resource-2',
  valetToken: 'valet.token.2',
}

class FakeHttpClient {
  requests: RequestConfig[] = []
  responses: StubResponse[] = []
  throwOnRequest?: Error

  request = async (config: RequestConfig): Promise<unknown> => {
    this.requests.push(config)
    if (this.throwOnRequest) {
      throw this.throwOnRequest
    }
    const next = this.responses.shift() ?? { status: 200, data: { success: true } }
    return { status: next.status, data: next.data, headers: next.headers ?? {} }
  }
}

function build(responses: StubResponse[] = []) {
  const httpClient = new FakeHttpClient()
  httpClient.responses = responses
  const storage = new HttpFilesServiceStorage({
    filesServerUrl: 'http://files:3000/',
    httpClient: httpClient as unknown as Pick<AxiosInstance, 'request'>,
  })
  return { httpClient, storage }
}

const signal = (): AbortSignal => new AbortController().signal

async function codeOf(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message
  }
  throw new Error('Expected the operation to reject.')
}

describe('HttpFilesServiceStorage', () => {
  describe('construction', () => {
    it('requires an internal files service URL', () => {
      expect(
        () =>
          new HttpFilesServiceStorage({
            filesServerUrl: '',
            httpClient: new FakeHttpClient() as unknown as Pick<AxiosInstance, 'request'>,
          }),
      ).toThrow()
    })

    it('rejects an implausibly short request timeout', () => {
      expect(
        () =>
          new HttpFilesServiceStorage({
            filesServerUrl: 'http://files:3000',
            httpClient: new FakeHttpClient() as unknown as Pick<AxiosInstance, 'request'>,
            requestTimeoutMs: 10,
          }),
      ).toThrow()
    })

    it('is ready only while its readiness probe agrees', () => {
      let live = true
      const storage = new HttpFilesServiceStorage({
        filesServerUrl: 'http://files:3000',
        httpClient: new FakeHttpClient() as unknown as Pick<AxiosInstance, 'request'>,
        isReady: () => live,
      })
      expect(storage.ready()).toBe(true)
      live = false
      expect(storage.ready()).toBe(false)
    })
  })

  describe('credentials', () => {
    it('carries the valet credential in a header and never in the URL', async () => {
      const { httpClient, storage } = build([
        { status: 206, data: new ArrayBuffer(1), headers: { 'content-range': 'bytes 0-0/900' } },
      ])

      await storage.probeSize(PERSONAL_TARGET, signal())

      const [request] = httpClient.requests
      expect(request.headers['x-valet-token']).toBe('valet.token.1')
      expect(request.url).toBe('http://files:3000/v1/files/')
      expect(request.url).not.toContain('valet.token.1')
    })

    it('routes shared-vault resources to the shared-vault surface', async () => {
      const { httpClient, storage } = build([
        { status: 206, data: new ArrayBuffer(1), headers: { 'content-range': 'bytes 0-0/900' } },
      ])

      await storage.probeSize(SHARED_TARGET, signal())

      expect(httpClient.requests[0].url).toBe('http://files:3000/v1/shared-vault/files/')
      expect(httpClient.requests[0].headers['x-valet-token']).toBe('valet.token.2')
    })

    it('never sends the storage owner it was told about', async () => {
      const { httpClient, storage } = build([{ status: 200, data: { success: true } }])
      await storage.createUploadSession(PERSONAL_TARGET, signal())
      expect(JSON.stringify(httpClient.requests[0])).not.toContain('user-1')
    })
  })

  describe('probeSize', () => {
    it('reads the total size from the content range of a single-byte probe', async () => {
      const { httpClient, storage } = build([
        { status: 206, data: new ArrayBuffer(1), headers: { 'content-range': 'bytes 0-0/4096' } },
      ])

      expect(await storage.probeSize(PERSONAL_TARGET, signal())).toBe(4096)
      expect(httpClient.requests[0].headers.range).toBe('bytes=0-0')
      expect(httpClient.requests[0].headers['x-chunk-size']).toBe('1')
    })

    it('reports a missing resource as absent rather than as a failure', async () => {
      const { storage } = build([{ status: 404, data: { error: { message: 'not found' } } }])
      expect(await storage.probeSize(PERSONAL_TARGET, signal())).toBeUndefined()
    })

    it('reads the size of an empty resource from an unsatisfiable range', async () => {
      const { storage } = build([{ status: 416, headers: { 'content-range': 'bytes */0' } }])
      expect(await storage.probeSize(PERSONAL_TARGET, signal())).toBe(0)
    })

    it('fails when the content range is missing or unparseable', async () => {
      const { storage } = build([{ status: 206, data: new ArrayBuffer(1), headers: {} }])
      expect(await codeOf(storage.probeSize(PERSONAL_TARGET, signal()))).toBe('FILE_BACKEND_ERROR')
    })
  })

  describe('upload', () => {
    it('creates a session and requires the service to confirm it', async () => {
      const { httpClient, storage } = build([{ status: 200, data: { success: true, uploadId: 'upload-1' } }])
      await storage.createUploadSession(PERSONAL_TARGET, signal())
      expect(httpClient.requests[0]).toMatchObject({
        method: 'POST',
        url: 'http://files:3000/v1/files/upload/create-session',
      })
    })

    it('sends a part as an octet stream tagged with its part number', async () => {
      const { httpClient, storage } = build([{ status: 200, data: { success: true } }])
      const bytes = Buffer.alloc(64, 3)

      await storage.uploadPart({ target: PERSONAL_TARGET, partNumber: 2, bytes }, signal())

      const [request] = httpClient.requests
      expect(request.url).toBe('http://files:3000/v1/files/upload/chunk')
      expect(request.headers['x-chunk-id']).toBe('2')
      expect(request.headers['content-type']).toBe('application/octet-stream')
      expect(Buffer.from(request.data as Buffer)).toEqual(bytes)
    })

    it.each([
      ['a zero part number', { partNumber: 0, bytes: Buffer.alloc(4) }],
      ['a fractional part number', { partNumber: 1.5, bytes: Buffer.alloc(4) }],
      ['an empty part', { partNumber: 1, bytes: Buffer.alloc(0) }],
    ])('refuses to send %s', async (_label, patch) => {
      const { httpClient, storage } = build()
      expect(await codeOf(storage.uploadPart({ target: PERSONAL_TARGET, ...patch }, signal()))).toBe(
        'FILE_BACKEND_ERROR',
      )
      expect(httpClient.requests).toHaveLength(0)
    })

    it('closes the session', async () => {
      const { httpClient, storage } = build([{ status: 200, data: { success: true } }])
      await storage.closeUploadSession(PERSONAL_TARGET, signal())
      expect(httpClient.requests[0].url).toBe('http://files:3000/v1/files/upload/close-session')
    })

    it.each([
      ['a body that does not report success', { status: 200, data: { success: false } }],
      ['a body that is not an object', { status: 200, data: 'ok' }],
    ])('fails on %s', async (_label, response) => {
      const { storage } = build([response])
      expect(await codeOf(storage.closeUploadSession(PERSONAL_TARGET, signal()))).toBe('FILE_BACKEND_ERROR')
    })
  })

  describe('readRange', () => {
    it('requests the exact window and returns the bytes with the total size', async () => {
      const payload = Buffer.alloc(128, 9)
      const { httpClient, storage } = build([
        { status: 206, data: payload, headers: { 'content-range': 'bytes 256-383/4096' } },
      ])

      const result = await storage.readRange({ target: PERSONAL_TARGET, offset: 256, length: 128 }, signal())

      expect(httpClient.requests[0].headers.range).toBe('bytes=256-383')
      expect(httpClient.requests[0].headers['x-chunk-size']).toBe('128')
      expect(httpClient.requests[0].responseType).toBe('arraybuffer')
      expect(Buffer.from(result.bytes)).toEqual(payload)
      expect(result.totalSize).toBe(4096)
    })

    it.each([
      ['a negative offset', { offset: -1, length: 10 }],
      ['a zero length', { offset: 0, length: 0 }],
      ['a length beyond the protocol chunk cap', { offset: 0, length: 256 * 1024 + 1 }],
    ])('refuses %s without calling out', async (_label, patch) => {
      const { httpClient, storage } = build()
      expect(await codeOf(storage.readRange({ target: PERSONAL_TARGET, ...patch }, signal()))).toBe(
        'FILE_RANGE_INVALID',
      )
      expect(httpClient.requests).toHaveLength(0)
    })

    it('maps a missing resource and an unsatisfiable range distinctly', async () => {
      const missing = build([{ status: 404 }])
      expect(await codeOf(missing.storage.readRange({ target: PERSONAL_TARGET, offset: 0, length: 8 }, signal()))).toBe(
        'FILE_NOT_FOUND',
      )
      const unsatisfiable = build([{ status: 416 }])
      expect(
        await codeOf(unsatisfiable.storage.readRange({ target: PERSONAL_TARGET, offset: 0, length: 8 }, signal())),
      ).toBe('FILE_RANGE_INVALID')
    })

    it('refuses a response longer than the window it asked for', async () => {
      const { storage } = build([
        { status: 206, data: Buffer.alloc(64), headers: { 'content-range': 'bytes 0-63/4096' } },
      ])
      expect(await codeOf(storage.readRange({ target: PERSONAL_TARGET, offset: 0, length: 8 }, signal()))).toBe(
        'FILE_BACKEND_ERROR',
      )
    })

    it('refuses a response body of an unexpected type', async () => {
      const { storage } = build([{ status: 206, data: { not: 'bytes' }, headers: { 'content-range': 'bytes 0-7/64' } }])
      expect(await codeOf(storage.readRange({ target: PERSONAL_TARGET, offset: 0, length: 8 }, signal()))).toBe(
        'FILE_BACKEND_ERROR',
      )
    })
  })

  describe('failure classification', () => {
    it.each([
      ['a rejected valet credential', 401, 'FILE_ACCESS_DENIED'],
      ['a forbidden operation', 403, 'FILE_ACCESS_DENIED'],
      ['an operation the token does not permit', 400, 'FILE_ACCESS_DENIED'],
      ['an oversized payload', 413, 'FILE_RESOURCE_INVALID'],
      ['an unavailable backend', 503, 'FILE_BACKEND_ERROR'],
      ['an internal failure', 500, 'FILE_BACKEND_ERROR'],
    ])('maps %s', async (_label, status, expected) => {
      const { storage } = build([{ status, data: { error: { message: 'nope' } } }])
      expect(await codeOf(storage.closeUploadSession(PERSONAL_TARGET, signal()))).toBe(expected)
    })

    it('maps a transport failure to a retryable backend error', async () => {
      const { httpClient, storage } = build()
      httpClient.throwOnRequest = new Error('ECONNREFUSED')
      expect(await codeOf(storage.closeUploadSession(PERSONAL_TARGET, signal()))).toBe('FILE_BACKEND_ERROR')
    })
  })

  describe('cancellation', () => {
    it('does not call out once the signal is aborted', async () => {
      const { httpClient, storage } = build()
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))

      await expect(storage.probeSize(PERSONAL_TARGET, controller.signal)).rejects.toThrow()
      expect(httpClient.requests).toHaveLength(0)
    })

    it('forwards the signal and a bounded timeout to the transport', async () => {
      const { httpClient, storage } = build([{ status: 200, data: { success: true } }])
      const controller = new AbortController()

      await storage.closeUploadSession(PERSONAL_TARGET, controller.signal)

      expect(httpClient.requests[0].signal).toBe(controller.signal)
      expect(httpClient.requests[0].timeout).toBe(30_000)
      expect(httpClient.requests[0].maxContentLength).toBe(256 * 1024 + 64 * 1024)
    })
  })
})
