import 'reflect-metadata'

import * as http from 'http'
import { AddressInfo } from 'net'
import { json, NextFunction, Request, Response } from 'express'
import { Container, injectable } from 'inversify'
import { BaseMiddleware, InversifyExpressServer } from 'inversify-express-utils'

import { TYPES } from '../Bootstrap/Types'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { EndpointResolver } from '../Service/Resolver/EndpointResolver'
import { canonicalAdminIdentifier, canonicalizeAdminRequest } from './AdminUuidCanonicalizer'
import { AdminController } from './v1/AdminController'

jest.mock('../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

// Referenced so the @controller metadata is registered before build().
void AdminController

const ACCOUNT = '3a9102fa-f130-4506-b030-7c6d123dfa18'
const OTHER = '6d29edf1-0866-40fd-be34-fb3c717679ff'
const GROUP = '630ce12f-3f78-42d5-9732-51de23f51ff2'

type Forwarded = { service: 'auth' | 'syncing'; endpoint: string; payload: unknown; params: Record<string, unknown> }

/** Stands in for session validation only: the request is an administrator's. */
@injectable()
class AdministratorSession extends BaseMiddleware {
  handler(_request: Request, response: Response, next: NextFunction): void {
    Object.assign(response.locals, { user: { uuid: OTHER }, roles: [{ uuid: 'r', name: 'ADMIN_USER' }] })
    next()
  }
}

/**
 * Standard Red Notes: the REAL `AdminController` behind the REAL router, real
 * HTTP requests, and the real endpoint resolver -- everything up to the point
 * where the gateway hands a request to another service, which is recorded.
 *
 * What is being pinned is what LEAVES the gateway. An account asked about in
 * upper case used to leave it in upper case, and each service then looked up a
 * string that matches no account on SQLite: the note-bytes read answered a
 * measured zero, the flags read answered defaults, a flags write answered 500.
 * The record below is the proxied path on the compose stack and the request the
 * in-process handler reads on the all-in-one, so both topologies are covered by
 * one assertion each.
 */
describe('uuids entering /v1/admin', () => {
  let server: http.Server
  let baseUrl: string
  let forwarded: Forwarded[]

  const boot = async (isConfiguredForHomeServer: boolean): Promise<void> => {
    forwarded = []
    const record =
      (service: Forwarded['service']) =>
      async (request: Request, response: Response, endpoint: string, payload?: unknown): Promise<void> => {
        forwarded.push({ service, endpoint, payload, params: { ...request.params } })
        response.status(200).json({ ok: true })
      }
    const container = new Container()
    container.bind(TYPES.ApiGateway_ServiceProxy).toConstantValue({
      callAuthServer: record('auth'),
      callSyncingServer: record('syncing'),
    } as unknown as ServiceProxyInterface)
    container.bind(TYPES.ApiGateway_EndpointResolver).toConstantValue(new EndpointResolver(isConfiguredForHomeServer))
    container.bind(TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware).to(AdministratorSession)

    const inversifyServer = new InversifyExpressServer(container)
    inversifyServer.setConfig((app) => {
      app.use(json())
    })
    const app = await inversifyServer.build()
    server = app.listen(0)
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  const send = (method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const request = http.request(
        `${baseUrl}${path}`,
        { method, headers: payload === undefined ? {} : { 'content-type': 'application/json' } },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => (text += chunk))
          response.on('end', () => resolve({ status: response.statusCode as number, body: text }))
        },
      )
      request.on('error', reject)
      request.end(payload)
    })

  afterEach((done) => {
    server.close(() => done())
  })

  describe('on the compose stack (requests are proxied by path)', () => {
    beforeEach(() => boot(false))

    it('asks auth about the account, not about an upper-case string that names nobody', async () => {
      await send('GET', `/v1/admin/users/${ACCOUNT.toUpperCase()}/feature-flags`)

      expect(forwarded).toEqual([
        {
          service: 'auth',
          endpoint: `admin/users/${ACCOUNT}/feature-flags`,
          payload: undefined,
          params: { userUuid: ACCOUNT },
        },
      ])
    })

    it('writes to the account, not to an upper-case string', async () => {
      await send('PUT', `/v1/admin/users/${ACCOUNT.toUpperCase()}/feature-flags`, { name: 'AI_ENABLED', value: 'true' })
      await send('PUT', `/v1/admin/users/${ACCOUNT.toUpperCase()}/admin-role`, { granted: true })
      await send('DELETE', `/v1/admin/users/${ACCOUNT.toUpperCase()}`, { confirmEmail: 'a@example.com' })

      expect(forwarded.map((call) => call.endpoint)).toEqual([
        `admin/users/${ACCOUNT}/feature-flags`,
        `admin/users/${ACCOUNT}/admin-role`,
        `admin/users/${ACCOUNT}`,
      ])
      // The body is the caller's own and is forwarded as sent.
      expect(forwarded[0].payload).toEqual({ name: 'AI_ENABLED', value: 'true' })
    })

    it('asks the syncing server for stored note bytes by canonical account uuid, in the order asked', async () => {
      await send('POST', '/v1/admin/item-storage-usage', {
        userUuids: [ACCOUNT.toUpperCase(), OTHER, 'not-a-uuid', 42],
      })

      expect(forwarded).toHaveLength(1)
      expect(forwarded[0]).toMatchObject({ service: 'syncing', endpoint: 'items/storage-usage/by-user' })
      // What is not a uuid is left exactly as sent, for the handler to refuse by name.
      expect(forwarded[0].payload).toEqual({ userUuids: [ACCOUNT, OTHER, 'not-a-uuid', 42] })
    })

    it('canonicalises every uuid in the path and the member named in the body', async () => {
      await send('POST', `/v1/admin/groups/${GROUP.toUpperCase()}/members`, { userUuid: ACCOUNT.toUpperCase() })
      await send('DELETE', `/v1/admin/groups/${GROUP.toUpperCase()}/members/${ACCOUNT.toUpperCase()}`)

      expect(forwarded.map((call) => [call.endpoint, call.payload])).toEqual([
        [`admin/groups/${GROUP}/members`, { userUuid: ACCOUNT }],
        [`admin/groups/${GROUP}/members/${ACCOUNT}`, undefined],
      ])
    })

    it('leaves a path parameter that is not a uuid exactly as sent', async () => {
      await send('GET', '/v1/admin/users/Mixed.Case%40Example.com/ban-status')

      expect(forwarded[0].params).toEqual({ email: 'Mixed.Case@Example.com' })
    })

    it('answers the gateway’s own per-account read under the canonical uuid', async () => {
      const result = await send('GET', `/v1/admin/users/${ACCOUNT.toUpperCase()}/usage`)

      // Answered by the gateway itself, never proxied: before, it answered for an
      // account of the upper-case name, which does not exist.
      expect(forwarded).toEqual([])
      expect(result.status).toBe(200)
      expect(JSON.parse(result.body).userUuid).toBe(ACCOUNT)
    })
  })

  describe('on the all-in-one container (handlers are called in-process with the same request)', () => {
    beforeEach(() => boot(true))

    it('hands the in-process handler a request that names the account canonically', async () => {
      await send('GET', `/v1/admin/users/${ACCOUNT.toUpperCase()}/effective-permissions`)
      await send('POST', `/v1/admin/users/${ACCOUNT.toUpperCase()}/fix-quota`)

      expect(forwarded.map((call) => [call.endpoint, call.params])).toEqual([
        ['admin.getUserEffectivePermissions', { userUuid: ACCOUNT }],
        ['admin.fixUserQuota', { userUuid: ACCOUNT }],
      ])
    })

    it('hands the syncing handler canonical account uuids in the body it will read', async () => {
      await send('POST', '/v1/admin/item-storage-usage', { userUuids: [ACCOUNT.toUpperCase()] })

      expect(forwarded[0]).toMatchObject({
        service: 'syncing',
        endpoint: 'sync.items.storage_usage_for_users',
        payload: { userUuids: [ACCOUNT] },
      })
    })
  })
})

