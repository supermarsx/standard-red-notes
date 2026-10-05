import type { Request, Response } from 'express'

import { ServiceIdentifier, type ServiceContainerInterface, type ServiceInterface } from '@standardnotes/domain-core'
import { createDirectCallResponse } from '@standardnotes/api-gateway'
import {
  classifyPresentedSessionCredential,
  credentialCanAuthenticateSession,
  type PresentedSessionCredentialOutcome,
} from '@standard-red-notes/websocket-gateway'

import {
  HomeServerSyncFilesAdapterError,
  type HomeServerFileAuthorization,
  type HomeServerFileOperation,
  type HomeServerFileResourceAuthorizer,
} from './HomeServerSyncFilesAdapter'

type AuthorizationInput = Parameters<HomeServerFileResourceAuthorizer['authorize']>[0]
type FileResourceReference = AuthorizationInput['resource']

type SessionValidationResult = {
  status: number
  data: unknown
}

/**
 * The single-container seam onto `ServiceProxyInterface.validateSession`, which
 * `DirectCallServiceProxy` implements.
 *
 * `cookies` is NOT optional decoration: a cookie-based session (auth's
 * `SessionService.COOKIE_SESSION_TOKEN_VERSION`) is authenticated by
 * `GetSessionFromToken` ONLY through its `access_token_<sessionUuid>` cookie --
 * the header-token branch explicitly refuses it -- so a port that cannot carry
 * cookies can never authorize a cookie session on this lane. Declared here in
 * exactly the shape `ServiceProxyInterface` already accepts, so the single- and
 * multi-container authorizers hand the session plane the same thing.
 */
export interface HomeServerSessionValidationPort {
  validateSession(input: {
    headers: {
      authorization: string
      sharedVaultOwnerContext?: string
    }
    requestMetadata: {
      url: string
      method: string
    }
    cookies?: Map<string, string[]>
  }): Promise<SessionValidationResult>
}

export interface HomeServerSignedTokenDecoder<T> {
  decodeToken(token: string): T | undefined
}

type SharedVaultAssociation = {
  shared_vault_uuid: string
  permission: string
}

export type HomeServerCrossServiceToken = {
  user: { uuid: string }
  roles: unknown[]
  session?: { uuid: string; readonly_access?: boolean }
  mcp_scope?: { access?: string }
  belongs_to_shared_vaults?: SharedVaultAssociation[]
  shared_vault_owner_context?: { upload_bytes_limit: number }
  hasContentLimit?: boolean
  collaboration_enabled?: boolean
  live_sync_enabled?: boolean
  shadow_banned?: boolean
}

export type HomeServerPersonalValetToken = {
  userUuid: string
  permittedOperation: string
  permittedResources: Array<{
    remoteIdentifier: string
    unencryptedFileSize?: number
  }>
  uploadBytesUsed: number
  uploadBytesLimit: number
}

export type HomeServerSharedVaultValetToken = {
  sharedVaultUuid: string
  vaultOwnerUuid: string
  permittedOperation: string
  remoteIdentifier: string
  unencryptedFileSize?: number
  uploadBytesUsed: number
  uploadBytesLimit?: number
}

export type CanonicalHomeServerFileResourceAuthorizerOptions = {
  sessionValidator: HomeServerSessionValidationPort
  services: ServiceContainerInterface
  authTokenDecoder: HomeServerSignedTokenDecoder<HomeServerCrossServiceToken>
  valetTokenDecoder: HomeServerSignedTokenDecoder<HomeServerPersonalValetToken | HomeServerSharedVaultValetToken>
}

type DirectJsonResult = {
  statusCode: number
  json: Record<string, unknown>
}

/**
 * Reuses the live session validator and the canonical Auth/Syncing valet-token
 * use cases for every FILES_V1 operation. The signed valet token is treated as
 * the authoritative ownership, membership, permission, and quota snapshot.
 */
export class CanonicalHomeServerFileResourceAuthorizer implements HomeServerFileResourceAuthorizer {
  constructor(private readonly options: CanonicalHomeServerFileResourceAuthorizerOptions) {}

