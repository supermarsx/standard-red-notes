import jwt from 'jsonwebtoken'
import {
  isValidSyncTicketIdentity,
  syncTicketIdentitySecretValues,
  type SyncTicketIdentity,
} from '@standard-red-notes/websocket-gateway'

import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { LoopbackSyncApiRpcAdapter } from './LoopbackSyncApiRpcAdapter'
import { captureSessionCookies, sessionCookiesToHeader, sessionCookiesToMap } from './sessionCookies'
import { DurableSyncCommandPort, SyncWebSocketCommandAdapter } from './SyncWebSocketCommandAdapter'

/**
 * Standard Red Notes: the socket lanes could not authenticate a COOKIE-BASED session.
 *
 * Auth's `GetSessionFromToken` gives such a session exactly one route: its
 * `COOKIE_SESSION_TOKEN_VERSION` branch reads `authCookies.get('access_token_<uuid>')`
 * and returns `Invalid token` when it is absent, while its header-token branch refuses
 * outright any session whose `version === COOKIE_BASED_SESSION_VERSION`. So a bearer
 * alone can NEVER validate one. `AuthMiddleware` passes cookies on every ordinary HTTP
 * request; no socket lane did, because `SyncTicketIdentity` had no field to carry them.
 *
 * Every lane was therefore refused on every command, deterministically — surfacing as
 * SESSION_STALE, and (because the client had already sent its COMMAND frame) entering
 * durable recovery rather than the HTTP fallback, so saves were lost silently.
 *
 * WHY THE EXISTING SPECS MISSED IT: `SyncWebSocketCommandAdapter.spec.ts` stubs the
 * service proxy with a `validateSession` that returns 200 unconditionally, so it can
 * never observe a missing credential. The fake below instead enforces auth's REAL rule,
 * which is what makes these tests fail against the unfixed code.
 */

const JWT_SECRET = 'cookie-session-test-secret'
const SESSION_UUID = 'session-1'
const ACCESS_TOKEN_COOKIE = `access_token_${SESSION_UUID}`
const COOKIE_VALUE = 'cookie-access-token-value'

const cookieIdentity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: SESSION_UUID,
  deviceId: 'device-1',
  authorization: 'Bearer 2:private-identifier',
  sessionCookies: { [ACCESS_TOKEN_COOKIE]: [COOKIE_VALUE] },
}