describe('canonicalAdminIdentifier', () => {
  it('lower-cases a uuid in any spelling and nothing else', () => {
    expect(canonicalAdminIdentifier(ACCOUNT.toUpperCase())).toBe(ACCOUNT)
    expect(canonicalAdminIdentifier(ACCOUNT)).toBe(ACCOUNT)
    expect(canonicalAdminIdentifier('Mixed.Case@Example.com')).toBe('Mixed.Case@Example.com')
    expect(canonicalAdminIdentifier('singletier-PRO_USER')).toBe('singletier-PRO_USER')
    expect(canonicalAdminIdentifier(`${ACCOUNT.toUpperCase()}/..`)).toBe(`${ACCOUNT.toUpperCase()}/..`)
    expect(canonicalAdminIdentifier(42)).toBe(42)
    expect(canonicalAdminIdentifier(undefined)).toBeUndefined()
  })
})

describe('canonicalizeAdminRequest on a request that is not the usual shape', () => {
  it.each([undefined, null, 'text', ['A']])('leaves a %p body alone and still canonicalises the path', (body) => {
    const request = { params: { userUuid: ACCOUNT.toUpperCase() }, body } as unknown as Request

    canonicalizeAdminRequest(request)

    expect(request.params.userUuid).toBe(ACCOUNT)
    expect(request.body).toEqual(body)
  })

  // The unit suites call handlers with bare fakes; a wrapper that threw on one
  // would turn every admin route into a 500 for a request Express never builds.
  it('does not throw for a request with no parameters, or for no request at all', () => {
    expect(() => canonicalizeAdminRequest({} as Request)).not.toThrow()
    expect(() => canonicalizeAdminRequest({ params: null, body: { userUuid: 7 } } as unknown as Request)).not.toThrow()
    expect(() => canonicalizeAdminRequest(undefined as unknown as Request)).not.toThrow()
  })
})