  async authorize(input: AuthorizationInput, signal: AbortSignal): Promise<HomeServerFileAuthorization | undefined> {
    try {
      signal.throwIfAborted()
      const token = await this.validateSession(input, signal)
      if (!this.sessionAllowsOperation(token, input.resource, input.operation)) {
        return undefined
      }

      if (input.resource.ownershipType === 'user') {
        return await this.authorizePersonalResource(input, token, signal)
      }
      return await this.authorizeSharedVaultResource(input, token, signal)
    } catch (error) {
      if (this.refusalIsAnUnusableCredential(error, input, signal)) {
        // Standard Red Notes: the ONE files refusal whose cause is the credential
        // rather than the policy. A coded adapter error so it survives
        // `HomeServerSyncFilesAdapter` and reaches the wire as SESSION_STALE;
        // `undefined` still means "denied, and the reason is none of your
        // business", exactly as before.
        throw new HomeServerSyncFilesAdapterError('SESSION_STALE')
      }
      return undefined
    }
  }

  /**
   * True only for a refusal that is safe AND honest to report as a stale
   * credential.
   *
   * PERSONAL RESOURCES ONLY, and this is the whole reason the test exists.
   * `validateSession` sends auth a `sharedVaultOwnerContext` taken straight from
   * the client's own `sharedVaultOwnerUuid`; auth then looks that user's
   * subscription and file-upload-limit setting up and FAILS the cross-service
   * token when either is missing. So for a shared-vault resource auth's status is
   * a function of the requested OWNER, not only of the credential, and splitting
   * stale from denied there would answer "stale" for an owner uuid that does not
   * exist and "denied" for a real owner the caller is not a member of -- an
   * existence oracle for other people's vault owners. Every shared-vault refusal
   * therefore stays on FILE_ACCESS_DENIED. A personal resource sends nothing
   * resource-derived at all -- the bearer, its cookies and a fixed url -- so its
   * verdict reveals only the caller's own credential.
   *
   * An ABORT is not a verdict: the transfer deadline owns it, and the session was
   * never judged.
   */
  private refusalIsAnUnusableCredential(error: unknown, input: AuthorizationInput, signal: AbortSignal): boolean {
    return (
      !signal.aborted &&
      input.resource.ownershipType === 'user' &&
      error instanceof FileSessionCredentialError &&
      error.verdict === 'stale'
    )
  }

  private async validateSession(input: AuthorizationInput, signal: AbortSignal): Promise<HomeServerCrossServiceToken> {
    if (!input.identity.authorization) {
      throw new FileSessionCredentialError('File authorization requires the original session credential.', {
        reached: false,
      })
    }
    const authorization = input.identity.authorization.replace(/^Bearer\s+/iu, '')
    if (!authorization) {
      throw new FileSessionCredentialError('File authorization credential is empty.', { reached: false })
    }
    const ownerContext =
      input.resource.ownershipType === 'shared-vault' ? input.resource.sharedVaultOwnerUuid : undefined
    // Same credential gap as the sync lane: a cookie-based session authenticates
    // ONLY through `access_token_<uuid>`, so the bearer alone can never validate it.
    const cookies = sessionCookiesToMap(input.identity.sessionCookies)
    let response: SessionValidationResult
    try {
      response = await abortable(
        this.options.sessionValidator.validateSession({
          headers: {
            authorization,
            ...(ownerContext ? { sharedVaultOwnerContext: ownerContext } : {}),
          },
          requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
          ...(cookies ? { cookies } : {}),
        }),
        signal,
      )
    } catch (error) {
      throw new FileSessionCredentialError(error instanceof Error ? error.message : 'File session validation failed.', {
        reached: false,
      })
    }
    if (response.status !== 200 || !isObject(response.data) || typeof response.data.authToken !== 'string') {
      throw new FileSessionCredentialError(
        'File session is no longer authorized.',
        // A credential that cannot authenticate shape-wise (a cookie session
        // whose `access_token_<uuid>` was never captured at ticket time) makes
        // auth's inevitable 401 no evidence about the session, exactly as on the
        // sync lane's REAUTH pre-flight. The shape test is only sound because
        // the cookies it inspects are the same ones the call above actually
        // sent: were the port to drop them again, a live cookie session would
        // pass the shape test, collect auth's 401 and be classified REVOKED.
        credentialCanAuthenticateSession(authorization, input.identity)
          ? { reached: true, status: response.status }
          : { reached: false },
      )
    }
    const token = this.options.authTokenDecoder.decodeToken(response.data.authToken)
    if (!token || !isObject(token.user) || !isObject(token.session) || !Array.isArray(token.roles)) {
      // Auth answered 200 but its answer could not be read (an unverifiable
      // token, a rotated signing secret mid-deploy). An unknown verdict, which
      // the shared classification always reads as stale.
      throw new FileSessionCredentialError('File session token is unreadable.', { reached: true, status: 200 })
    }
    if (token.user.uuid !== input.identity.userUuid || token.session.uuid !== input.identity.sessionUuid) {
      // Auth accepted the credential for ANOTHER identity: never a stale token.
      throw new FileSessionCredentialError('File session identity changed.', {
        reached: true,
        status: 200,
        identityMatches: false,
      })
    }
    signal.throwIfAborted()
    return token
  }