function crossServiceToken(): string {
  return jwt.sign(
    {
      user: { uuid: 'user-1', email: 'user@example.test' },
      session: { uuid: SESSION_UUID, readonly_access: false },
      roles: [{ name: 'CORE_USER' }],
      belongs_to_shared_vaults: [],
      hasContentLimit: false,
      live_sync_enabled: true,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

/**
 * Mirrors `GetSessionFromToken`'s cookie branch: a version-2 token authenticates only
 * when the matching `access_token_<uuid>` cookie is supplied, and otherwise answers the
 * same 401 `invalid-auth` auth returns.
 */
function authRuleProxy(): { proxy: ServiceProxyInterface; calls: { cookies?: Map<string, string[]> }[] } {
  const calls: { cookies?: Map<string, string[]> }[] = []
  const proxy = {
    validateSession: jest.fn(async (dto: { headers: { authorization: string }; cookies?: Map<string, string[]> }) => {
      calls.push({ cookies: dto.cookies })
      const isCookieBasedToken = dto.headers.authorization.startsWith('2:')
      if (isCookieBasedToken) {
        const supplied = dto.cookies?.get(ACCESS_TOKEN_COOKIE)
        if (supplied === undefined || supplied.length === 0 || supplied[0] !== COOKIE_VALUE) {
          return {
            status: 401,
            data: { error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } },
            headers: { contentType: 'application/json' },
          }
        }
      }
      return {
        status: 200,
        data: { authToken: crossServiceToken() },
        headers: { contentType: 'application/json' },
      }
    }),
  } as unknown as ServiceProxyInterface
  return { proxy, calls }
}

function durablePort(): DurableSyncCommandPort {
  return {
    durableCommandAuthenticationReady: jest.fn(() => true),
    sync: jest.fn(async () => ({ status: 200, data: {} })),
    getSyncCommandStatus: jest.fn(async () => ({ status: 200, data: {} })),
  }
}

const signal = (): AbortSignal => new AbortController().signal

describe('cookie-based session credential on the socket lanes', () => {
  describe('capture and projection', () => {
    it('captures only access-token cookies and preserves a value containing "="', () => {
      expect(captureSessionCookies(`theme=dark; ${ACCESS_TOKEN_COOKIE}=abc=def==; other_token=nope`)).toEqual({
        [ACCESS_TOKEN_COOKIE]: ['abc=def=='],
      })
    })

    it('returns undefined rather than an empty map when nothing matched', () => {
      expect(captureSessionCookies('theme=dark; locale=en')).toBeUndefined()
      expect(captureSessionCookies('')).toBeUndefined()
      expect(captureSessionCookies(undefined)).toBeUndefined()
    })

    it('projects to the Map shape AuthMiddleware builds, and to a Cookie header', () => {
      const captured = captureSessionCookies(`${ACCESS_TOKEN_COOKIE}=${COOKIE_VALUE}`)
      expect(sessionCookiesToMap(captured)?.get(ACCESS_TOKEN_COOKIE)).toEqual([COOKIE_VALUE])
      expect(sessionCookiesToHeader(captured)).toBe(`${ACCESS_TOKEN_COOKIE}=${COOKIE_VALUE}`)
      expect(sessionCookiesToMap(undefined)).toBeUndefined()
      expect(sessionCookiesToHeader(undefined)).toBeUndefined()
    })
  })

  describe('the sync lane', () => {
    it('authorizes a cookie-based session (FAILS as SESSION_STALE without the captured cookie)', async () => {
      const { proxy, calls } = authRuleProxy()
      const adapter = new SyncWebSocketCommandAdapter(proxy, durablePort(), JWT_SECRET)

      await expect(
        adapter.authorize(
          {
            identity: cookieIdentity,
            operation: 'COMMAND',
            commandId: 'command-1',
            digest: 'digest-1',
            payloadLength: 2,
            payload: { command: 'SYNC_ITEMS', body: { items: [] } },
          },
          signal(),
        ),
      ).resolves.toMatchObject({ authorized: true })

      expect(calls).toHaveLength(1)
      expect(calls[0].cookies?.get(ACCESS_TOKEN_COOKIE)).toEqual([COOKIE_VALUE])
    })

    it('still refuses as SESSION_STALE when the ticket genuinely carries no cookie', async () => {
      const { proxy } = authRuleProxy()
      const adapter = new SyncWebSocketCommandAdapter(proxy, durablePort(), JWT_SECRET)
      const { sessionCookies: _dropped, ...withoutCookies } = cookieIdentity

      await expect(
        adapter.authorize(
          {
            identity: withoutCookies,
            operation: 'COMMAND',
            commandId: 'command-1',
            digest: 'digest-1',
            payloadLength: 2,
            payload: { command: 'SYNC_ITEMS', body: { items: [] } },
          },
          signal(),
        ),
      ).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
    })

    it('authorizes a STATUS query the same way, so durable recovery can complete', async () => {
      const { proxy } = authRuleProxy()
      const adapter = new SyncWebSocketCommandAdapter(proxy, durablePort(), JWT_SECRET)

      await expect(
        adapter.authorize(
          {
            identity: cookieIdentity,
            operation: 'STATUS',
            commandId: 'command-1',
            digest: 'digest-1',
            payloadLength: 0,
          },
          signal(),
        ),
      ).resolves.toMatchObject({ authorized: true })
    })
  })

  describe('the API_RPC lane', () => {
    it('sends the captured cookie as a real Cookie header on the loopback request', async () => {
      const fetch = jest.fn(async () => Response.json({ ok: true }))
      const adapter = new LoopbackSyncApiRpcAdapter({
        origin: 'http://127.0.0.1:3000',
        operations: ['API_RPC'],
        fetch: fetch as unknown as typeof globalThis.fetch,
      })

      await adapter.execute(
        {
          identity: cookieIdentity,
          method: 'GET',
          path: '/v1/assistant/subscription/usage',
          headers: {},
          stream: false,
        },
        signal(),
      )

      const headers = fetch.mock.calls[0][1].headers as Headers
      expect(headers.get('cookie')).toBe(`${ACCESS_TOKEN_COOKIE}=${COOKIE_VALUE}`)
    })

    it('never lets a client-supplied cookie header reach our own gateway', async () => {
      const fetch = jest.fn(async () => Response.json({ ok: true }))
      const adapter = new LoopbackSyncApiRpcAdapter({
        origin: 'http://127.0.0.1:3000',
        operations: ['API_RPC'],
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
      const { sessionCookies: _dropped, ...withoutCookies } = cookieIdentity

      await adapter.execute(
        {
          identity: withoutCookies,
          method: 'GET',
          path: '/v1/assistant/subscription/usage',
          headers: { cookie: `${ACCESS_TOKEN_COOKIE}=forged` },
          stream: false,
        },
        signal(),
      )

      const headers = fetch.mock.calls[0][1].headers as Headers
      expect(headers.get('cookie')).toBeNull()
    })
  })

  describe('identity validation', () => {
    it('accepts a captured access-token cookie and rejects anything else', () => {
      expect(isValidSyncTicketIdentity(cookieIdentity)).toBe(true)
      expect(isValidSyncTicketIdentity({ ...cookieIdentity, sessionCookies: undefined })).toBe(true)
      // Not an access-token cookie: a caller that copied the whole jar is refused
      // rather than silently writing a browser's cookies into the ticket store.
      expect(isValidSyncTicketIdentity({ ...cookieIdentity, sessionCookies: { theme: ['dark'] } })).toBe(false)
      expect(isValidSyncTicketIdentity({ ...cookieIdentity, sessionCookies: {} })).toBe(false)
      expect(isValidSyncTicketIdentity({ ...cookieIdentity, sessionCookies: { [ACCESS_TOKEN_COOKIE]: [] } })).toBe(
        false,
      )
      expect(
        isValidSyncTicketIdentity({
          ...cookieIdentity,
          sessionCookies: { [ACCESS_TOKEN_COOKIE]: ['x'.repeat(16_385)] },
        }),
      ).toBe(false)
    })
  })

  describe('the credential must never leave the server', () => {
    it('enumerates every secret in the identity, so leak scans cannot miss a new field', () => {
      const secrets = syncTicketIdentitySecretValues(cookieIdentity)
      expect(secrets).toContain(COOKIE_VALUE)
      expect(secrets).toContain('Bearer 2:private-identifier')
      expect(secrets).toContain('2:private-identifier')
      expect(
        syncTicketIdentitySecretValues({ ...cookieIdentity, authorization: undefined, sessionCookies: undefined }),
      ).toEqual([])
    })

    it('keeps no secret in an authorization DECISION, which is what crosses back to the handler', async () => {
      const { proxy } = authRuleProxy()
      const adapter = new SyncWebSocketCommandAdapter(proxy, durablePort(), JWT_SECRET)

      const decision = await adapter.authorize(
        {
          identity: cookieIdentity,
          operation: 'COMMAND',
          commandId: 'command-1',
          digest: 'digest-1',
          payloadLength: 2,
          payload: { command: 'SYNC_ITEMS', body: { items: [] } },
        },
        signal(),
      )

      // The decision carries a validated session for reuse; assert no captured
      // credential rides along inside it.
      const serialized = JSON.stringify(decision)
      for (const secret of syncTicketIdentitySecretValues(cookieIdentity)) {
        expect(serialized).not.toContain(secret)
      }
    })
  })
})
