import jwt from 'jsonwebtoken'
import type { JsonObject, SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
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

function build(overrides: Record<string, unknown> = {}): {
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
  return { adapter: new SyncWebSocketCommandAdapter(serviceProxy, durable, JWT_SECRET), serviceProxy, durable }
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
