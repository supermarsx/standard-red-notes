import { Request, Response } from 'express'
import { verify } from 'jsonwebtoken'
import { CrossServiceTokenData } from '@standardnotes/security'
import { RoleName } from '@standardnotes/domain-core'
import {
  classifyPresentedSessionCredential,
  credentialCanAuthenticateSession,
  type JsonObject,
  type PresentedSessionCredentialOutcome,
  type SyncAuthorizationDecision,
  type SyncAuthorizationInput,
  type SyncBackendCommandInput,
  type SyncBackendCommit,
  type SyncBackendStatus,
  type SyncCommandBackendAdapter,
  type SyncCollaborationAuthorizationAdapter,
  type SyncCollaborationAuthorizationResult,
  type SyncLiveAuthorizationAdapter,
  type SyncSessionRefreshDecision,
  type SyncTicketIdentity,
} from '@standard-red-notes/websocket-gateway'

import { ResponseLocals } from '../../Controller/ResponseLocals'
import { createDirectCallResponse } from './DirectCallResponse'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { sessionCookiesToMap } from './sessionCookies'
import { CollaborationAuthorizationService } from './CollaborationAuthorizationService'

export interface DurableSyncCommandPort {
  durableCommandAuthenticationReady(): boolean
  sync(
    request: Request,
    response: Response,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown; replayed?: boolean }>
  getSyncCommandStatus(
    request: Request,
    response: Response,
    commandId: string,
    digest?: string,
  ): Promise<{
    status: number
    data: {
      command: { id: string; status: 'accepted' | 'committed' | 'unknown'; digest?: string }
      result?: Record<string, unknown>
    }
  }>
}

type ValidatedSession = {
  locals: ResponseLocals
  token: CrossServiceTokenData
  /** Identity the validation was performed for; a supplied session is reused only for the same one. */
  identity: Pick<SyncTicketIdentity, 'userUuid' | 'sessionUuid'>
  /** Adapter clock at validation time; evidence older than SUPPLIED_SESSION_MAX_AGE_MS is not reused. */
  validatedAt: number
}

/**
 * How long the evidence from the pre-execute authorization may stand in for a
 * fresh `validate()` inside `execute`/`status` (R8). The handler calls
 * authorize immediately before execute, so this is a bound on scheduling
 * delay, not a cache lifetime.
 */
export const SUPPLIED_SESSION_MAX_AGE_MS = 5_000

/**
 * Why a session could not be validated. Carries TWO independent answers, because
 * the per-command lane and the per-credential lanes ask different questions of
 * the same refusal.
 *
 * `kind` -- the SYNC lane's recovery hint, unchanged. `stale` means the auth
 * service answered and the bearer captured at ticket time no longer validates
 * (rotated, refreshed, or now bound to another identity) and maps to the PUBLIC,
 * retryable SESSION_STALE so the client re-tickets once; everything else (no
 * bearer, plane unready, transport failure, unverifiable token) stays the private
 * SESSION_REVOKED (NOT_AUTHORIZED on the wire). It is deliberately lenient: a
 * re-ticket goes through real authenticated HTTP, so a session that can no longer
 * authenticate simply cannot obtain a new ticket, and collapsing a rotation past
 * auth's cooldown (a flat 401) onto NOT_AUTHORIZED would delete that recovery.
 *
 * `credential` -- the SESSION verdict, the single classification shared with
 * `refreshSession` and with the FILES_V1 authorizers
 * (`classifyPresentedSessionCredential`, keyed on auth's STATUS, never its error
 * tag). This is the one the collaboration lane reports, because there the
 * question is "is this credential usable?", not "what should the client try
 * next?". The two therefore disagree on purpose in exactly two places -- a 401
 * (recovery hint: stale; session verdict: revoked) and an identity change (hint:
 * stale; verdict: revoked) -- and each is right for its own lane.
 */
