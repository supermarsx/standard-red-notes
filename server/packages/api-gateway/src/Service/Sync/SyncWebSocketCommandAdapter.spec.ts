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
    adapter: new SyncWebSocketCommandAdapter(serviceProxy, durable, JWT_SECRET, collaboration),
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

    expect(authorization).toEqual({ authorized: true })
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
    ['live-sync revocation', { live_sync_enabled: false }, 'SHADOW_BANNED'],
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

  it('maps revoked/mismatched sessions to SESSION_REVOKED without calling the durable executor', async () => {
    const { adapter, durable } = build({ session: { uuid: 'different-session', readonly_access: false } })
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
    ).resolves.toEqual({ authorized: false, code: 'SESSION_REVOKED' })
    expect(durable.sync).not.toHaveBeenCalled()
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