  private sessionAllowsOperation(
    token: HomeServerCrossServiceToken,
    resource: FileResourceReference,
    operation: HomeServerFileOperation,
  ): boolean {
    if (token.live_sync_enabled === false) {
      return false
    }
    if (resource.ownershipType === 'shared-vault') {
      if (token.collaboration_enabled === false || !resource.sharedVaultUuid || !resource.sharedVaultOwnerUuid) {
        return false
      }
      const membership = token.belongs_to_shared_vaults?.find(
        (association) => association.shared_vault_uuid === resource.sharedVaultUuid,
      )
      if (!membership || !['read', 'write', 'admin'].includes(membership.permission)) {
        return false
      }
      if (operation === 'upload' && membership.permission === 'read') {
        return false
      }
    }
    if (operation !== 'upload') {
      return true
    }
    return !(
      token.session?.readonly_access === true ||
      token.mcp_scope?.access === 'read' ||
      token.hasContentLimit === true ||
      token.shadow_banned === true
    )
  }

  private async authorizePersonalResource(
    input: AuthorizationInput,
    token: HomeServerCrossServiceToken,
    signal: AbortSignal,
  ): Promise<HomeServerFileAuthorization | undefined> {
    const operation = valetOperation(input.operation)
    const response = await this.callService(
      ServiceIdentifier.NAMES.Auth,
      'auth.valet-tokens.create',
      {
        body: {
          operation,
          resources: [
            {
              remoteIdentifier: input.resource.remoteIdentifier,
              ...(input.operation === 'upload' ? { unencryptedFileSize: input.decryptedSize } : {}),
            },
          ],
        },
      },
      this.responseLocals(token),
      signal,
    )
    const claims = this.decodeValetClaims(response)
    if (!isPersonalValetToken(claims)) {
      return undefined
    }
    const [resource, ...extraResources] = claims.permittedResources
    if (
      claims.userUuid !== input.identity.userUuid ||
      claims.permittedOperation !== operation ||
      !resource ||
      extraResources.length !== 0 ||
      resource.remoteIdentifier !== input.resource.remoteIdentifier ||
      (input.operation === 'upload' && resource.unencryptedFileSize !== input.decryptedSize) ||
      !this.hasQuota(claims.uploadBytesUsed, claims.uploadBytesLimit, input)
    ) {
      return undefined
    }
    return { storageOwnerUuid: input.identity.userUuid }
  }