class SessionValidationError extends Error {
  constructor(
    message: string,
    readonly kind: 'stale' | 'revoked',
    readonly credential: 'stale' | 'revoked',
  ) {
    super(message)
    this.name = 'SessionValidationError'
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Sync command aborted.'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('Sync command aborted.'))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * Revalidates the original session token for every WS COMMAND/STATUS and then
 * delegates durable execution/idempotency to Lane 1's gRPC adapter. It never
 * implements a second executor or repository.
 *
 * Two INDEPENDENT readiness questions live on this one object, and conflating
 * them used to close the whole socket:
 *
 *   - `sessionAuthorizationReady()` -- can a session be revalidated at all?
 *     Needs only `AUTH_JWT_SECRET` and the HTTP `ServiceProxy`. Everything the
 *     socket does (collaboration authorization, API RPC, invite events, files)
 *     rests on this and NOTHING else.
 *   - `ready()` -- can a DURABLE sync command be executed? Additionally needs a
 *     bound durable command port. Only `SYNC_ITEMS` rests on this.
 *
 * While both answers came from one `ready()`, an unbound gRPC proxy -- or a
 * bound one with no `SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET` -- reported the
 * SESSION plane as dead and took five gRPC-independent capabilities with it.
 */
export class SyncWebSocketCommandAdapter
  implements SyncLiveAuthorizationAdapter, SyncCommandBackendAdapter, SyncCollaborationAuthorizationAdapter
{
  constructor(
    private readonly serviceProxy: ServiceProxyInterface,
    /**
     * Absent when the deployment binds no durable command port. The socket
     * still serves every non-sync capability; only `SYNC_ITEMS` is withheld.
     */
    private readonly durableSync: DurableSyncCommandPort | undefined,
    private readonly authJwtSecret: string,
    private readonly collaborationAuthorization?: CollaborationAuthorizationService,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Sessions THIS adapter validated. `execute`/`status` accept supplied session
   * evidence only when it is one of these (a WeakSet, so nothing is retained):
   * the handler carries the value opaquely, and anything else is untrusted.
   */
  private readonly issuedSessions = new WeakSet<ValidatedSession>()

  /**
   * Session revalidation readiness. Deliberately says nothing about the durable
   * backend: this is what gates the socket's non-sync capabilities.
   */
  sessionAuthorizationReady(): boolean {
    return this.authJwtSecret.length > 0
  }

  /** Durable-command readiness. `SYNC_ITEMS` is advertised on this and only this. */
  ready(): boolean {
    return (
      this.sessionAuthorizationReady() &&
      this.durableSync !== undefined &&
      this.durableSync.durableCommandAuthenticationReady() &&
      typeof this.durableSync.sync === 'function' &&
      typeof this.durableSync.getSyncCommandStatus === 'function'
    )
  }

  async authorize(input: SyncAuthorizationInput, signal: AbortSignal): Promise<SyncAuthorizationDecision> {
    let validated: ValidatedSession
    try {
      validated = await this.validate(input.identity, signal)
    } catch (error) {
      return {
        authorized: false,
        code: error instanceof SessionValidationError && error.kind === 'stale' ? 'SESSION_STALE' : 'SESSION_REVOKED',
      }
    }

    if (input.operation === 'STATUS') {
      return { authorized: true, session: validated }
    }
    if (validated.locals.readOnlyAccess) {
      return { authorized: false, code: 'READ_ONLY' }
    }
    if (validated.locals.hasContentLimit) {
      return { authorized: false, code: 'CONTENT_LIMIT' }
    }
    // The per-user "Live sync" switch is a public, permanent refusal (the
    // client stays on HTTP); it is checked before the shadow ban so that a
    // shadow-banned user with live sync off gets the same answer as anyone
    // else with live sync off, and the ban itself is still never revealed.
    if (validated.locals.liveSyncEnabled === false) {
      return { authorized: false, code: 'LIVE_SYNC_DISABLED' }
    }
    if (validated.locals.shadowBanned) {
      return { authorized: false, code: 'SHADOW_BANNED' }
    }
    if (input.payload && !this.hasSharedVaultAccess(input.payload, validated.token)) {
      return { authorized: false, code: 'SHARED_VAULT_FORBIDDEN' }
    }
    return { authorized: true, session: validated }
  }

  async execute(input: SyncBackendCommandInput, signal: AbortSignal, session?: unknown): Promise<SyncBackendCommit> {
    const durableSync = this.requireDurableSync()
    const validated = this.reusableSession(session, input.identity) ?? (await this.validate(input.identity, signal))
    const body = this.commandBody(input.payload)
    const { request, response } = this.httpContext(validated.locals, body)
    const result = await abortable(
      durableSync.sync(request, response, {
        ...body,
        command: { id: input.commandId, digest: input.digest },
      }),
      signal,
    )
    if (result.status < 200 || result.status >= 300 || !this.isJsonObject(result.data)) {
      throw new Error('Durable sync command failed.')
    }
    const command = result.data.command
    const digest =
      this.isJsonObject(command) && typeof command.digest === 'string' ? command.digest.toLowerCase() : input.digest
    return { digest, payload: result.data }
  }

  async status(
    input: Omit<SyncBackendCommandInput, 'payload'>,
    signal: AbortSignal,
    session?: unknown,
  ): Promise<SyncBackendStatus> {
    const durableSync = this.requireDurableSync()
    const validated = this.reusableSession(session, input.identity) ?? (await this.validate(input.identity, signal))
    const { request, response } = this.httpContext(validated.locals, {})
    const result = await abortable(
      durableSync.getSyncCommandStatus(request, response, input.commandId, input.digest),
      signal,
    )
    if (result.status < 200 || result.status >= 300) {
      throw new Error('Durable sync command status failed.')
    }
    const command = result.data.command
    if (command.status === 'unknown') {
      return { status: 'UNKNOWN', digest: command.digest }
    }
    const digest = command.digest ?? input.digest
    if (command.status === 'accepted') {
      return { status: 'ACCEPTED', digest }
    }
    return { status: 'COMMITTED', digest, payload: result.data.result }
  }

  /**
   * Standard Red Notes: revalidate a credential a REAUTH frame asks a live
   * socket to adopt (`SyncLiveAuthorizationAdapter.refreshSession`).
   *
   * DELIBERATELY NOT `validate()`. The two answer different questions and must
   * classify differently:
   *
   *   - `validate()` answers "may this command run?". Its `stale` is a RECOVERY
   *     HINT: the client re-tickets once, and re-ticketing goes through real
   *     authenticated HTTP, so a session that can no longer authenticate simply
   *     cannot get a new ticket. Treating every refusal there as stale is
   *     therefore safe, and it is what makes a rotation past auth's cooldown
   *     (a flat 401 `invalid-auth`) recoverable at all. Changing it would
   *     silently remove that recovery.
   *   - this answers "may this socket START PRESENTING this credential, and
   *     should the socket survive if not?". Here a refusal decides whether a
   *     live authenticated socket is terminated, so the classification has to
   *     be about the SESSION, not about the client's next move.
   *
   * CLASSIFICATION lives in `classifyPresentedSessionCredential` and nowhere
   * else. This method's only job is to present the credential and report what
   * the session plane did with it; the stale/revoked table (keyed on auth's
   * STATUS, never its error tag, with an unknown verdict always stale) is shared
   * verbatim with the collaboration lane and with the FILES_V1 authorizers, so
   * the four lanes cannot drift into disagreeing about whether a session is gone.
   */
  async refreshSession(
    input: { identity: SyncTicketIdentity },
    signal: AbortSignal,
  ): Promise<SyncSessionRefreshDecision> {
    const identity = input.identity
    if (!this.sessionAuthorizationReady() || !identity.authorization) {
      return classifyPresentedSessionCredential({ reached: false })
    }
    const authorization = identity.authorization.replace(/^Bearer\s+/i, '')
    if (authorization.length === 0 || !credentialCanAuthenticateSession(authorization, identity)) {
      // A credential that cannot authenticate SHAPE-WISE says nothing about the
      // session, so it is refused without spending an auth call and without
      // closing the socket. The case that matters: a cookie-based session's
      // bearer is `2:<privateIdentifier>` and carries no secret at all, so
      // without its `access_token_<uuid>` cookie auth can only answer 401 — and
      // a 401 is what terminates below. A client that minted its ticket where
      // the browser withheld the cookie (a partitioned or cross-site context)
      // would otherwise have its working socket closed for presenting a ticket
      // it could not complete.
      return classifyPresentedSessionCredential({ reached: false })
    }
    const cookies = sessionCookiesToMap(identity.sessionCookies)

    let authResponse: Awaited<ReturnType<ServiceProxyInterface['validateSession']>>
    try {
      authResponse = await abortable(
        this.serviceProxy.validateSession({
          headers: { authorization },
          requestMetadata: { url: '/sockets/sync/reauth', method: 'POST' },
          ...(cookies ? { cookies } : {}),
        }),
        signal,
      )
    } catch {
      return classifyPresentedSessionCredential({ reached: false })
    }

    if (authResponse.status !== 200 || !this.isJsonObject(authResponse.data)) {
      return classifyPresentedSessionCredential({ reached: true, status: authResponse.status })
    }
    const authToken = authResponse.data.authToken
    if (typeof authToken !== 'string') {
      return classifyPresentedSessionCredential({ reached: true, status: 200 })
    }
    let token: CrossServiceTokenData
    try {
      token = verify(authToken, this.authJwtSecret, { algorithms: ['HS256'] }) as CrossServiceTokenData
    } catch {
      // Unreadable answer, not a refusal (a rolling deploy with a rotated
      // AUTH_JWT_SECRET lands here). Nothing is adopted and nothing is closed.
      return classifyPresentedSessionCredential({ reached: true, status: 200 })
    }
    // Auth accepting the credential for a DIFFERENT identity is the one 200 that
    // must not adopt: the socket would be replaying a credential that proves
    // someone else, which no legitimate mint can produce.
    return classifyPresentedSessionCredential({
      reached: true,
      status: 200,
      identityMatches: token.user?.uuid === identity.userUuid && token.session?.uuid === identity.sessionUuid,
    })
  }

  /**
   * The session verdict for one refusal, from the single shared classification.
   * `refreshed: true` cannot occur on a path that already failed, and is read as
   * 'stale' rather than asserted away: a usable credential is never evidence
   * that a session is gone.
   */
  private credentialVerdict(outcome: PresentedSessionCredentialOutcome): 'stale' | 'revoked' {
    const decision = classifyPresentedSessionCredential(outcome)
    return !decision.refreshed && decision.code === 'SESSION_REVOKED' ? 'revoked' : 'stale'
  }

  collaborationAuthorizationReady(): boolean {
    return this.sessionAuthorizationReady() && this.collaborationAuthorization?.ready() === true
  }

  async authorizeCollaboration(
    input: Parameters<SyncCollaborationAuthorizationAdapter['authorizeCollaboration']>[0],
    signal: AbortSignal,
  ): Promise<SyncCollaborationAuthorizationResult> {
    if (!this.collaborationAuthorizationReady() || !this.collaborationAuthorization) {
      return { authorized: false }
    }
    let validated: ValidatedSession
    try {
      validated = await this.validate(input.identity, signal)
    } catch (error) {
      // Standard Red Notes: say WHICH refusal this is.
      //
      // This refusal happens BEFORE a single resource identifier is consulted:
      // `validate` is handed the identity and nothing else, and the note only
      // reaches the syncing-server access check further down. So distinguishing
      // a dead credential here cannot reveal whether a note, room or vault
      // exists -- the answer is a property of the credential alone. Every
      // refusal the POLICY check produces (no membership, note absent,
      // collaboration disabled, read-only) is left exactly as it was, which is
      // what keeps "exists but you may not" and "does not exist" the same
      // answer.
      //
      // An ABORT is not a verdict: the handler's own timeout owns it, and the
      // socket was never told anything about the credential. It keeps the
      // unqualified denial it has always produced here.
      const stale = !signal.aborted && error instanceof SessionValidationError && error.credential === 'stale'
      return stale ? { authorized: false, code: 'SESSION_STALE' } : { authorized: false }
    }
    const { request } = this.httpContext(validated.locals, {})
    return this.collaborationAuthorization.authorize(request, validated.locals, input.request, signal)
  }

  /**
   * The durable port is resolved once, at the point of use, so a caller that
   * reached `execute`/`status` without consulting `ready()` fails loudly here
   * rather than dereferencing `undefined` mid-command.
   */
  private requireDurableSync(): DurableSyncCommandPort {
    if (!this.durableSync) {
      throw new Error('Durable sync command execution is unavailable.')
    }
    return this.durableSync
  }

  /**
   * Session evidence handed back by the handler from the authorization that
   * immediately preceded `execute`/`status` (R8: each `SYNC_ITEMS` command used
   * to cost three uncached validations against auth). Reused only when it is
   * a session THIS adapter validated, for THIS identity, within
   * SUPPLIED_SESSION_MAX_AGE_MS; anything else falls back to a fresh
   * `validate()`.
   */
  private reusableSession(session: unknown, identity: SyncTicketIdentity): ValidatedSession | undefined {
    if (typeof session !== 'object' || session === null || !this.issuedSessions.has(session as ValidatedSession)) {
      return undefined
    }
    const validated = session as ValidatedSession
    if (
      validated.identity.userUuid !== identity.userUuid ||
      validated.identity.sessionUuid !== identity.sessionUuid ||
      this.now() - validated.validatedAt > SUPPLIED_SESSION_MAX_AGE_MS
    ) {
      return undefined
    }
    return validated
  }

  private async validate(identity: SyncTicketIdentity, signal: AbortSignal): Promise<ValidatedSession> {
    // Session revalidation needs the auth secret and the HTTP service proxy,
    // never the durable port -- gating it on `ready()` is what made an unbound
    // gRPC proxy look like a dead authorization plane.
    if (!identity.authorization || !this.sessionAuthorizationReady()) {
      throw new SessionValidationError('Live sync authorization is unavailable.', 'revoked', 'stale')
    }
    const authorization = identity.authorization.replace(/^Bearer\s+/i, '')
    // A cookie-based session is authenticated by auth ONLY through the cookie
    // (`GetSessionFromToken` refuses its header-token branch outright), so omitting
    // this made every such session fail SESSION_STALE on every command.
    const cookies = sessionCookiesToMap(identity.sessionCookies)
    let authResponse: Awaited<ReturnType<ServiceProxyInterface['validateSession']>>
    try {
      authResponse = await abortable(
        this.serviceProxy.validateSession({
          headers: { authorization },
          requestMetadata: { url: '/sockets/sync', method: 'POST' },
          ...(cookies ? { cookies } : {}),
        }),
        signal,
      )
    } catch (error) {
      // Transport failure or an aborted command: no verdict at all. `kind` stays
      // 'revoked' so `authorize` reports the same collapsed NOT_AUTHORIZED a raw
      // throw always produced here, while the session verdict is the stale an
      // unknown answer must always be.
      throw new SessionValidationError(
        error instanceof Error ? error.message : 'Sync session validation failed.',
        'revoked',
        'stale',
      )
    }
    if (authResponse.status !== 200 || !this.isJsonObject(authResponse.data)) {
      // Auth answered and refused the bearer captured at ticket time: the
      // session token was rotated or refreshed mid-socket. Re-ticketing with
      // the current token fixes it, so this is the retryable SESSION_STALE.
      throw new SessionValidationError(
        'Sync session is no longer authorized.',
        'stale',
        this.credentialVerdict(
          // Mirrors `refreshSession`'s pre-flight WITHOUT short-circuiting the
          // auth call this lane has always made: a credential that cannot
          // authenticate shape-wise (a cookie session whose `access_token_<uuid>`
          // was never captured) makes auth's inevitable 401 no evidence at all
          // about the session, so it must not read as a revocation.
          credentialCanAuthenticateSession(authorization, identity)
            ? { reached: true, status: authResponse.status }
            : { reached: false },
        ),
      )
    }
    const authToken = authResponse.data.authToken
    if (typeof authToken !== 'string') {
      throw new SessionValidationError(
        'Sync session validation returned no token.',
        'revoked',
        this.credentialVerdict({ reached: true, status: 200 }),
      )
    }
    let token: CrossServiceTokenData
    try {
      token = verify(authToken, this.authJwtSecret, { algorithms: ['HS256'] }) as CrossServiceTokenData
    } catch (error) {
      // An unreadable answer, not a refusal (a rolling deploy with a rotated
      // AUTH_JWT_SECRET lands here). `kind` is 'revoked', which is exactly what
      // `authorize` reported when this threw raw, so the sync lane is unchanged.
      throw new SessionValidationError(
        error instanceof Error ? error.message : 'Sync session token is unverifiable.',
        'revoked',
        this.credentialVerdict({ reached: true, status: 200 }),
      )
    }
    const session = token.session
    if (token.user.uuid !== identity.userUuid || session?.uuid !== identity.sessionUuid) {
      throw new SessionValidationError(
        'Sync session identity changed.',
        'stale',
        this.credentialVerdict({ reached: true, status: 200, identityMatches: false }),
      )
    }
    const readOnlyAccess = session.readonly_access || token.mcp_scope?.access === 'read'
    const locals = {
      authToken,
      user: token.user,
      roles: token.roles,
      session,
      readOnlyAccess,
      mcpScope: token.mcp_scope,
      isFreeUser: token.roles.length === 1 && token.roles[0]?.name === RoleName.NAMES.CoreUser,
      belongsToSharedVaults: token.belongs_to_shared_vaults ?? [],
      sharedVaultOwnerContext: token.shared_vault_owner_context,
      hasContentLimit: token.hasContentLimit === true,
      collaborationEnabled: token.collaboration_enabled !== false,
      liveSyncEnabled: token.live_sync_enabled !== false,
      authTokenVersion: token.version,
      shadowBanned: token.shadow_banned === true,
    } satisfies ResponseLocals
    const validated: ValidatedSession = {
      locals,
      token,
      identity: { userUuid: identity.userUuid, sessionUuid: identity.sessionUuid },
      validatedAt: this.now(),
    }
    this.issuedSessions.add(validated)
    return validated
  }

  private hasSharedVaultAccess(payload: JsonObject, token: CrossServiceTokenData): boolean {
    const body = this.commandBody(payload)
    const requested = new Set<string>()
    if (Array.isArray(body.shared_vault_uuids)) {
      for (const uuid of body.shared_vault_uuids) {
        if (typeof uuid === 'string') {
          requested.add(uuid)
        }
      }
    }
    if (Array.isArray(body.items)) {
      for (const item of body.items) {
        if (this.isJsonObject(item) && typeof item.shared_vault_uuid === 'string') {
          requested.add(item.shared_vault_uuid)
        }
      }
    }
    if (requested.size === 0) {
      return true
    }
    const allowed = new Set((token.belongs_to_shared_vaults ?? []).map((vault) => vault.shared_vault_uuid))
    return [...requested].every((uuid) => allowed.has(uuid))
  }

  private commandBody(payload: JsonObject): JsonObject {
    if (payload.command !== 'SYNC_ITEMS' || !this.isJsonObject(payload.body)) {
      throw new Error('Invalid sync command payload.')
    }
    return payload.body
  }

  private httpContext(locals: ResponseLocals, body: JsonObject): { request: Request; response: Response } {
    const api = typeof body.api === 'string' ? body.api : undefined
    return {
      request: { headers: { 'x-snjs-version': api } } as unknown as Request,
      response: createDirectCallResponse(locals),
    }
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
