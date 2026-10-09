import 'reflect-metadata'

import { AxiosInstance } from 'axios'
import jwt from 'jsonwebtoken'
import type { Request, Response } from 'express'
import type { SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import { createDirectCallRequest } from './DirectCallRequest'
import { HttpServiceProxy } from '../Http/HttpServiceProxy'
import { CollaborationAuthorizationService } from './CollaborationAuthorizationService'
import { SyncWebSocketCommandAdapter } from './SyncWebSocketCommandAdapter'
import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'

/**
 * Standard Red Notes: the REQUEST side of the direct-call fabrication.
 *
 * `DirectCallResponse.ts` exists because `{ locals } as unknown as Response`
 * had no `setHeader` and failed 100 % of `SYNC_ITEMS` on the single container
 * while every build stayed green. Its twin,
 * `SyncWebSocketCommandAdapter.httpContext`, fabricated
 * `{ headers: { 'x-snjs-version': api } } as unknown as Request` -- and that one
 * was NOT merely latent. `HttpServiceProxy.getServerResponse`, which the
 * COLLABORATION_AUTHORIZE lane reaches on every multi-container deployment,
 * dispatches with `method: request.method as Method`; axios reads `undefined`
 * there as its default, GET. So a `POST items/collaboration-authorization`
 * left the gateway as a GET, the syncing server had no such route, and
 * `checkAccessWithSyncingServer` read the non-2xx as `{ authorized: false }`.
 *
 * Each case below is paired with the bare literal it replaced wherever the
 * literal is what makes the assertion meaningful: a spec that only states
 * "method is POST" would pass against a factory that hard-codes POST for every
 * lane, and would never have caught the lane that produced no method at all.
 */

const JWT_SECRET = 'direct-call-request-test-secret'
const USER_UUID = 'user-1'
const SESSION_UUID = 'session-1'

const identity: SyncTicketIdentity = {
  userUuid: USER_UUID,
  sessionUuid: SESSION_UUID,
  deviceId: 'device-1',
  authorization: `Bearer 1:${SESSION_UUID}:access-token`,
}

function crossServiceToken(): string {
  return jwt.sign(
    {
      user: { uuid: USER_UUID, email: 'user@example.test' },
      session: { uuid: SESSION_UUID, readonly_access: false },
      roles: [{ name: 'CORE_USER' }],
      belongs_to_shared_vaults: [],
      hasContentLimit: false,
      collaboration_enabled: true,
      live_sync_enabled: true,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

const buildResponse = (): Response =>
  ({
    locals: {},
    setHeader: jest.fn(),
    status: jest.fn().mockReturnValue({ send: jest.fn() }),
    send: jest.fn(),
  }) as unknown as Response

function captureAxios(): { client: AxiosInstance; config: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {}
  const client = {
    request: jest.fn((config: Record<string, unknown>) => {
      captured = config
      return Promise.resolve({ status: 200, data: {}, headers: { 'content-type': 'application/json' } })
    }),
  } as unknown as AxiosInstance
  return { client, config: () => captured }
}

const buildHttpProxy = (httpClient: AxiosInstance): HttpServiceProxy =>
  new HttpServiceProxy(
    httpClient,
    'http://auth',
    'http://syncing',
    'http://payments',
    'http://files',
    'http://ws',
    'http://revisions',
    'http://email',
    1000,
    { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() } as never,
    { error: jest.fn(), debug: jest.fn(), info: jest.fn() } as never,
    { sleep: jest.fn() } as never,
    '',
  )

describe('createDirectCallRequest', () => {
  it('states every field a service proxy reads off a request', () => {
    const request = createDirectCallRequest({
      method: 'post',
      url: '/items/sync?compute=1',
      headers: { 'X-Snjs-Version': '20200115' },
      body: { api: '20200115' },
      params: { commandId: 'command-1' },
      ip: '203.0.113.5',
    })

    expect(request.method).toBe('POST')
    expect(request.url).toBe('/items/sync?compute=1')
    expect(request.path).toBe('/items/sync')
    expect(request.originalUrl).toBe('/items/sync?compute=1')
    expect(request.ip).toBe('203.0.113.5')
    expect(request.ips).toEqual(['203.0.113.5'])
    expect(request.params).toEqual({ commandId: 'command-1' })
    expect(request.query).toEqual({})
    expect(request.body).toEqual({ api: '20200115' })
    expect(request.cookies).toEqual({})
    expect(typeof request.get).toBe('function')
    expect(typeof request.header).toBe('function')
  })

  it('lowercases header names, because every reader in the tree indexes with a lowercase literal', () => {
    const request = createDirectCallRequest({ headers: { 'X-Sync-Command-Digest': 'abc' } })

    // `BaseItemsController` reads `request.headers['x-sync-command-digest']`.
    // A header stored under the caller's capitalisation is a header nobody can
    // find, and Node would have lowercased it on a real request.
    expect(request.headers['x-sync-command-digest']).toBe('abc')
    expect(request.get('X-SYNC-COMMAND-DIGEST')).toBe('abc')
    expect(request.header('x-sync-command-digest')).toBe('abc')
  })

  it('keeps its accessors through an object spread', () => {
    const spread = { ...createDirectCallRequest({ headers: { accept: 'application/json' } }) } as Request

    // `DirectCallSyncCommandPort` used to re-shape its request with
    // `{ ...request, body, headers }`. A spread copies own enumerable
    // properties only, so a prototype-based fake would arrive at the controller
    // with its methods stripped off.
    expect(typeof spread.get).toBe('function')
    expect(spread.get('accept')).toBe('application/json')
    expect(spread.method).toBe('POST')
  })

  it('aliases referer/referrer and answers is() from the content type', () => {
    const request = createDirectCallRequest({
      headers: { referrer: 'https://app.example.test', 'content-type': 'application/json; charset=utf-8' },
    })

    expect(request.get('referer')).toBe('https://app.example.test')
    expect(request.is('json')).toBe('json')
    expect(request.is('xml')).toBe(false)
    expect(createDirectCallRequest().is('json')).toBeNull()
  })

  it('inherits from a supplied request and lets the overrides win', () => {
    const base = createDirectCallRequest({
      method: 'GET',
      url: '/items/sync-command',
      headers: { 'x-snjs-version': '20200115' },
      body: { original: true },
    })
    const derived = createDirectCallRequest({
      from: base,
      headers: { 'x-sync-command-digest': 'abc' },
      params: { commandId: 'command-1' },
    })

    expect(derived.method).toBe('GET')
    expect(derived.url).toBe('/items/sync-command')
    expect(derived.headers['x-snjs-version']).toBe('20200115')
    expect(derived.headers['x-sync-command-digest']).toBe('abc')
    expect(derived.params).toEqual({ commandId: 'command-1' })
    expect(derived.body).toEqual({ original: true })
  })

  it('makes HttpServiceProxy dispatch the verb the lane meant, where the bare literal dispatched none', async () => {
    const good = captureAxios()
    await buildHttpProxy(good.client).callSyncingServer(
      createDirectCallRequest({ method: 'POST', url: '/items/collaboration-authorization' }),
      buildResponse(),
      'items/collaboration-authorization',
      { itemUuid: 'note-1' },
    )

    expect(good.config().method).toBe('POST')
    expect((good.config().headers as Record<string, unknown>)['x-origin-method']).toBe('POST')
    expect((good.config().headers as Record<string, unknown>)['x-origin-url']).toBe(
      '/items/collaboration-authorization',
    )

    // THE NEGATIVE CONTROL, and the reason this file exists. The literal the
    // lane used to fabricate produces an axios config with NO method, which
    // axios sends as a GET -- so the POST-only route answered 404 and the
    // collaboration access check read that as "not authorized".
    const bare = captureAxios()
    await buildHttpProxy(bare.client).callSyncingServer(
      { headers: { 'x-snjs-version': '20200115' } } as unknown as Request,
      buildResponse(),
      'items/collaboration-authorization',
      { itemUuid: 'note-1' },
    )
    expect(bare.config().method).toBeUndefined()
  })
})

describe('SyncWebSocketCommandAdapter invite-event authorization', () => {
  /**
   * `INVITE_EVENTS` is the SESSION question, not the command one. An invite
   * invalidation is metadata about something that changed; it is not a write,
   * and an account that is read-only or over its content limit must still be
   * told. Folding it in with COMMAND would have turned "the lane finally
   * presents a credential" into "the lane is refused for a policy about
   * writes", which is a different defect with the same green build.
   */
  const adapterFor = (token: Record<string, unknown>): SyncWebSocketCommandAdapter => {
    const serviceProxy = {
      validateSession: jest.fn(async () => ({
        status: 200,
        data: { authToken: jwt.sign(token, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }) },
        headers: { contentType: 'application/json' },
      })),
    } as unknown as ServiceProxyInterface
    return new SyncWebSocketCommandAdapter(serviceProxy, undefined, JWT_SECRET)
  }

  const session = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    user: { uuid: USER_UUID, email: 'user@example.test' },
    session: { uuid: SESSION_UUID, readonly_access: false },
    roles: [{ name: 'CORE_USER' }],
    belongs_to_shared_vaults: [],
    hasContentLimit: false,
    live_sync_enabled: true,
    ...overrides,
  })

  const ask = (
    adapter: SyncWebSocketCommandAdapter,
    operation: 'COMMAND' | 'INVITE_EVENTS',
  ): ReturnType<SyncWebSocketCommandAdapter['authorize']> =>
    adapter.authorize(
      { identity, operation, commandId: 'command-1', digest: '', payloadLength: 0 },
      new AbortController().signal,
    )

  it('admits a read-only session to the invite stream while still refusing it a command', async () => {
    const adapter = adapterFor(session({ session: { uuid: SESSION_UUID, readonly_access: true } }))

    await expect(ask(adapter, 'INVITE_EVENTS')).resolves.toMatchObject({ authorized: true })
    await expect(ask(adapter, 'COMMAND')).resolves.toEqual({ authorized: false, code: 'READ_ONLY' })
  })

  it('admits an over-content-limit session to the invite stream', async () => {
    const adapter = adapterFor(session({ hasContentLimit: true }))

    await expect(ask(adapter, 'INVITE_EVENTS')).resolves.toMatchObject({ authorized: true })
    await expect(ask(adapter, 'COMMAND')).resolves.toEqual({ authorized: false, code: 'CONTENT_LIMIT' })
  })

  it('refuses the invite stream when the session itself no longer validates', async () => {
    const serviceProxy = {
      validateSession: jest.fn(async () => ({
        status: 401,
        data: { error: { tag: 'invalid-auth' } },
        headers: { contentType: 'application/json' },
      })),
    } as unknown as ServiceProxyInterface
    const adapter = new SyncWebSocketCommandAdapter(serviceProxy, undefined, JWT_SECRET)

    await expect(ask(adapter, 'INVITE_EVENTS')).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
  })
})

describe('SyncWebSocketCommandAdapter direct-call request', () => {
  const buildAdapter = (): {
    adapter: SyncWebSocketCommandAdapter
    requests: Array<{ method?: string; url?: string; headers?: unknown }>
  } => {
    const requests: Array<{ method?: string; url?: string; headers?: unknown }> = []
    const serviceProxy = {
      validateSession: jest.fn(async () => ({
        status: 200,
        data: { authToken: crossServiceToken() },
        headers: { contentType: 'application/json' },
      })),
      callSyncingServer: jest.fn(async (request: Request, response: Response) => {
        requests.push({ method: request.method, url: request.url, headers: request.headers })
        ;(response as unknown as { status: (code: number) => { send: (body: unknown) => void } })
          .status(200)
          .send({ authorized: true, serverUpdatedAtTimestamp: 1, collaborationSecurityEpoch: 'epoch-1' })
      }),
    } as unknown as ServiceProxyInterface
    const collaboration = new CollaborationAuthorizationService(
      serviceProxy,
      { resolveEndpointOrMethodIdentifier: () => 'items/collaboration-authorization' } as never,
      'collaboration-token-secret',
      60,
    )
    return {
      adapter: new SyncWebSocketCommandAdapter(serviceProxy, undefined, JWT_SECRET, collaboration),
      requests,
    }
  }

  it('hands the collaboration access check a POST for the route it is entering', async () => {
    const { adapter, requests } = buildAdapter()

    await adapter.authorizeCollaboration(
      { identity, request: { noteUuid: 'note-1', collaborationProtocolVersion: 3, epochDiscovery: true } },
      new AbortController().signal,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('/items/collaboration-authorization')
  })
})