  private async authorizeSharedVaultResource(
    input: AuthorizationInput,
    token: HomeServerCrossServiceToken,
    signal: AbortSignal,
  ): Promise<HomeServerFileAuthorization | undefined> {
    if (
      input.resource.ownershipType !== 'shared-vault' ||
      !input.resource.sharedVaultUuid ||
      !input.resource.sharedVaultOwnerUuid
    ) {
      return undefined
    }
    const operation = valetOperation(input.operation)
    const response = await this.callService(
      ServiceIdentifier.NAMES.SyncingServer,
      'sync.shared-vaults.create-file-valet-token',
      {
        params: { sharedVaultUuid: input.resource.sharedVaultUuid },
        body: {
          file_uuid: input.resource.fileUuid,
          remote_identifier: input.resource.remoteIdentifier,
          operation,
          ...(input.operation === 'upload' ? { unencrypted_file_size: input.decryptedSize } : {}),
        },
      },
      this.responseLocals(token),
      signal,
    )
    const claims = this.decodeValetClaims(response)
    if (
      !isSharedVaultValetToken(claims) ||
      claims.sharedVaultUuid !== input.resource.sharedVaultUuid ||
      claims.vaultOwnerUuid !== input.resource.sharedVaultOwnerUuid ||
      claims.remoteIdentifier !== input.resource.remoteIdentifier ||
      claims.permittedOperation !== operation ||
      (input.operation === 'upload' && claims.unencryptedFileSize !== input.decryptedSize) ||
      !this.hasQuota(claims.uploadBytesUsed, claims.uploadBytesLimit, input)
    ) {
      return undefined
    }
    return { storageOwnerUuid: input.resource.sharedVaultUuid }
  }

  private responseLocals(token: HomeServerCrossServiceToken): Record<string, unknown> {
    return {
      user: token.user,
      roles: token.roles,
      session: token.session,
      readOnlyAccess: token.session?.readonly_access === true || token.mcp_scope?.access === 'read',
      mcpScope: token.mcp_scope,
      belongsToSharedVaults: token.belongs_to_shared_vaults ?? [],
      sharedVaultOwnerContext: token.shared_vault_owner_context,
      hasContentLimit: token.hasContentLimit === true,
      collaborationEnabled: token.collaboration_enabled !== false,
      liveSyncEnabled: token.live_sync_enabled !== false,
      shadowBanned: token.shadow_banned === true,
    }
  }

  /**
   * Enters a canonical controller IN-PROCESS: no Express, no middleware, no
   * socket -- `Service.handleRequest` looks the registered method up and calls
   * it with whatever this hands over.
   *
   * The response therefore has to be a real enough `Response`, and for a while
   * it was not: `{ locals } as unknown as Response & never`, an object with no
   * methods at all. Nothing broke only because the two methods reached from
   * here (`BaseValetTokenController.create` and
   * `BaseSharedVaultsController.createValetTokenForSharedVaultFile`) read
   * `response.locals` and return `this.json(...)` without touching the response
   * again -- while two SIBLINGS in that same shared-vaults controller,
   * `createSharedVault` and `deleteSharedVault`, already stamp
   * `response.setHeader('x-invalidate-cache', ...)`. The first such line added
   * to a valet-token method would have thrown
   *
   *   TypeError: response.setHeader is not a function
   *
   * AFTER the valet token was minted, and the files lane would have answered an
   * unattributable denial on the single container while multi-container (whose
   * authorizer goes out over HTTP/gRPC) stayed green. That is exactly how the
   * websocket sync lane came to fail 100 % of its `SYNC_ITEMS` calls at
   * `e2e87e10`; `createDirectCallResponse` is that fix's header sink, imported
   * rather than copied so this twin cannot drift away from it.
   */
  private async callService(
    serviceName: string,
    endpoint: string,
    request: { body: Record<string, unknown>; params?: Record<string, string> },
    locals: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DirectJsonResult> {
    const identifier = ServiceIdentifier.create(serviceName)
    if (identifier.isFailed()) {
      throw new Error('Invalid canonical file authorization service.')
    }
    const service = this.options.services.get(identifier.getValue()) as ServiceInterface | undefined
    if (!service) {
      throw new Error('Canonical file authorization service is unavailable.')
    }
    const result = (await abortable(
      service.handleRequest(
        request as unknown as Request & never,
        createDirectCallResponse(locals) as unknown as Response & never,
        endpoint,
      ) as Promise<unknown>,
      signal,
    )) as Partial<DirectJsonResult>
    if (!Number.isInteger(result.statusCode) || !isObject(result.json)) {
      throw new Error('Canonical file authorization returned an invalid response.')
    }
    return result as DirectJsonResult
  }

  private decodeValetClaims(
    response: DirectJsonResult,
  ): HomeServerPersonalValetToken | HomeServerSharedVaultValetToken | undefined {
    if (response.statusCode < 200 || response.statusCode >= 300 || typeof response.json.valetToken !== 'string') {
      return undefined
    }
    return this.options.valetTokenDecoder.decodeToken(response.json.valetToken)
  }

  private hasQuota(uploadBytesUsed: unknown, uploadBytesLimit: unknown, input: AuthorizationInput): boolean {
    if (input.operation !== 'upload') {
      return true
    }
    if (
      !Number.isSafeInteger(input.decryptedSize) ||
      (input.decryptedSize as number) < 1 ||
      !Number.isSafeInteger(uploadBytesUsed) ||
      (uploadBytesUsed as number) < 0 ||
      !Number.isSafeInteger(uploadBytesLimit) ||
      ((uploadBytesLimit as number) < 0 && uploadBytesLimit !== -1)
    ) {
      return false
    }
    if (uploadBytesLimit === -1) {
      return true
    }
    return (uploadBytesLimit as number) - (uploadBytesUsed as number) - (input.decryptedSize as number) > 0
  }
}

/**
 * A session revalidation that refused, carrying the SHARED stale/revoked verdict
 * (`classifyPresentedSessionCredential`) rather than a second opinion of its own.
 * Every other failure inside `authorize` stays an ordinary Error, i.e. an
 * unqualified denial.
 */
export class FileSessionCredentialError extends Error {
  readonly verdict: 'stale' | 'revoked'

