import { LoopbackSyncApiRpcAdapter } from './LoopbackSyncApiRpcAdapter'

const identity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer session-token',
}

describe('LoopbackSyncApiRpcAdapter', () => {
  it('rejects every non-loopback or path-bearing origin', () => {
    expect(
      () => new LoopbackSyncApiRpcAdapter({ origin: 'https://api.example.test', operations: ['API_RPC'] }),
    ).toThrow(/loopback/i)
    expect(
      () => new LoopbackSyncApiRpcAdapter({ origin: 'http://127.0.0.1:3000/prefix', operations: ['API_RPC'] }),
    ).toThrow(/loopback/i)
  })

  it('injects the ticket identity and durable attempt key into the canonical local request', async () => {
    const fetch = jest.fn(async () =>
      Response.json(
        { used: 2, limit: 10 },
        {
          headers: {
            'cache-control': 'private, no-store',
            'set-cookie': 'never-forward=1',
            'x-request-id': 'request-1',
          },
        },
      ),
    )
    const adapter = new LoopbackSyncApiRpcAdapter({
      origin: 'http://127.0.0.1:3000',
      operations: ['API_RPC', 'STREAM_ASSISTANT'],
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(
      adapter.execute(
        {
          identity,
          method: 'POST',
          path: '/v1/assistant/stream',
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: { messages: [] },
          idempotencyKey: 'attempt-1',
          stream: false,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 200,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'application/json',
        'x-request-id': 'request-1',
      },
      body: { used: 2, limit: 10 },
    })

    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://127.0.0.1:3000/v1/assistant/stream')
    const headers = init.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer session-token')
    expect(headers.get('idempotency-key')).toBe('attempt-1')
    expect(headers.get('x-standardnotes-transport')).toBe('websocket-rpc-v1')
    expect(init.body).toBe(JSON.stringify({ messages: [] }))
  })

  it('never double-routes durable item sync or session issuance', async () => {
    const fetch = jest.fn()
    const adapter = new LoopbackSyncApiRpcAdapter({
      origin: 'http://localhost:3000',
      operations: ['API_RPC'],
      fetch: fetch as typeof globalThis.fetch,
    })

    for (const path of ['/v1/items', '/v1/items/check-integrity', '/v1/sessions', '/v1/users']) {
      await expect(
        adapter.execute(
          { identity, method: 'POST', path, headers: {}, idempotencyKey: 'attempt-1', stream: false },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/unavailable/i)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects arbitrary mutations even with an idempotency key and permits only reviewed POST routes', async () => {
    const fetch = jest.fn(async () => Response.json({ authorized: false }))
    const adapter = new LoopbackSyncApiRpcAdapter({
      origin: 'http://127.0.0.1:3000',
      operations: ['API_RPC', 'STREAM_ASSISTANT'],
      fetch: fetch as typeof globalThis.fetch,
    })

    for (const request of [
      { method: 'POST' as const, path: '/v1/workflows/status' },
      { method: 'PUT' as const, path: '/v1/assistant/stream' },
      { method: 'DELETE' as const, path: '/v1/collaboration/authorize' },
    ]) {
      await expect(
        adapter.execute(
          { ...request, identity, headers: {}, idempotencyKey: 'reviewed-attempt', stream: false },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/unavailable/i)
    }

    await expect(
      adapter.execute(
        {
          identity,
          method: 'POST',
          path: '/v1/collaboration/authorize',
          headers: {},
          body: { noteUuid: 'note-1' },
          idempotencyKey: 'collaboration-attempt',
          stream: false,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: 200, body: { authorized: false } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns response bytes as an async stream without buffering the provider response', async () => {
    const fetch = jest.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: one\n\n'))
              controller.enqueue(new TextEncoder().encode('data: two\n\n'))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'hidden=1' } },
        ),
    )
    const adapter = new LoopbackSyncApiRpcAdapter({
      origin: 'http://[::1]:3000',
      operations: ['API_RPC', 'STREAM_ASSISTANT'],
      fetch: fetch as typeof globalThis.fetch,
    })
    const result = await adapter.execute(
      {
        identity,
        method: 'POST',
        path: '/v1/assistant/stream',
        headers: {},
        body: {},
        idempotencyKey: 'attempt-stream',
        stream: true,
      },
      new AbortController().signal,
    )
    const chunks: Uint8Array[] = []
    for await (const chunk of result.stream ?? []) {
      chunks.push(chunk)
    }
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('data: one\n\ndata: two\n\n')
    expect(result.headers).toEqual({ 'content-type': 'text/event-stream' })
  })
})
