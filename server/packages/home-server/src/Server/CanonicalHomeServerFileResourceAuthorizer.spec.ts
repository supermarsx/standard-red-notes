import {
  ServiceContainer,
  ServiceIdentifier,
  type ServiceConfiguration,
  type ServiceInterface,
} from '@standardnotes/domain-core'
import { SESSION_ACCESS_TOKEN_COOKIE_PREFIX, type SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import {
  CanonicalHomeServerFileResourceAuthorizer,
  type HomeServerCrossServiceToken,
  type HomeServerPersonalValetToken,
  type HomeServerSessionValidationPort,
  type HomeServerSharedVaultValetToken,
  type HomeServerSignedTokenDecoder,
} from './CanonicalHomeServerFileResourceAuthorizer'

const USER_UUID = '11111111-1111-4111-8111-111111111111'
const SESSION_UUID = '22222222-2222-4222-8222-222222222222'
const FILE_UUID = '33333333-3333-4333-8333-333333333333'
const VAULT_UUID = '44444444-4444-4444-8444-444444444444'
const OWNER_UUID = '55555555-5555-4555-8555-555555555555'

const identity: SyncTicketIdentity = {
  userUuid: USER_UUID,
  sessionUuid: SESSION_UUID,
  deviceId: 'device-1',
  authorization: 'Bearer session-token',
}

/**
 * A COOKIE-BASED session, as auth mints one: the bearer is
 * `2:<privateIdentifier>` (`SessionService.COOKIE_SESSION_TOKEN_VERSION`) and the
 * only thing that can authenticate it is the `access_token_<sessionUuid>` cookie
 * the ticket captured alongside it.
 */
const COOKIE_NAME = `${SESSION_ACCESS_TOKEN_COOKIE_PREFIX}${SESSION_UUID}`
const COOKIE_VALUE = 'cookie-access-token-value'

const cookieSessionIdentity: SyncTicketIdentity = {
  ...identity,
  authorization: 'Bearer 2:private-identifier',
  sessionCookies: { [COOKIE_NAME]: [COOKIE_VALUE] },
}

const personalResource = {
  ownershipType: 'user' as const,
  fileUuid: FILE_UUID,
  remoteIdentifier: FILE_UUID,
}

const sharedResource = {
  ownershipType: 'shared-vault' as const,
  fileUuid: FILE_UUID,
  remoteIdentifier: FILE_UUID,
  sharedVaultUuid: VAULT_UUID,
  sharedVaultOwnerUuid: OWNER_UUID,
}

class TestService implements ServiceInterface {
  constructor(
    private readonly identifier: string,
    readonly handleRequest: jest.Mock = jest.fn(),
  ) {}

  getContainer(_configuration?: ServiceConfiguration): Promise<unknown> {
    return Promise.resolve(undefined)
  }

  getId(): ServiceIdentifier {
    return ServiceIdentifier.create(this.identifier).getValue()
  }
}

function baseAuthToken(overrides: Partial<HomeServerCrossServiceToken> = {}): HomeServerCrossServiceToken {
  return {
    user: { uuid: USER_UUID },
    roles: [],
    session: { uuid: SESSION_UUID, readonly_access: false },
    belongs_to_shared_vaults: [{ shared_vault_uuid: VAULT_UUID, permission: 'write' }],
    shared_vault_owner_context: { upload_bytes_limit: 1_000 },
    ...overrides,
  }
}

function personalValet(overrides: Partial<HomeServerPersonalValetToken> = {}): HomeServerPersonalValetToken {
  return {
    userUuid: USER_UUID,
    permittedOperation: 'write',
    permittedResources: [{ remoteIdentifier: FILE_UUID, unencryptedFileSize: 100 }],
    uploadBytesUsed: 100,
    uploadBytesLimit: 1_000,
    ...overrides,
  }
}

function sharedValet(overrides: Partial<HomeServerSharedVaultValetToken> = {}): HomeServerSharedVaultValetToken {
  return {
    sharedVaultUuid: VAULT_UUID,
    vaultOwnerUuid: OWNER_UUID,
    permittedOperation: 'read',
    remoteIdentifier: FILE_UUID,
    uploadBytesUsed: 100,
    uploadBytesLimit: 1_000,
    ...overrides,
  }
}

/**
 * Auth's own rule, not a convenience stub. `GetSessionFromToken` refuses the
 * header-token branch for a session whose version is
 * COOKIE_BASED_SESSION_VERSION and reads `access_token_<sessionUuid>` out of the
 * cookies instead; without that exact cookie it answers 401 `invalid-auth`. A
 * validator that ignored `cookies` could not tell the fix from the defect.
 */
const authLikeSessionValidation: HomeServerSessionValidationPort['validateSession'] = async (input) => {
  if (!input.headers.authorization.startsWith('2:')) {
    return { status: 200, data: { authToken: 'fresh-auth-token' } }
  }
  const presented = input.cookies?.get(COOKIE_NAME)
  if (!presented || presented[0] !== COOKIE_VALUE) {
    return { status: 401, data: { error: { tag: 'invalid-auth' } } }
  }
  return { status: 200, data: { authToken: 'fresh-auth-token' } }
}

function setup(
  options: {
    authToken?: HomeServerCrossServiceToken | undefined
    valetToken?: HomeServerPersonalValetToken | HomeServerSharedVaultValetToken | undefined
    sessionResult?: { status: number; data: unknown }
    sessionValidation?: HomeServerSessionValidationPort['validateSession']
    authServiceResult?: unknown
    syncServiceResult?: unknown
  } = {},
) {
  const sessionValidator: jest.Mocked<HomeServerSessionValidationPort> = {
    validateSession: options.sessionValidation
      ? jest.fn(options.sessionValidation)
      : jest.fn().mockResolvedValue(
          options.sessionResult ?? {
            status: 200,
            data: { authToken: 'fresh-auth-token' },
          },
        ),
  }
  const authTokenDecoder: jest.Mocked<HomeServerSignedTokenDecoder<HomeServerCrossServiceToken>> = {
    decodeToken: jest
      .fn()
      .mockReturnValue(
        Object.prototype.hasOwnProperty.call(options, 'authToken') ? options.authToken : baseAuthToken(),
      ),
  }
  const valetTokenDecoder: jest.Mocked<
    HomeServerSignedTokenDecoder<HomeServerPersonalValetToken | HomeServerSharedVaultValetToken>
  > = {
    decodeToken: jest
      .fn()
      .mockReturnValue(
        Object.prototype.hasOwnProperty.call(options, 'valetToken') ? options.valetToken : personalValet(),
      ),
  }
  const authService = new TestService(
    ServiceIdentifier.NAMES.Auth,
    jest.fn().mockResolvedValue(options.authServiceResult ?? { statusCode: 200, json: { valetToken: 'signed' } }),
  )
  const syncService = new TestService(
    ServiceIdentifier.NAMES.SyncingServer,
    jest.fn().mockResolvedValue(options.syncServiceResult ?? { statusCode: 200, json: { valetToken: 'signed' } }),
  )
  const services = new ServiceContainer()
  services.register(authService.getId(), authService)
  services.register(syncService.getId(), syncService)

  return {
    authorizer: new CanonicalHomeServerFileResourceAuthorizer({
      sessionValidator,
      services,
      authTokenDecoder,
      valetTokenDecoder,
    }),
    sessionValidator,
    authTokenDecoder,
    valetTokenDecoder,
    authService,
    syncService,
  }
}

describe('CanonicalHomeServerFileResourceAuthorizer', () => {
  it('revalidates a personal upload and accepts only the exact canonical quota snapshot', async () => {
    const context = setup()

    await expect(
      context.authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ storageOwnerUuid: USER_UUID })

    expect(context.sessionValidator.validateSession).toHaveBeenCalledWith({
      headers: { authorization: 'session-token' },
      requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
    })
    expect(context.authService.handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          operation: 'write',
          resources: [{ remoteIdentifier: FILE_UUID, unencryptedFileSize: 100 }],
        },
      }),
      expect.objectContaining({
        locals: expect.objectContaining({ user: { uuid: USER_UUID }, readOnlyAccess: false }),
      }),
      'auth.valet-tokens.create',
    )
    expect(context.syncService.handleRequest).not.toHaveBeenCalled()
  })

  it('revalidates shared-vault ownership and membership through the canonical syncing use case', async () => {
    const context = setup({ valetToken: sharedValet() })

    await expect(
      context.authorizer.authorize(
        { identity, resource: sharedResource, operation: 'download' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ storageOwnerUuid: VAULT_UUID })

    expect(context.sessionValidator.validateSession).toHaveBeenCalledWith({
      headers: { authorization: 'session-token', sharedVaultOwnerContext: OWNER_UUID },
      requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
    })
    expect(context.syncService.handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { sharedVaultUuid: VAULT_UUID },
        body: {
          file_uuid: FILE_UUID,
          remote_identifier: FILE_UUID,
          operation: 'read',
        },
      }),
      expect.objectContaining({
        locals: expect.objectContaining({
          sharedVaultOwnerContext: { upload_bytes_limit: 1_000 },
        }),
      }),
      'sync.shared-vaults.create-file-valet-token',
    )
    expect(context.authService.handleRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['revoked session', { sessionResult: { status: 401, data: {} } }],
    ['changed session', { authToken: baseAuthToken({ session: { uuid: 'other-session' } }) }],
    ['disabled live sync', { authToken: baseAuthToken({ live_sync_enabled: false }) }],
    ['read-only session', { authToken: baseAuthToken({ session: { uuid: SESSION_UUID, readonly_access: true } }) }],
    ['content limited session', { authToken: baseAuthToken({ hasContentLimit: true }) }],
    ['shadow-banned session', { authToken: baseAuthToken({ shadow_banned: true }) }],
  ])('fails closed for a personal upload with a %s', async (_label, options) => {
    const context = setup(options)

    await expect(
      context.authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['no membership', baseAuthToken({ belongs_to_shared_vaults: [] }), sharedValet()],
    [
      'read-only membership for upload',
      baseAuthToken({ belongs_to_shared_vaults: [{ shared_vault_uuid: VAULT_UUID, permission: 'read' }] }),
      sharedValet({ permittedOperation: 'write', unencryptedFileSize: 100 }),
    ],
    ['disabled collaboration', baseAuthToken({ collaboration_enabled: false }), sharedValet()],
    ['wrong canonical owner', baseAuthToken(), sharedValet({ vaultOwnerUuid: USER_UUID })],
  ])('fails closed on shared-vault %s', async (_label, authToken, valetToken) => {
    const context = setup({ authToken, valetToken })
    const operation = _label === 'read-only membership for upload' ? 'upload' : 'download'

    await expect(
      context.authorizer.authorize(
        {
          identity,
          resource: sharedResource,
          operation,
          ...(operation === 'upload' ? { decryptedSize: 100 } : {}),
        },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['exact quota boundary', personalValet({ uploadBytesUsed: 900, uploadBytesLimit: 1_000 })],
    ['negative usage', personalValet({ uploadBytesUsed: -1 })],
    ['invalid negative limit', personalValet({ uploadBytesLimit: -2 })],
    [
      'wrong resource',
      personalValet({ permittedResources: [{ remoteIdentifier: VAULT_UUID, unencryptedFileSize: 100 }] }),
    ],
    [
      'extra resource',
      personalValet({
        permittedResources: [
          { remoteIdentifier: FILE_UUID, unencryptedFileSize: 100 },
          { remoteIdentifier: VAULT_UUID, unencryptedFileSize: 100 },
        ],
      }),
    ],
  ])('rejects a personal upload with %s', async (_label, valetToken) => {
    const context = setup({ valetToken })

    await expect(
      context.authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  it('allows the canonical unlimited-storage sentinel and denies an unavailable direct service', async () => {
    const unlimited = setup({ valetToken: personalValet({ uploadBytesLimit: -1 }) })
    await expect(
      unlimited.authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ storageOwnerUuid: USER_UUID })

    const unavailable = setup({ authServiceResult: { statusCode: 503, json: {} } })
    await expect(
      unavailable.authorizer.authorize(
        { identity, resource: personalResource, operation: 'metadata' },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined()
  })

  /**
   * Standard Red Notes: FILES_V1 answered FILE_ACCESS_DENIED for a stale
   * credential AND for every policy denial, so a client could not tell "refresh
   * your credential" from "you may not do this". The split reuses the SHARED
   * classification (`classifyPresentedSessionCredential`, keyed on auth's STATUS,
   * never its error tag) so this authorizer and the sync lane's REAUTH cannot
   * drift.
   */
  describe('a stale credential is distinguishable from a policy denial', () => {
    const staleCode = { name: 'HomeServerSyncFilesAdapterError', code: 'SESSION_STALE' }

    it.each([
      // 498 `expired-access-token`: the session is LIVE and this token is merely
      // older than it.
      ['auth reports the token expired', { sessionResult: { status: 498, data: {} } }],
      ['auth is unwell', { sessionResult: { status: 503, data: {} } }],
      ['the answer carries no token', { sessionResult: { status: 200, data: {} } }],
      ['the cross-service token is unreadable', { authToken: undefined }],
      ['the cross-service token carries no roles', { authToken: { ...baseAuthToken(), roles: undefined } }],
    ])('reports a stale credential for a personal resource when %s', async (_label, options) => {
      const context = setup(options as Parameters<typeof setup>[0])

      await expect(
        context.authorizer.authorize(
          { identity, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject(staleCode)
      expect(context.authService.handleRequest).not.toHaveBeenCalled()
    })

    it('reports a stale credential when no credential was captured at ticket time', async () => {
      const context = setup()

      await expect(
        context.authorizer.authorize(
          { identity: { ...identity, authorization: undefined }, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject(staleCode)
      expect(context.sessionValidator.validateSession).not.toHaveBeenCalled()
    })

    it.each([
      ['a revoked or signed-out session', { sessionResult: { status: 401, data: {} } }],
      [
        'auth accepting the credential for ANOTHER identity',
        { authToken: baseAuthToken({ user: { uuid: VAULT_UUID } }) },
      ],
    ])('keeps %s on the unqualified denial', async (_label, options) => {
      const context = setup(options as Parameters<typeof setup>[0])

      await expect(
        context.authorizer.authorize(
          { identity, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
    })

    /**
     * THE EXISTENCE ORACLE, and why one case is deliberately NOT split. A
     * shared-vault resource makes `validateSession` send auth a
     * `sharedVaultOwnerContext` taken from the client's own
     * `sharedVaultOwnerUuid`; auth looks that user's subscription and upload
     * limit up and fails the cross-service token when either is missing. So
     * auth's status there depends on the requested OWNER, not only on the
     * credential, and splitting stale from denied would tell an unauthorized
     * caller whether a vault owner exists.
     */
    it.each([
      ['the answer carries no token', { sessionResult: { status: 200, data: {} } }],
      ['auth reports the token expired', { sessionResult: { status: 498, data: {} } }],
      ['the cross-service token is unreadable', { authToken: undefined }],
    ])('keeps a shared-vault refusal on the denial when %s', async (_label, options) => {
      const context = setup({ ...(options as Parameters<typeof setup>[0]), valetToken: sharedValet() })

      await expect(
        context.authorizer.authorize(
          { identity, resource: sharedResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
    })
  })

  /**
   * Standard Red Notes T4 -- the SINGLE-CONTAINER half of the socket-lane cookie
   * gap.
   *
   * `SyncWebSocketController` captures `access_token_<sessionUuid>` into the
   * ticket on every topology, and the multi-container authorizer forwards it.
   * This authorizer's port could not carry it, so on a single container a cookie
   * session's file operation was refused forever and the client fell back to
   * HTTP silently -- and, because the ticket DID hold the cookie, the shape test
   * (`credentialCanAuthenticateSession`) passed, auth's inevitable 401 was taken
   * as evidence, and the session was classified REVOKED rather than stale.
   *
   * E2E CANNOT COVER THIS: `E2E_TESTING` forces legacy header sessions, so no
   * end-to-end run ever constructs a `2:` credential. These tests build one.
   */
  describe('a cookie session authorizes on the single-container socket lane', () => {
    it('presents the captured cookie to auth and authorizes a personal upload', async () => {
      const context = setup({ sessionValidation: authLikeSessionValidation })

      await expect(
        context.authorizer.authorize(
          { identity: cookieSessionIdentity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ storageOwnerUuid: USER_UUID })

      expect(context.sessionValidator.validateSession).toHaveBeenCalledWith({
        headers: { authorization: '2:private-identifier' },
        requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
        cookies: new Map([[COOKIE_NAME, [COOKIE_VALUE]]]),
      })
      // `DirectCallServiceProxy` iterates `cookies.keys()` and `cookies.get()`,
      // so a plain record here would reach auth as no cookie at all.
      const [firstCall] = context.sessionValidator.validateSession.mock.calls
      expect(firstCall[0].cookies).toBeInstanceOf(Map)
    })

    it('presents the cookie alongside the shared-vault owner context', async () => {
      const context = setup({ sessionValidation: authLikeSessionValidation, valetToken: sharedValet() })

      await expect(
        context.authorizer.authorize(
          { identity: cookieSessionIdentity, resource: sharedResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ storageOwnerUuid: VAULT_UUID })

      expect(context.sessionValidator.validateSession).toHaveBeenCalledWith({
        headers: { authorization: '2:private-identifier', sharedVaultOwnerContext: OWNER_UUID },
        requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
        cookies: new Map([[COOKIE_NAME, [COOKIE_VALUE]]]),
      })
    })

    it('omits the cookie channel entirely for a header session', async () => {
      const context = setup()

      await context.authorizer.authorize(
        { identity, resource: personalResource, operation: 'upload', decryptedSize: 100 },
        new AbortController().signal,
      )

      // `toHaveBeenCalledWith` treats an explicit `cookies: undefined` as absent,
      // so the key itself is asserted rather than its value.
      const [firstCall] = context.sessionValidator.validateSession.mock.calls
      expect(Object.prototype.hasOwnProperty.call(firstCall[0], 'cookies')).toBe(false)
    })
  })

  /**
   * TOPOLOGY PARITY for the stale/revoked split. Both authorizers route every
   * refusal through the SAME `classifyPresentedSessionCredential`, so the only
   * way the two topologies can disagree is by feeding it different evidence --
   * which is exactly what the missing cookie channel did. These pin the three
   * verdicts the two must now agree on.
   */
  describe('the 498-then-401 verdict matches the multi-container lane', () => {
    const staleCode = { name: 'HomeServerSyncFilesAdapterError', code: 'SESSION_STALE' }

    it('reports a rotated header session stale on 498 and an unqualified denial once auth answers 401', async () => {
      const statuses = [498, 401]
      let attempt = 0
      const context = setup({
        sessionValidation: async () => {
          const status = statuses[attempt] ?? 401
          attempt += 1
          return { status, data: {} }
        },
      })

      // 498 `expired-access-token`: the session is LIVE and merely rotated, so
      // the client is told to re-present rather than being disconnected.
      await expect(
        context.authorizer.authorize(
          { identity, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject(staleCode)

      // 401: REVOKED, which on the files lane is deliberately NOT a coded wire
      // answer -- it collapses back into the unqualified denial, exactly as in
      // `ValetTokenFileResourceAuthorizer`.
      await expect(
        context.authorizer.authorize(
          { identity, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
      expect(attempt).toBe(2)
    })

    it('reads auth 401 for a cookie session whose cookie WAS presented as a revocation, not as staleness', async () => {
      const context = setup({ sessionValidation: authLikeSessionValidation })
      const rotatedCookie: SyncTicketIdentity = {
        ...cookieSessionIdentity,
        sessionCookies: { [COOKIE_NAME]: ['a-cookie-auth-no-longer-accepts'] },
      }

      await expect(
        context.authorizer.authorize(
          { identity: rotatedCookie, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined()
    })

    it('keeps a cookie session whose cookie was never captured on SESSION_STALE', async () => {
      const context = setup({ sessionValidation: authLikeSessionValidation })
      const uncapturable: SyncTicketIdentity = { ...cookieSessionIdentity, sessionCookies: undefined }

      // The shape test, not auth's status, decides here: a `2:` credential with
      // no cookie provably cannot authenticate, so auth's 401 is no evidence
      // about the session and must never terminate a working lane.
      await expect(
        context.authorizer.authorize(
          { identity: uncapturable, resource: personalResource, operation: 'download' },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject(staleCode)
    })
  })
})
