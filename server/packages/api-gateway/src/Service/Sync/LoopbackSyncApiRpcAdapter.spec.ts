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

/**
 * The block-list is only load-bearing for GET. `isAllowedRpcRequest` already
 * restricts POST to two exact reviewed paths and refuses every other method, so
 * a test that asserts a forbidden path with POST proves nothing about the
 * block-list — which is precisely why the dead entries survived. Every case here
 * uses GET, and every path is the REAL route string taken from the controller
 * that mounts it.
 */
describe('LoopbackSyncApiRpcAdapter forbidden route families', () => {
  const adapterWithSpy = (): { adapter: LoopbackSyncApiRpcAdapter; fetch: jest.Mock } => {
    const fetch = jest.fn()
    return {
      adapter: new LoopbackSyncApiRpcAdapter({
        origin: 'http://127.0.0.1:3000',
        operations: ['API_RPC', 'STREAM_ASSISTANT'],
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
      fetch,
    }
  }

  const refusesGet = async (path: string): Promise<void> => {
    const { adapter, fetch } = adapterWithSpy()
    await expect(
      adapter.execute({ identity, method: 'GET', path, headers: {}, stream: false }, new AbortController().signal),
    ).rejects.toThrow(/unavailable/i)
    expect(fetch).not.toHaveBeenCalled()
  }

  // Real route strings: SyncWebSocketController mounts @controller('/v1/sockets/sync')
  // with @httpGet('/capabilities') and @httpPost('/ticket') — SINGULAR — and
  // WebSocketsController mounts @controller('/v1/sockets') with '/tokens' and
  // '/connections'. The old list named '/v1/sockets/sync/tickets' and only
  // '/sockets/', so none of these were matched.
  it.each([
    '/v1/sockets/sync/ticket',
    '/v1/sockets/sync/capabilities',
    '/v1/sockets/tokens',
    '/v1/sockets/connections',
    '/sockets/tokens',
    '/sockets/sync/capabilities',
  ])('refuses the socket handshake route %s', refusesGet)

  // UsersController mounts these under @controller('/v1/users'). The old entry
  // was the bare '/v1/users' with no subtree match, so all of them were reachable.
  it.each([
    '/v1/users/user-1/mfa-secret',
    '/v1/users/user-1/params',
    '/v1/users/user-1/settings',
    '/v1/users/user-1/settings/some-setting',
    '/v1/users/user-1/subscription',
    '/v1/users/user-1/features',
    '/v1/users/me/invite-links',
  ])('refuses the per-user credential route %s', refusesGet)

  it.each([
    '/v1/items',
    '/v1/items/item-1',
    '/v1/items/sync-command/command-1',
    '/v1/items/item-1/revisions',
    '/v1/sessions',
    '/v1/login-params',
    '/v1/users',
  ])('keeps refusing the previously-listed route %s', refusesGet)

  // Express routes case-insensitively and non-strictly by default, so each of
  // these reaches the same controller as its canonical form.
  it.each([
    '/V1/Users/user-1/mfa-secret',
    '/v1/users/',
    '/v1//users//user-1',
    '/v1/%73ockets/tokens',
    '/v1/items/../users/user-1/mfa-secret',
  ])('refuses the equivalent form %s that reaches the same route', refusesGet)

  it('refuses a malformed percent-encoding rather than comparing it raw', async () => {
    await refusesGet('/v1/%ZZ')
  })

  // The guard against over-blocking: the families must not swallow the control
  // plane this lane exists to carry.
  it.each(['/v1/admin/sync-diagnostics', '/v1/workflows/status', '/v1/assistant/config', '/v1/subscription-invites'])(
    'still permits the control-plane read %s',
    async (path) => {
      const fetch = jest.fn(async () => Response.json({ ok: true }))
      const adapter = new LoopbackSyncApiRpcAdapter({
        origin: 'http://127.0.0.1:3000',
        operations: ['API_RPC'],
        fetch: fetch as unknown as typeof globalThis.fetch,
      })

      await expect(
        adapter.execute({ identity, method: 'GET', path, headers: {}, stream: false }, new AbortController().signal),
      ).resolves.toMatchObject({ status: 200 })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
})
