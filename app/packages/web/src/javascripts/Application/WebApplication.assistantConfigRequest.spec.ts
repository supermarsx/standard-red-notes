import { WebApplication } from './WebApplication'
const controlPlaneRpc = jest.fn()

const application = {
  controlPlaneRpc,
  getHost: {
    execute: () => ({ getValue: () => 'https://notes.example.test' }),
  },
  sessions: {
    getSession: () => ({ accessToken: 'session-token' }),
  },
} as unknown as WebApplication

const request = <T>() =>
  WebApplication.prototype.assistantConfigRequest.call(application, '/v1/assistant/config') as Promise<T>

describe('WebApplication.assistantConfigRequest', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    controlPlaneRpc.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('rejects a non-2xx response with a bounded proxy error instead of treating the error body as config', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => 'application/json' },
      json: jest.fn().mockResolvedValue({ error: { message: 'Session expired' } }),
    } as unknown as Response)
    globalThis.fetch = fetchMock

    await expect(request()).rejects.toThrow(
      'Assistant server proxy returned HTTP 401. Sign in again and confirm that your account is allowed to use the assistant. Provider message: Session expired',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://notes.example.test/v1/assistant/config',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
      }),
    )
  })

  it('returns JSON only after a successful response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ defaultProvider: 'openai' }),
    } as unknown as Response)

    await expect(request<{ defaultProvider: string }>()).resolves.toEqual({ defaultProvider: 'openai' })
  })
  it.each([
    '/v1/assistant/config',
    '/v1/assistant/usage',
    '/v1/assistant/models',
    '/v1/assistant/subscription/status?subscriptionId=default',
  ])('reads %s over the authenticated socket without an HTTP request', async (path) => {
    controlPlaneRpc.mockResolvedValue({ ok: true, status: 200, data: { available: true } })
    globalThis.fetch = jest.fn()
    await expect(WebApplication.prototype.assistantConfigRequest.call(application, path)).resolves.toEqual({
      available: true,
    })
    expect(controlPlaneRpc).toHaveBeenCalledWith('GET', path)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
  it('surfaces socket authorization failures without disguising them as config or issuing HTTP', async () => {
    controlPlaneRpc.mockResolvedValue({ ok: false, status: 403, data: { error: { message: 'Access denied' } } })
    globalThis.fetch = jest.fn()
    await expect(request()).rejects.toThrow('HTTP 403')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