  constructor(message: string, outcome: PresentedSessionCredentialOutcome) {
    super(message)
    this.name = 'FileSessionCredentialError'
    const decision = classifyPresentedSessionCredential(outcome)
    this.verdict = !decision.refreshed && decision.code === 'SESSION_REVOKED' ? 'revoked' : 'stale'
  }
}

function valetOperation(operation: HomeServerFileOperation): 'read' | 'write' {
  return operation === 'upload' ? 'write' : 'read'
}

function isPersonalValetToken(value: unknown): value is HomeServerPersonalValetToken {
  return (
    isObject(value) &&
    typeof value.userUuid === 'string' &&
    typeof value.permittedOperation === 'string' &&
    Array.isArray(value.permittedResources)
  )
}

function isSharedVaultValetToken(value: unknown): value is HomeServerSharedVaultValetToken {
  return (
    isObject(value) &&
    typeof value.sharedVaultUuid === 'string' &&
    typeof value.vaultOwnerUuid === 'string' &&
    typeof value.remoteIdentifier === 'string' &&
    typeof value.permittedOperation === 'string'
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The ticket's captured session cookies in the shape
 * `HomeServerSessionValidationPort.validateSession` (i.e.
 * `ServiceProxyInterface.validateSession`) takes, which is also the shape
 * `AuthMiddleware` builds -- so this lane and an ordinary HTTP request hand auth
 * the same thing.
 *
 * Deliberately a local twin of api-gateway's `sessionCookiesToMap` rather than
 * an import: that module is not part of `@standardnotes/api-gateway`'s public
 * entry point, and the shape both sides must agree on is the port type above,
 * which this file owns. Returns undefined for an empty capture so the `cookies`
 * key is omitted entirely rather than sent empty.
 */
function sessionCookiesToMap(
  cookies: AuthorizationInput['identity']['sessionCookies'],
): Map<string, string[]> | undefined {
  if (!cookies) {
    return undefined
  }
  const map = new Map<string, string[]>()
  for (const [name, values] of Object.entries(cookies)) {
    map.set(name, [...values])
  }
  return map.size > 0 ? map : undefined
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('File authorization aborted.'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('File authorization aborted.'))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
