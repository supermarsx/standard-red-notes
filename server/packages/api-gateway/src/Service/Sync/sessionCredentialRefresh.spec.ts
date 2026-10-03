import jwt from 'jsonwebtoken'
import type { SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { SyncWebSocketCommandAdapter } from './SyncWebSocketCommandAdapter'

/**
 * Standard Red Notes: `SyncWebSocketCommandAdapter.refreshSession` — the half of
 * the socket credential-rotation fix that decides whether a live socket may
 * adopt a presented credential, and whether it survives if it may not.
 *
 * The verdict this file exists to pin is the dangerous one. Auth reports a
 * session that no longer authenticates with a 401, and a plain SIGN-OUT lands
 * there: `DeleteSessionByToken` deletes the session row and writes NO
 * `revoked_session` record, so logout answers 401 `invalid-auth` rather than 401
 * `revoked-session`. Classifying on the TAG alone would therefore have treated
 * every logout as a refreshable stale token. The classification is on the
 * STATUS, so both reach SESSION_REVOKED and the handler terminates the lane.
 *
 * WHY THE NEIGHBOURING SPEC CANNOT SEE THIS: `SyncWebSocketCommandAdapter.spec.ts`
 * stubs `validateSession` to answer 200 unconditionally, so it can never observe
 * a refusal at all, let alone tell one refusal from another.
 */

const JWT_SECRET = 'credential-refresh-test-secret'
const USER_UUID = 'user-1'
const SESSION_UUID = 'session-1'
const ACCESS_TOKEN_COOKIE = `access_token_${SESSION_UUID}`
const ROTATED_COOKIE_VALUE = 'cookie-access-token-rotated'

/** A cookie-based session: `2:<privateIdentifier>` carries no secret of its own. */
const cookieIdentity: SyncTicketIdentity = {
  userUuid: USER_UUID,
  sessionUuid: SESSION_UUID,
  deviceId: 'device-1',
  authorization: 'Bearer 2:private-identifier',
  sessionCookies: { [ACCESS_TOKEN_COOKIE]: [ROTATED_COOKIE_VALUE] },
}

/** A header-based session: `1:<sessionUuid>:<accessToken>` needs no cookie. */
const headerIdentity: SyncTicketIdentity = {
  userUuid: USER_UUID,
  sessionUuid: SESSION_UUID,
  deviceId: 'device-1',
  authorization: `Bearer 1:${SESSION_UUID}:rotated-access-token`,
}

function crossServiceToken(overrides: { userUuid?: string; sessionUuid?: string } = {}): string {
  return jwt.sign(
    {
      user: { uuid: overrides.userUuid ?? USER_UUID, email: 'user@example.test' },
      session: { uuid: overrides.sessionUuid ?? SESSION_UUID, readonly_access: false },
      roles: [{ name: 'CORE_USER' }],
      belongs_to_shared_vaults: [],
      hasContentLimit: false,
      live_sync_enabled: true,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}

type AuthAnswer = { status: number; data: unknown }

function proxyAnswering(answer: AuthAnswer | (() => AuthAnswer | never)): {
  proxy: ServiceProxyInterface
  calls: Array<{ authorization: string; cookies?: Map<string, string[]>; url: string }>
} {
  const calls: Array<{ authorization: string; cookies?: Map<string, string[]>; url: string }> = []
  const proxy = {
    validateSession: jest.fn(
      async (dto: {
        headers: { authorization: string }
        cookies?: Map<string, string[]>
        requestMetadata: { url: string }
      }) => {
        calls.push({
          authorization: dto.headers.authorization,
          cookies: dto.cookies,
          url: dto.requestMetadata.url,
        })
        const resolved = typeof answer === 'function' ? answer() : answer
        return { ...resolved, headers: { contentType: 'application/json' } }
      },
    ),
  } as unknown as ServiceProxyInterface
  return { proxy, calls }
}

/** Auth's own refusal bodies, verbatim from `AuthenticateRequest`. */
const AUTH_REFUSALS = {
  /** `REVOKED_SESSION`: an explicit "sign out of this session" wrote a revocation record. */
  revokedSession: {
    status: 401,
    data: { error: { tag: 'revoked-session', message: 'Your session has been revoked.' } },
  },
  /** `INVALID_AUTH`: the session row is gone (plain logout), or the user is banned/unconfirmed. */
  invalidAuth: { status: 401, data: { error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } } },
  /** `EXPIRED_TOKEN`/`COOLEDDOWN_TOKEN`: the session is LIVE and this token is merely older. */
  expiredAccessToken: {
    status: 498,
    data: { error: { tag: 'expired-access-token', message: 'The provided access token has expired.' } },
  },
} as const

const signal = (): AbortSignal => new AbortController().signal

describe('SyncWebSocketCommandAdapter.refreshSession', () => {
  describe('adoption', () => {
    it('approves a rotated cookie credential and hands auth the cookie it needs', async () => {
      const { proxy, calls } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({ refreshed: true })

      expect(calls).toHaveLength(1)
      expect(calls[0].authorization).toBe('2:private-identifier')
      expect(calls[0].cookies?.get(ACCESS_TOKEN_COOKIE)).toEqual([ROTATED_COOKIE_VALUE])
    })

    it('approves a rotated header credential, which needs no cookie', async () => {
      const { proxy, calls } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: headerIdentity }, signal())).resolves.toEqual({ refreshed: true })
      expect(calls[0].cookies).toBeUndefined()
    })
  })

  describe('a session that no longer authenticates must not be refreshed', () => {
    it.each([
      ['an explicitly revoked session', AUTH_REFUSALS.revokedSession],
      ['a signed-out session, which auth reports as invalid-auth and NOT revoked-session', AUTH_REFUSALS.invalidAuth],
    ])('terminates the lane for %s', async (_name, refusal) => {
      const { proxy } = proxyAnswering(refusal)
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_REVOKED',
      })
    })

    it('terminates the lane when auth accepts the credential for a DIFFERENT identity', async () => {
      const { proxy } = proxyAnswering({
        status: 200,
        data: { authToken: crossServiceToken({ sessionUuid: 'someone-elses-session' }) },
      })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_REVOKED',
      })
    })

    it('terminates the lane when auth accepts the credential for a different USER', async () => {
      const { proxy } = proxyAnswering({
        status: 200,
        data: { authToken: crossServiceToken({ userUuid: 'someone-else' }) },
      })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_REVOKED',
      })
    })
  })

  describe('a live session with a merely older token is refreshable, never terminated', () => {
    it('reports SESSION_STALE for auth 498 expired-access-token', async () => {
      const { proxy } = proxyAnswering(AUTH_REFUSALS.expiredAccessToken)
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
    })

    it.each([
      ['auth answered 500', { status: 500, data: { error: { message: 'boom' } } }],
      ['auth answered 503', { status: 503, data: {} }],
      ['auth answered 200 with no token', { status: 200, data: { authToken: undefined } }],
      ['auth answered 200 with a non-object body', { status: 200, data: 'not json' }],
    ])('reports SESSION_STALE when the verdict is unreadable: %s', async (_name, answer) => {
      const { proxy } = proxyAnswering(answer)
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
    })

    it('reports SESSION_STALE when the cross-service token cannot be verified', async () => {
      const { proxy } = proxyAnswering({
        status: 200,
        data: { authToken: jwt.sign({ user: { uuid: USER_UUID } }, 'a-different-secret', { algorithm: 'HS256' }) },
      })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
    })

    it('reports SESSION_STALE when the auth call throws, and never SESSION_REVOKED', async () => {
      const { proxy } = proxyAnswering(() => {
        throw new Error('auth unreachable')
      })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
    })

    it('reports SESSION_STALE when the request is aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      const { proxy } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(adapter.refreshSession({ identity: cookieIdentity }, controller.signal)).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
    })
  })

  describe('a credential that cannot authenticate is refused without an auth call', () => {
    it('refuses a cookie-session bearer with no access-token cookie, and does NOT close the socket', async () => {
      const { proxy, calls } = proxyAnswering(AUTH_REFUSALS.invalidAuth)
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)
      const { sessionCookies: _dropped, ...withoutCookies } = cookieIdentity

      // Auth could only answer 401 here, and a 401 TERMINATES. A client that
      // minted its ticket where the browser withheld the cookie (a partitioned
      // or cross-site context) must not have its working socket closed for it,
      // so the shape is judged locally instead.
      await expect(adapter.refreshSession({ identity: withoutCookies }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
      expect(calls).toHaveLength(0)
    })

    it('refuses a cookie whose name belongs to another session', async () => {
      const { proxy, calls } = proxyAnswering(AUTH_REFUSALS.invalidAuth)
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(
        adapter.refreshSession(
          { identity: { ...cookieIdentity, sessionCookies: { access_token_other_session: ['value'] } } },
          signal(),
        ),
      ).resolves.toEqual({ refreshed: false, code: 'SESSION_STALE' })
      expect(calls).toHaveLength(0)
    })

    it.each([
      ['no bearer at all', undefined],
      ['an empty bearer', 'Bearer '],
    ])('refuses a ticket carrying %s', async (_name, authorization) => {
      const { proxy, calls } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      await expect(
        adapter.refreshSession({ identity: { ...headerIdentity, authorization } }, signal()),
      ).resolves.toEqual({ refreshed: false, code: 'SESSION_STALE' })
      expect(calls).toHaveLength(0)
    })

    it('refuses when the session plane is not configured at all', async () => {
      const { proxy, calls } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, '')

      await expect(adapter.refreshSession({ identity: headerIdentity }, signal())).resolves.toEqual({
        refreshed: false,
        code: 'SESSION_STALE',
      })
      expect(calls).toHaveLength(0)
    })
  })

  describe('the per-command path keeps its own, deliberately different classification', () => {
    it('still reports a 401 as the RETRYABLE SESSION_STALE for a command', async () => {
      // `authorize`'s stale is a recovery hint: the client re-tickets, and
      // re-ticketing goes through authenticated HTTP, so a session that cannot
      // authenticate cannot obtain a ticket. Collapsing a rotation past auth's
      // cooldown (a flat 401) to NOT_AUTHORIZED here would delete that
      // recovery, which is why `refreshSession` is a separate method and not a
      // change to this one.
      const { proxy } = proxyAnswering(AUTH_REFUSALS.invalidAuth)
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

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
      ).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
    })
  })

  /**
   * Standard Red Notes: the COLLABORATION lane used to collapse a stale
   * credential and a policy denial into the same `{ authorized: false }`, which
   * the handler publishes as NOT_AUTHORIZED. On the wire the two were
   * indistinguishable, so a client could not tell "refresh your credential" from
   * "you are not allowed to do this" -- and a client that guessed would turn
   * every legitimate denial into a pointless ticket mint plus a session-plane
   * call.
   *
   * The split reuses `refreshSession`'s classification verbatim (the shared
   * `classifyPresentedSessionCredential`, keyed on auth's STATUS and never on its
   * error tag), so the two lanes cannot drift into disagreeing about whether a
   * session is gone. The policy half is untouched: it is still the bare
   * `{ authorized: false }`.
   */
  describe('the collaboration lane says WHICH refusal it is', () => {
    const collaborationService = (authorized: boolean) => ({
      ready: () => true,
      authorize: jest.fn(async () => ({ authorized }) as never),
    })

    const collaborationInput = {
      identity: cookieIdentity,
      request: { noteUuid: 'note-1', collaborationProtocolVersion: 3 as const, epochDiscovery: true as const },
    }

    const adapterFor = (
      proxy: ServiceProxyInterface,
      collaboration: ReturnType<typeof collaborationService>,
    ): SyncWebSocketCommandAdapter =>
      new SyncWebSocketCommandAdapter(
        proxy,
        undefined,
        JWT_SECRET,
        collaboration as unknown as ConstructorParameters<typeof SyncWebSocketCommandAdapter>[3],
      )

    it.each([
      ['auth reports the token merely expired', AUTH_REFUSALS.expiredAccessToken],
      ['auth answered 500', { status: 500, data: { error: { message: 'boom' } } }],
      ['auth answered 200 with no token', { status: 200, data: {} }],
    ])('reports SESSION_STALE when %s', async (_name, refusal) => {
      const { proxy } = proxyAnswering(refusal)
      const collaboration = collaborationService(true)

      await expect(
        adapterFor(proxy, collaboration).authorizeCollaboration(collaborationInput, signal()),
      ).resolves.toEqual({ authorized: false, code: 'SESSION_STALE' })
      // The stale verdict is reached before the note is ever presented, which is
      // what keeps it from revealing whether the note exists.
      expect(collaboration.authorize).not.toHaveBeenCalled()
    })

    it.each([
      ['an explicitly revoked session', AUTH_REFUSALS.revokedSession],
      ['a signed-out session, which auth reports as invalid-auth', AUTH_REFUSALS.invalidAuth],
    ])('keeps %s on the unqualified denial', async (_name, refusal) => {
      // A session that is GONE cannot be repaired by presenting a newer token, so
      // it must not invite a refresh -- and it must stay indistinguishable from a
      // policy denial on the wire.
      const { proxy } = proxyAnswering(refusal)

      await expect(
        adapterFor(proxy, collaborationService(true)).authorizeCollaboration(collaborationInput, signal()),
      ).resolves.toEqual({ authorized: false })
    })

    it('keeps a credential auth accepts for ANOTHER identity on the unqualified denial', async () => {
      const { proxy } = proxyAnswering({
        status: 200,
        data: { authToken: crossServiceToken({ sessionUuid: 'someone-elses-session' }) },
      })

      await expect(
        adapterFor(proxy, collaborationService(true)).authorizeCollaboration(collaborationInput, signal()),
      ).resolves.toEqual({ authorized: false })
    })

    it('leaves a POLICY denial byte-identical to what it has always been', async () => {
      // The note does not exist, or exists and the caller may not read it, or
      // collaboration is off: one answer for all of them, with no `code` field at
      // all, so nothing here can become an existence oracle.
      const { proxy } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const collaboration = collaborationService(false)

      const result = await adapterFor(proxy, collaboration).authorizeCollaboration(collaborationInput, signal())

      expect(result).toEqual({ authorized: false })
      expect(Object.hasOwn(result, 'code')).toBe(false)
      expect(collaboration.authorize).toHaveBeenCalledTimes(1)
    })

    it('says nothing about the credential when the operation was aborted', async () => {
      // The handler's own timeout owns an abort; the session was never judged, so
      // the socket is told nothing about its credential.
      const controller = new AbortController()
      const { proxy } = proxyAnswering(() => {
        controller.abort()
        return AUTH_REFUSALS.expiredAccessToken
      })

      await expect(
        adapterFor(proxy, collaborationService(true)).authorizeCollaboration(collaborationInput, controller.signal),
      ).resolves.toEqual({ authorized: false })
    })
  })

  describe('the refreshed credential never crosses back to a client', () => {
    it('answers with a bare verdict carrying no credential material', async () => {
      const { proxy } = proxyAnswering({ status: 200, data: { authToken: crossServiceToken() } })
      const adapter = new SyncWebSocketCommandAdapter(proxy, undefined, JWT_SECRET)

      const decision = await adapter.refreshSession({ identity: cookieIdentity }, signal())
      const serialized = JSON.stringify(decision)
      expect(serialized).not.toContain(ROTATED_COOKIE_VALUE)
      expect(serialized).not.toContain('2:private-identifier')
    })
  })
})
