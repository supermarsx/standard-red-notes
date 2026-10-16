/** @jest-environment node */
jest.mock('./syncTransport.worker', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('./syncTransport.sharedworker', () => ({ __esModule: true, default: '/test-shared-worker.js' }))
import { ApiVersion, HttpService } from '@standardnotes/api'
import { Session, SessionToken } from '@standardnotes/domain-core'
import { Environment } from '@standardnotes/models'
import { HttpRequest, HttpVerb } from '@standardnotes/responses'
import { createAuthenticatedJsonTransport } from './AuthenticatedJsonTransport'
import { AuthenticatedRpcError, WebSocketSyncTransport } from './WebSocketSyncTransport'

const host = 'https://notes.example.test'
const access = '1:account-a:access'
const context = { host, authentication: access, applicationVersion: 'Web-1', snjsVersion: '2' }
const signedRequest = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  url: `${host}/v1/pending-mfa-approvals`,
  verb: HttpVerb.Get,
  authentication: access,
  ...overrides,
})

function fixture() {
  const rpc = jest.fn().mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { meta: { auth: { userUuid: 'account-a' } }, data: { approvals: [] } },
  })
  const transport = {
    transportStatus: { state: 'READY', operations: ['API_RPC'] },
    openAuthenticatedRpcStream: rpc,
  } as unknown as WebSocketSyncTransport
  let account: string | undefined = 'account-a'
  const bridge = createAuthenticatedJsonTransport({ getTransport: () => transport, getAccountScope: () => account })
  return {
    bridge,
    rpc,
    transport,
    changeAccount: (value?: string) => {
      account = value
    },
  }
}

