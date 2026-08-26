import { AuthenticatedRpcError } from '@/Services/SyncTransport/WebSocketSyncTransport'
import { WebApplication } from './WebApplication'

type TransportMock = {
  openAuthenticatedRpcStream: jest.Mock
}

function applicationWith(transport?: TransportMock): WebApplication {
  return {
    _webSocketSyncTransport: transport,
    getHost: { execute: () => ({ getValue: () => 'https://notes.example.test' }) },
    sessions: { getSession: () => ({ accessToken: 'session-token' }) },
    // The helpers under test are invoked off the prototype against this plain
    // object, so the private lane they delegate to has to be carried across too.
    controlPlaneRpc: (WebApplication.prototype as unknown as Record<string, unknown>).controlPlaneRpc,
  } as unknown as WebApplication
}

function get<T>(application: WebApplication, path: string): Promise<{ status: number; ok: boolean; data: T }> {
  return WebApplication.prototype.serverGetJsonRequest.call(application, path) as Promise<{
    status: number
    ok: boolean
    data: T
  }>
}

function post<T>(
  application: WebApplication,
  path: string,
  body: unknown,
): Promise<{ status: number; ok: boolean; data: T }> {
  return WebApplication.prototype.serverJsonRequest.call(application, path, body) as Promise<{
    status: number
    ok: boolean
    data: T
  }>
}

describe('WebApplication control-plane websocket RPC lane', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('carries a control-plane GET over the socket without issuing an HTTP request', async () => {
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest.fn().mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { enabled: true },
        transport: 'websocket',
      }),
    }
    globalThis.fetch = jest.fn()

    await expect(get(applicationWith(transport), '/v1/workflows/status')).resolves.toEqual({
      status: 200,
      ok: true,
      data: { enabled: true },
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(transport.openAuthenticatedRpcStream).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/v1/workflows/status' }),
    )
  })

  it('reports a non-2xx socket response as not ok rather than retrying over HTTP', async () => {
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest.fn().mockResolvedValue({
        status: 404,
        headers: {},
        body: {},
        transport: 'websocket',
      }),
    }
    globalThis.fetch = jest.fn()

    await expect(get(applicationWith(transport), '/v1/workflows/status')).resolves.toMatchObject({
      status: 404,
      ok: false,
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('never routes the socket handshake through the socket it establishes', async () => {
    const transport: TransportMock = { openAuthenticatedRpcStream: jest.fn() }
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ capabilities: [] }),
    } as unknown as Response)

    await get(applicationWith(transport), '/v1/sockets/sync/capabilities')

    expect(transport.openAuthenticatedRpcStream).not.toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to HTTP when the socket proves no request bytes were sent', async () => {
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest
        .fn()
        .mockRejectedValue(new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true)),
    }
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ enabled: true }),
    } as unknown as Response)
    globalThis.fetch = fetchMock

    await expect(get(applicationWith(transport), '/v1/workflows/status')).resolves.toMatchObject({
      status: 200,
      ok: true,
      data: { enabled: true },
    })
    expect(fetchMock).toHaveBeenCalledWith('https://notes.example.test/v1/workflows/status', expect.anything())
  })

  it('never replays an ambiguous or post-send mutation over HTTP', async () => {
    const transport: TransportMock = {
      openAuthenticatedRpcStream: jest.fn().mockRejectedValue(new AuthenticatedRpcError('WORKER_ERROR', true, false)),
    }
    globalThis.fetch = jest.fn()

    await expect(post(applicationWith(transport), '/v1/github/publish', { note: 'x' })).rejects.toMatchObject({
      code: 'WORKER_ERROR',
      safeToFallback: false,
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('uses HTTP unchanged when no socket transport is installed', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ enabled: false }),
    } as unknown as Response)
    globalThis.fetch = fetchMock

    await expect(get(applicationWith(undefined), '/v1/workflows/status')).resolves.toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
