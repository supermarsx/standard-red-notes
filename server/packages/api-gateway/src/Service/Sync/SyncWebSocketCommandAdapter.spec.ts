import jwt from 'jsonwebtoken'
import type { JsonObject, SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { CollaborationAuthorizationService } from './CollaborationAuthorizationService'
import { DurableSyncCommandPort, SyncWebSocketCommandAdapter } from './SyncWebSocketCommandAdapter'

const JWT_SECRET = 'sync-adapter-test-secret'
const identity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer session-token',
}

function token(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      user: { uuid: 'user-1', email: 'user@example.test' },
      session: { uuid: 'session-1', readonly_access: false },
      roles: [{ name: 'CORE_USER' }],
      belongs_to_shared_vaults: [{ shared_vault_uuid: 'vault-1', permission: 'write' }],
      hasContentLimit: false,
      live_sync_enabled: true,
      ...overrides,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

function build(
  overrides: Record<string, unknown> = {},
  collaboration?: CollaborationAuthorizationService,
  now: () => number = Date.now,
): {
  adapter: SyncWebSocketCommandAdapter
  serviceProxy: ServiceProxyInterface
  durable: DurableSyncCommandPort
} {
  const serviceProxy = {
    validateSession: jest.fn(async () => ({
      status: 200,
      data: { authToken: token(overrides) },
      headers: { contentType: 'application/json' },
    })),
  } as unknown as ServiceProxyInterface
  const durable: DurableSyncCommandPort = {
    durableCommandAuthenticationReady: jest.fn(() => true),
    sync: jest.fn(async (_request, _response, payload) => ({
      status: 200,
      data: { retrieved_items: [], command: { ...(payload.command as JsonObject), status: 'committed' } },
    })),
    getSyncCommandStatus: jest.fn(async (_request, _response, commandId, digest) => ({
      status: 200,
      data: { command: { id: commandId, digest, status: 'committed' }, result: { retrieved_items: [] } },
    })),
  }
  return {
    adapter: new SyncWebSocketCommandAdapter(serviceProxy, durable, JWT_SECRET, collaboration, now),
    serviceProxy,
    durable,
  }
}

/** Stand-in for the minting service; its own policy is covered by its spec. */
function collaborationService(options: { ready?: boolean } = {}): CollaborationAuthorizationService {
  return {
    ready: jest.fn(() => options.ready !== false),
    authorize: jest.fn(async () => ({
      authorized: true,
      epochDiscovery: false,
      capability: 'minted-capability',
      room: 'note-1',
      expiresIn: 300,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: 3,
      roomEpoch: 'room_epoch_0000000000000001',
      collaborationSecurityEpoch: 'security_epoch_0000000000000001',
    })),
  } as unknown as CollaborationAuthorizationService
}

const collaborationInput = {
  identity,
  request: {
    noteUuid: 'note-1',
    collaborationProtocolVersion: 3 as const,
    expectedRoomEpoch: 'room_epoch_0000000000000001',
    leaseRequestId: 'lease-1',
  },
}

describe('SyncWebSocketCommandAdapter', () => {
  // ---------------------------------------------------------------------------
  // Session readiness vs durable readiness are two independent questions on one
  // object. While a single `ready()` answered both, an unbound gRPC proxy -- or
  // a bound one with no SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET -- reported the
  // SESSION plane as dead, which closed the socket and took every capability
  // with it, including the five that never touch the durable backend.
  // ---------------------------------------------------------------------------
  describe('readiness is split between the session and the durable planes', () => {
    it('keeps the session plane alive with NO durable port bound', async () => {
      const serviceProxy = {
        validateSession: jest.fn(async () => ({
          status: 200,
          data: { authToken: token() },
          headers: { contentType: 'application/json' },
        })),
      } as unknown as ServiceProxyInterface
      const adapter = new SyncWebSocketCommandAdapter(serviceProxy, undefined, JWT_SECRET, collaborationService())

      expect(adapter.sessionAuthorizationReady()).toBe(true)
      expect(adapter.ready()).toBe(false)
      expect(adapter.collaborationAuthorizationReady()).toBe(true)
      await expect(
        adapter.authorize(
          { identity, operation: 'COMMAND', commandId: 'command-1', digest: 'a'.repeat(64), payloadLength: 1 },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ authorized: true, session: expect.any(Object) })
      await expect(
        adapter.authorizeCollaboration(collaborationInput, new AbortController().signal),
      ).resolves.toMatchObject({ authorized: true })
    })

    it('keeps the session plane alive when the durable port lacks its internal signing secret', async () => {
      // The second, independent way this used to lose every lane: the gRPC proxy
      // IS bound, but SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET is unset, so
      // durableCommandAuthenticationReady() is false. Nobody has hit this only
      // by luck -- the failure mode is identical to an unbound proxy.
      const { adapter, durable } = build({}, collaborationService())
      ;(durable.durableCommandAuthenticationReady as jest.Mock).mockReturnValue(false)

      expect(adapter.sessionAuthorizationReady()).toBe(true)
      expect(adapter.ready()).toBe(false)
      expect(adapter.collaborationAuthorizationReady()).toBe(true)
      await expect(
        adapter.authorize(
          { identity, operation: 'STATUS', commandId: 'command-1', digest: 'a'.repeat(64), payloadLength: 0 },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ authorized: true, session: expect.any(Object) })
    })

    it('reports both planes unready without an auth secret, since the session plane rests on it', async () => {
      const serviceProxy = {
        validateSession: jest.fn(),
      } as unknown as ServiceProxyInterface
      const adapter = new SyncWebSocketCommandAdapter(serviceProxy, undefined, '', collaborationService())

      expect(adapter.sessionAuthorizationReady()).toBe(false)
      expect(adapter.ready()).toBe(false)
      expect(adapter.collaborationAuthorizationReady()).toBe(false)
    })

    it('refuses durable execution outright rather than dereferencing an absent port', async () => {
      const serviceProxy = {
        validateSession: jest.fn(async () => ({
          status: 200,
          data: { authToken: token() },
          headers: { contentType: 'application/json' },
        })),
      } as unknown as ServiceProxyInterface
      const adapter = new SyncWebSocketCommandAdapter(serviceProxy, undefined, JWT_SECRET)
      const digest = 'a'.repeat(64)

      await expect(
        adapter.execute(
          { identity, commandId: 'command-1', digest, payload: { command: 'SYNC_ITEMS', body: { api: '20200115' } } },
          new AbortController().signal,
        ),
      ).rejects.toThrow('Durable sync command execution is unavailable.')
      await expect(
        adapter.status({ identity, commandId: 'command-1', digest }, new AbortController().signal),
      ).rejects.toThrow('Durable sync command execution is unavailable.')
      // The gateway never reaches these without consulting ready(); the throw is
      // the backstop, so it must not have touched the session first.
      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
    })

    it('still reports ready on a fully bound durable port', async () => {
      const { adapter } = build({}, collaborationService())

      expect(adapter.sessionAuthorizationReady()).toBe(true)
      expect(adapter.ready()).toBe(true)
      expect(adapter.collaborationAuthorizationReady()).toBe(true)
    })
  })

  it('revalidates the original session on every command and delegates durable execution with identical metadata', async () => {
    const { adapter, serviceProxy, durable } = build()
    const digest = 'a'.repeat(64)
    const payload = { command: 'SYNC_ITEMS', body: { api: '20200115', items: [] } }
    const authorization = await adapter.authorize(
      { identity, operation: 'COMMAND', commandId: 'command-1', digest, payloadLength: 1, payload },
      new AbortController().signal,
    )
    const result = await adapter.execute(
      { identity, commandId: 'command-1', digest, payload },
      new AbortController().signal,
    )

    // Without the session evidence handed back, execute validates on its own.
    expect(authorization).toEqual({ authorized: true, session: expect.any(Object) })
    expect(serviceProxy.validateSession).toHaveBeenCalledTimes(2)
    expect(serviceProxy.validateSession).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { authorization: 'session-token' } }),
    )
    expect(durable.sync).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'x-snjs-version': '20200115' } }),
      expect.objectContaining({
        locals: expect.objectContaining({ user: { uuid: 'user-1', email: 'user@example.test' } }),
      }),
      { api: '20200115', items: [], command: { id: 'command-1', digest } },
    )
    expect(result).toEqual({
      digest,
      payload: { retrieved_items: [], command: { id: 'command-1', digest, status: 'committed' } },
    })
  })

  it.each([
    ['read-only session', { session: { uuid: 'session-1', readonly_access: true } }, 'READ_ONLY'],
    ['content limit', { hasContentLimit: true }, 'CONTENT_LIMIT'],
    ['shadow ban', { shadow_banned: true }, 'SHADOW_BANNED'],
    // The per-user "Live sync" switch has its own public, permanent code: it is
    // not a shadow ban and the client must not treat it as a policy denial.
    ['live-sync revocation', { live_sync_enabled: false }, 'LIVE_SYNC_DISABLED'],
    // A shadow-banned user with live sync off gets the same public answer as
    // anyone else with live sync off; the ban is never the thing revealed.
    [
      'live-sync revocation of a shadow-banned user',
      { live_sync_enabled: false, shadow_banned: true },
      'LIVE_SYNC_DISABLED',
    ],
  ])('fails closed for a live %s', async (_label, claims, code) => {
    const { adapter } = build(claims)
    await expect(
      adapter.authorize(
        {
          identity,
          operation: 'COMMAND',
          commandId: 'command-1',
          digest: 'a'.repeat(64),
          payloadLength: 1,
          payload: { command: 'SYNC_ITEMS', body: { items: [] } },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ authorized: false, code })
  })

  it('rejects a shared-vault command absent from the freshly validated membership claims', async () => {
    const { adapter } = build({ belongs_to_shared_vaults: [] })
    await expect(
      adapter.authorize(
        {
          identity,
          operation: 'COMMAND',
          commandId: 'command-1',
          digest: 'a'.repeat(64),
          payloadLength: 1,
          payload: { command: 'SYNC_ITEMS', body: { shared_vault_uuids: ['vault-1'] } },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ authorized: false, code: 'SHARED_VAULT_FORBIDDEN' })
  })

  // R9 / contract C6. A session token rotated or refreshed mid-socket used to
  // turn every later COMMAND into the permanent NOT_AUTHORIZED, and nothing
  // told the client to re-ticket. Auth ANSWERING that the captured bearer no
  // longer validates -- a non-200, or a token now bound to another identity --
  // is the public, retryable SESSION_STALE. Failures where auth did not answer
  // (or the token is unverifiable) stay the private SESSION_REVOKED.
  it.each([
    ['a session now bound to another session id', { session: { uuid: 'different-session', readonly_access: false } }],
    ['a session now bound to another user', { user: { uuid: 'user-2', email: 'other@example.test' } }],
  ])('maps %s to the retryable SESSION_STALE without calling the durable executor', async (_label, claims) => {
    const { adapter, durable } = build(claims)
    await expect(
      adapter.authorize(
        {
          identity,
          operation: 'COMMAND',
          commandId: 'command-1',
          digest: 'a'.repeat(64),
          payloadLength: 0,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
    expect(durable.sync).not.toHaveBeenCalled()
  })

  it('maps an auth refusal of the captured bearer (non-200) to SESSION_STALE', async () => {
    const { adapter, serviceProxy, durable } = build()
    ;(serviceProxy.validateSession as jest.Mock).mockResolvedValue({ status: 401, data: {}, headers: {} })
    await expect(
      adapter.authorize(
        { identity, operation: 'COMMAND', commandId: 'command-1', digest: 'a'.repeat(64), payloadLength: 0 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
    await expect(
      adapter.authorize(
        { identity, operation: 'STATUS', commandId: 'command-1', digest: 'a'.repeat(64), payloadLength: 0 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
    expect(durable.sync).not.toHaveBeenCalled()
  })

  it.each([
    [
      'the socket carries no bearer',
      (proxy: ServiceProxyInterface) => proxy,
      { ...identity, authorization: undefined },
    ],
    [
      'auth is unreachable',
      (proxy: ServiceProxyInterface) => {
        ;(proxy.validateSession as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'))
        return proxy
      },
      identity,
    ],
    [
      'auth returns no token',
      (proxy: ServiceProxyInterface) => {
        ;(proxy.validateSession as jest.Mock).mockResolvedValue({ status: 200, data: {}, headers: {} })
        return proxy
      },
      identity,
    ],
    [
      'the returned token does not verify',
      (proxy: ServiceProxyInterface) => {
        ;(proxy.validateSession as jest.Mock).mockResolvedValue({
          status: 200,
          data: { authToken: jwt.sign({ user: { uuid: 'user-1' } }, 'another-secret') },
          headers: {},
        })
        return proxy
      },
      identity,
    ],
  ])('keeps the private SESSION_REVOKED when %s', async (_label, arrange, ticketIdentity) => {
    const { adapter, serviceProxy, durable } = build()
    arrange(serviceProxy)
    await expect(
      adapter.authorize(
        {
          identity: ticketIdentity,
          operation: 'COMMAND',
          commandId: 'command-1',
          digest: 'a'.repeat(64),
          payloadLength: 0,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ authorized: false, code: 'SESSION_REVOKED' })
    expect(durable.sync).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // R8. Each SYNC_ITEMS command used to cost three uncached validations against
  // auth (two authorize passes plus one inside execute). The handler now hands
  // the pre-execute authorization's session back to execute/status; the adapter
  // reuses it ONLY when it is evidence this adapter produced, for this
  // identity, and no older than SUPPLIED_SESSION_MAX_AGE_MS.
  // -------------------------------------------------------------------------
  describe('session evidence reuse', () => {
    const digest = 'a'.repeat(64)
    const payload = { command: 'SYNC_ITEMS', body: { api: '20200115', items: [] } }

    it('skips validate() in execute when handed the session it just authorized', async () => {
      const { adapter, serviceProxy, durable } = build()
      const authorization = await adapter.authorize(
        { identity, operation: 'COMMAND', commandId: 'command-1', digest, payloadLength: 1, payload },
        new AbortController().signal,
      )
      expect(authorization).toMatchObject({ authorized: true, session: expect.any(Object) })
      const session = (authorization as { session?: unknown }).session

      const result = await adapter.execute(
        { identity, commandId: 'command-1', digest, payload },
        new AbortController().signal,
        session,
      )

      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(1)
      expect(durable.sync).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          locals: expect.objectContaining({ user: { uuid: 'user-1', email: 'user@example.test' } }),
        }),
        { api: '20200115', items: [], command: { id: 'command-1', digest } },
      )
      expect(result).toEqual({
        digest,
        payload: { retrieved_items: [], command: { id: 'command-1', digest, status: 'committed' } },
      })
    })

    it('skips validate() in status when handed the STATUS authorization session', async () => {
      const { adapter, serviceProxy } = build()
      const authorization = await adapter.authorize(
        { identity, operation: 'STATUS', commandId: 'command-2', digest, payloadLength: 0 },
        new AbortController().signal,
      )
      expect(authorization).toMatchObject({ authorized: true, session: expect.any(Object) })

      await expect(
        adapter.status(
          { identity, commandId: 'command-2', digest },
          new AbortController().signal,
          (authorization as { session?: unknown }).session,
        ),
      ).resolves.toEqual({ status: 'COMMITTED', digest, payload: { retrieved_items: [] } })
      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(1)
    })

    it('revalidates when the supplied evidence is older than the freshness bound', async () => {
      let now = 1_000_000
      const { adapter, serviceProxy } = build({}, undefined, () => now)
      const authorization = await adapter.authorize(
        { identity, operation: 'COMMAND', commandId: 'command-1', digest, payloadLength: 1, payload },
        new AbortController().signal,
      )
      now += 5_001
      await adapter.execute(
        { identity, commandId: 'command-1', digest, payload },
        new AbortController().signal,
        (authorization as { session?: unknown }).session,
      )
      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(2)
    })

    it('reuses evidence that is exactly at the freshness bound', async () => {
      let now = 1_000_000
      const { adapter, serviceProxy } = build({}, undefined, () => now)
      const authorization = await adapter.authorize(
        { identity, operation: 'COMMAND', commandId: 'command-1', digest, payloadLength: 1, payload },
        new AbortController().signal,
      )
      now += 5_000
      await adapter.execute(
        { identity, commandId: 'command-1', digest, payload },
        new AbortController().signal,
        (authorization as { session?: unknown }).session,
      )
      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(1)
    })

    it('revalidates when the supplied evidence was minted for another identity', async () => {
      const { adapter, serviceProxy } = build()
      const authorization = await adapter.authorize(
        { identity, operation: 'COMMAND', commandId: 'command-1', digest, payloadLength: 1, payload },
        new AbortController().signal,
      )
      const other: SyncTicketIdentity = { ...identity, deviceId: 'device-2', sessionUuid: 'session-2' }
      // The fresh validation for `other` fails the identity check (the token is
      // for session-1), which proves the supplied evidence was NOT reused.
      await expect(
        adapter.execute(
          { identity: other, commandId: 'command-1', digest, payload },
          new AbortController().signal,
          (authorization as { session?: unknown }).session,
        ),
      ).rejects.toThrow(/identity changed/i)
      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['a look-alike object the adapter never produced', { locals: {}, token: {}, identity, validatedAt: Date.now() }],
      ['a string', 'session'],
      ['null', null],
      ['undefined', undefined],
    ])('revalidates when the supplied evidence is %s', async (_label, session) => {
      const { adapter, serviceProxy } = build()
      await adapter.execute(
        { identity, commandId: 'command-1', digest, payload },
        new AbortController().signal,
        session,
      )
      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(1)
    })

    it('never reuses evidence across adapter instances', async () => {
      const first = build()
      const second = build()
      const authorization = await first.adapter.authorize(
        { identity, operation: 'COMMAND', commandId: 'command-1', digest, payloadLength: 1, payload },
        new AbortController().signal,
      )
      await second.adapter.execute(
        { identity, commandId: 'command-1', digest, payload },
        new AbortController().signal,
        (authorization as { session?: unknown }).session,
      )
      expect(first.serviceProxy.validateSession).toHaveBeenCalledTimes(1)
      expect(second.serviceProxy.validateSession).toHaveBeenCalledTimes(1)
    })
  })

  it('delegates STATUS and returns the exact committed result for reconnect recovery', async () => {
    const { adapter, durable } = build()
    const digest = 'b'.repeat(64)
    await expect(
      adapter.status({ identity, commandId: 'command-2', digest }, new AbortController().signal),
    ).resolves.toEqual({ status: 'COMMITTED', digest, payload: { retrieved_items: [] } })
    expect(durable.getSyncCommandStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'command-2', digest)
  })

  // -------------------------------------------------------------------------
  // The collaboration seam. This adapter is the ONLY bridge between the socket
  // and the capability minter, and it is the thing that decides which session
  // state the minter gets to see. The minter's own policy is covered by
  // CollaborationAuthorizationService.spec.ts; what matters here is that a
  // caller can never reach it unvalidated, and can never choose the session
  // context it is judged against.
  // -------------------------------------------------------------------------
  describe('authorizeCollaboration', () => {
    it('CONTROL: a valid session reaches the minter with freshly validated session state', async () => {
      const collaboration = collaborationService()
      const { adapter, serviceProxy } = build({}, collaboration)
      const signal = new AbortController().signal

      const result = await adapter.authorizeCollaboration(collaborationInput, signal)

      expect(collaboration.authorize).toHaveBeenCalledTimes(1)
      const [, passedLocals, passedRequest, passedSignal] = (collaboration.authorize as jest.Mock).mock.calls[0]
      // The identity handed to the minter is derived from the re-verified token,
      // never from anything the socket client supplied.
      expect(passedLocals).toMatchObject({
        user: { uuid: 'user-1', email: 'user@example.test' },
        readOnlyAccess: false,
        collaborationEnabled: true,
      })
      expect(passedRequest).toBe(collaborationInput.request)
      expect(passedSignal).toBe(signal)
      // Revalidated per call, not cached from an earlier command.
      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ authorized: true, capability: 'minted-capability' })
    })

    it('revalidates the session on EVERY collaboration authorization', async () => {
      const collaboration = collaborationService()
      const { adapter, serviceProxy } = build({}, collaboration)

      await adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)
      await adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)

      expect(serviceProxy.validateSession).toHaveBeenCalledTimes(2)
    })

    it('refuses without a collaboration service configured', async () => {
      const { adapter, serviceProxy } = build()

      await expect(adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)).resolves.toEqual({
        authorized: false,
      })
      // Not even the session is probed: the feature is simply absent.
      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
    })

    it('refuses without minting when the collaboration service is not ready', async () => {
      const collaboration = collaborationService({ ready: false })
      const { adapter, serviceProxy } = build({}, collaboration)

      await expect(adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)).resolves.toEqual({
        authorized: false,
      })
      expect(collaboration.authorize).not.toHaveBeenCalled()
      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
    })

    it.each([
      ['a revoked session', { session: { uuid: 'different-session', readonly_access: false } }],
      ['a hijacked user identity', { user: { uuid: 'user-2', email: 'other@example.test' } }],
    ])('refuses %s WITHOUT reaching the minter', async (_label, claims) => {
      const collaboration = collaborationService()
      const { adapter } = build(claims, collaboration)

      await expect(adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)).resolves.toEqual({
        authorized: false,
      })
      // The critical assertion: a mismatched session must not merely be denied
      // downstream, it must never be presented to the minter at all.
      expect(collaboration.authorize).not.toHaveBeenCalled()
    })

    it('refuses WITHOUT reaching the minter when the socket carries no bearer credential', async () => {
      const collaboration = collaborationService()
      const { adapter, serviceProxy } = build({}, collaboration)

      await expect(
        adapter.authorizeCollaboration(
          { ...collaborationInput, identity: { ...identity, authorization: undefined } },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ authorized: false })
      expect(collaboration.authorize).not.toHaveBeenCalled()
      expect(serviceProxy.validateSession).not.toHaveBeenCalled()
    })

    it('hands the minter the AUTHORITATIVE read-only state rather than a caller claim', async () => {
      const collaboration = collaborationService()
      const { adapter } = build({ session: { uuid: 'session-1', readonly_access: true } }, collaboration)

      await adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)

      const [, passedLocals] = (collaboration.authorize as jest.Mock).mock.calls[0]
      expect(passedLocals).toMatchObject({ readOnlyAccess: true })
      expect(passedLocals.session).toMatchObject({ readonly_access: true })
    })

    it('hands the minter the AUTHORITATIVE collaboration feature gate', async () => {
      const collaboration = collaborationService()
      const { adapter } = build({ collaboration_enabled: false }, collaboration)

      await adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)

      const [, passedLocals] = (collaboration.authorize as jest.Mock).mock.calls[0]
      expect(passedLocals).toMatchObject({ collaborationEnabled: false })
    })

    it('propagates a read-scoped MCP token to the minter as read-only', async () => {
      const collaboration = collaborationService()
      const { adapter } = build({ mcp_scope: { access: 'read' } }, collaboration)

      await adapter.authorizeCollaboration(collaborationInput, new AbortController().signal)

      const [, passedLocals] = (collaboration.authorize as jest.Mock).mock.calls[0]
      expect(passedLocals).toMatchObject({ readOnlyAccess: true, mcpScope: { access: 'read' } })
    })

    it('reports collaboration readiness only when the whole chain is ready', () => {
      const collaboration = collaborationService()
      expect(build({}, collaboration).adapter.collaborationAuthorizationReady()).toBe(true)
      expect(build().adapter.collaborationAuthorizationReady()).toBe(false)
      expect(build({}, collaborationService({ ready: false })).adapter.collaborationAuthorizationReady()).toBe(false)

      const { serviceProxy, durable } = build()
      expect(
        new SyncWebSocketCommandAdapter(serviceProxy, durable, '', collaboration).collaborationAuthorizationReady(),
      ).toBe(false)
    })
  })

  it('is not ready without the JWT verifier, durable authentication, or status adapter', () => {
    const { serviceProxy, durable } = build()
    expect(new SyncWebSocketCommandAdapter(serviceProxy, durable, '').ready()).toBe(false)
    expect(
      new SyncWebSocketCommandAdapter(
        serviceProxy,
        { ...durable, durableCommandAuthenticationReady: () => false },
        JWT_SECRET,
      ).ready(),
    ).toBe(false)
    expect(
      new SyncWebSocketCommandAdapter(
        serviceProxy,
        { ...durable, getSyncCommandStatus: undefined } as never,
        JWT_SECRET,
      ).ready(),
    ).toBe(false)
  })
})