describe('SDK authenticated JSON over the existing socket', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('carries actual SDK approval GET and activity POST with envelopes, query parameters, headers and no HTTP', async () => {
    const { bridge, rpc } = fixture()
    const meta = jest.fn()
    globalThis.fetch = jest.fn()
    const service = new HttpService(Environment.Web, '1', '2', ApiVersion.v0, console as never)
    service.setHost(host)
    service.setSession(
      Session.create(
        SessionToken.create(access, 1_800_000_000).getValue(),
        SessionToken.create('refresh', 1_900_000_000).getValue(),
      ).getValue(),
    )
    service.setCallbacks(meta, jest.fn())
    service.setAuthenticatedJsonTransport(bridge)
    expect(await service.get('/v1/pending-mfa-approvals', { limit: 2 })).toMatchObject({
      status: 200,
      data: { approvals: [] },
    })
    expect(rpc.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: expect.stringContaining('limit=2'),
      headers: { 'x-snjs-version': '2', 'x-application-version': 'Web-1' },
    })
    await service.post('/v1/sessions/activity', { device_id: 'profile-a' })
    expect(rpc.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      path: '/v1/sessions/activity',
      body: { device_id: 'profile-a' },
      idempotencyKey: expect.any(String),
    })
    expect(meta).toHaveBeenCalledWith({ auth: { userUuid: 'account-a' } })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each([
    { authentication: undefined },
    { external: true },
    { rawBytes: new Uint8Array([1]) },
    { responseType: 'arraybuffer' as const },
    { responseType: 'text' as const },
    { url: 'https://other.example.test/v1/pending-mfa-approvals' },
    { url: `${host}/v1/sessions/refresh`, verb: HttpVerb.Post },
    { url: `${host}/v1/items`, verb: HttpVerb.Post },
    { url: `${host}/v1/items/check-integrity` },
    { url: `${host}/v1/sockets/sync/ticket`, verb: HttpVerb.Post },
    { url: `${host}/v1/users/uuid/mfa-secret` },
    { url: `${host}/v1/%75sers/uuid/settings` },
    { url: `${host}/v1/pending-mfa-approvals/challenge/status` },
    { url: `${host}/v1/workflows/status`, params: { nested: { password: 'must-stay-http' } } },
    { customHeaders: [{ key: 'Authorization', value: 'Bearer another-account' }] },
    { authentication: '1:account-b:access' },
    { url: `${host}/v1/workflows/%zz` },
  ])('declines excluded or credential-bearing requests without socket dispatch: %j', async (overrides) => {
    const { bridge, rpc } = fixture()
    expect(await bridge(signedRequest(overrides), context)).toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    [
      HttpVerb.Put,
      '/v1/admin/server-settings',
      { ai: { apiKey: 'private-key' }, smtp: { password: 'private-password' } },
    ],
    [HttpVerb.Put, '/v1/users/user-1/settings', { name: 'email_backup_frequency', value: 'daily' }],
    [HttpVerb.Delete, '/v1/admin/groups/group-1/members/user-1', undefined],
    [HttpVerb.Post, '/v1/admin/email-delivery/test', { recipient: 'me@example.test' }],
    [HttpVerb.Get, '/v1/users/user-1/subscription-settings/file_upload_bytes_used', undefined],
    [HttpVerb.Get, '/v1/sessions', undefined],
  ] as const)(
    'dispatches reviewed settings %s %s over the socket with its actual method',
    async (verb, path, params) => {
      const { bridge, rpc } = fixture()
      const request = signedRequest({ verb, url: `${host}${path}`, params })
      await bridge(request, context)
      expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: verb, path }))
      if (verb !== HttpVerb.Get) {
        const first = rpc.mock.calls[0][0].idempotencyKey
        expect(first).toMatch(/^[a-f0-9]{32}$/)
        await bridge(request, context)
        expect(rpc.mock.calls[1][0].idempotencyKey).toBe(first)
        await bridge({ ...request }, context)
        expect(rpc.mock.calls[2][0].idempotencyKey).not.toBe(first)
      }
    },
  )

  it('does not replay an uncertain settings write over HTTP, and refreshes identity only after a proven auth refusal', async () => {
    const { bridge, rpc } = fixture()
    const request = signedRequest({
      verb: HttpVerb.Put,
      url: `${host}/v1/admin/server-settings`,
      params: { ai: { enabled: true } },
    })
    rpc.mockRejectedValueOnce(new AuthenticatedRpcError('SOCKET_CLOSED', true, false))
    const response = await bridge(request, context)
    expect(response?.status).toBe(503)
    expect(await response?.json()).toMatchObject({ uncertain: true })
    rpc.mockResolvedValueOnce({ status: 498, headers: {}, body: {} })
    await bridge(request, context)
    const old = rpc.mock.calls.at(-1)![0].idempotencyKey
    await bridge(request, context)
    expect(rpc.mock.calls.at(-1)![0].idempotencyKey).not.toBe(old)
  })

  it('keeps the same heartbeat idempotency key across a logical request retry', async () => {
    const { bridge, rpc } = fixture()
    const request = signedRequest({
      verb: HttpVerb.Post,
      url: `${host}/v1/sessions/activity`,
      params: { device_id: 'a' },
    })
    await bridge(request, context)
    await bridge(request, context)
    await bridge({ ...request }, context)
    expect(rpc.mock.calls[0][0].idempotencyKey).toBe(rpc.mock.calls[1][0].idempotencyKey)
    expect(rpc.mock.calls[2][0].idempotencyKey).not.toBe(rpc.mock.calls[0][0].idempotencyKey)
  })

  it('allows HTTP only for a proved pre-send refusal and returns uncertainty for a sent mutation', async () => {
    const { bridge, rpc } = fixture()
    const request = signedRequest({
      verb: HttpVerb.Post,
      url: `${host}/v1/sessions/activity`,
      params: { device_id: 'a' },
    })
    rpc.mockRejectedValueOnce(new AuthenticatedRpcError('SOCKET_UNAVAILABLE', true, true))
    expect(await bridge(request, context)).toBeUndefined()
    rpc.mockRejectedValueOnce(new AuthenticatedRpcError('SOCKET_CLOSED', true, false))
    const response = await bridge(request, context)
    expect(response?.status).toBe(503)
    expect(await response?.json()).toMatchObject({ uncertain: true, networkFailure: true })
  })

  it('does not fall back or deliver an old account response when the account changes while RPC is pending', async () => {
    const { bridge, rpc, changeAccount } = fixture()
    let finish!: (value: unknown) => void
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = bridge(signedRequest(), context)
    changeAccount('account-b')
    finish({ status: 200, headers: {}, body: { data: { belongsToA: true } } })
    await expect(pending).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', safeToFallback: false })
  })

  it('declines an unnegotiated lane and respects caller cancellation without HTTP fallback', async () => {
    const { bridge, transport, rpc } = fixture()
    ;(transport.transportStatus as { state: string }).state = 'HTTP_FALLBACK'
    expect(await bridge(signedRequest(), context)).toBeUndefined()
    ;(transport.transportStatus as { state: string }).state = 'READY'
    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    rpc.mockImplementation(async () => {
      controller.abort(reason)
      throw new AuthenticatedRpcError('CANCELLED', false, true)
    })
    await expect(bridge(signedRequest({ abortSignal: controller.signal }), context)).rejects.toBe(reason)
  })
})
