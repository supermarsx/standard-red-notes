import { AuthenticatedRpcError } from '@/Services/SyncTransport/WebSocketSyncTransport'
import { WebApplication } from './WebApplication'
import { ReadableStream as NodeReadableStream } from 'stream/web'
import { TextDecoder, TextEncoder } from 'util'

type TransportMock = {
  openAuthenticatedRpcStream: jest.Mock
}

function applicationWith(transport: TransportMock): WebApplication {
  return {
    _webSocketSyncTransport: transport,
    getHost: { execute: () => ({ getValue: () => 'https://notes.example.test' }) },
    sessions: { getSession: () => ({ accessToken: 'session-token' }) },
  } as unknown as WebApplication
}

function request(application: WebApplication, signal?: AbortSignal): Promise<Response> {
  return WebApplication.prototype.assistantStreamRequest.call(
    application,
    '/v1/assistant/stream',
    { messages: [{ role: 'user', content: 'Hello' }] },
    signal,
  )
}

describe('WebApplication.assistantStreamRequest websocket preference', () => {
  const originalFetch = globalThis.fetch
  const OriginalResponse = globalThis.Response

  beforeEach(() => {
    class TestResponse {
      readonly status: number
      readonly headers: Record<string, string>

      constructor(
        private readonly responseBody: string | NodeReadableStream<Uint8Array> | null,
        init: { status?: number; headers?: Record<string, string> } = {},
      ) {
        this.status = init.status ?? 200
        this.headers = init.headers ?? {}
      }

      async text(): Promise<string> {
        if (typeof this.responseBody === 'string') {
          return this.responseBody
        }
        if (!this.responseBody) {
          return ''
        }
        const chunks: Uint8Array[] = []
        const reader = this.responseBody.getReader()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) {
            break
          }
          chunks.push(chunk.value)
        }
        return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
      }
    }
    globalThis.Response = TestResponse as unknown as typeof Response
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.Response = OriginalResponse
  })

  it('uses the worker-owned websocket stream without issuing an HTTP request', async () => {
    const bytes = new TextEncoder().encode('data: {"type":"done"}\n\n')
    const stream = new NodeReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: stream as unknown as ReadableStream<Uint8Array>,
        transport: 'websocket',
      }),
    }
    globalThis.fetch = jest.fn()

    const response = await request(applicationWith(transport))

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('data: {"type":"done"}\n\n')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(transport.openAuthenticatedRpcStream).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/v1/assistant/stream',
        stream: true,
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        idempotencyKey: expect.stringMatching(/^assistant-/),
      }),
    )
  })

  it('falls back exactly once before send and carries the same idempotency key over HTTP', async () => {
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest
        .fn()
        .mockRejectedValue(new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true)),
    }
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response)
    globalThis.fetch = fetchMock

    await request(applicationWith(transport))

    const socketRequest = transport.openAuthenticatedRpcStream.mock.calls[0][0] as { idempotencyKey: string }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://notes.example.test/v1/assistant/stream',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer session-token',
          'Idempotency-Key': socketRequest.idempotencyKey,
        }),
      }),
    )
  })

  it('never replays an ambiguous or post-send websocket failure over HTTP', async () => {
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest.fn().mockRejectedValue(new AuthenticatedRpcError('WORKER_ERROR', true, false)),
    }
    globalThis.fetch = jest.fn()

    await expect(request(applicationWith(transport))).rejects.toMatchObject({
      code: 'WORKER_ERROR',
      safeToFallback: false,
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
