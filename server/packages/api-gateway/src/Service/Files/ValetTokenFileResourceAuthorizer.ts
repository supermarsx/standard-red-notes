import type { Request, Response } from 'express'

import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import type { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'
import type {
  MultiContainerFileAuthorization,
  MultiContainerFileOperation,
  MultiContainerFileResourceAuthorizer,
} from './MultiContainerSyncFilesAdapter'

type AuthorizationInput = Parameters<MultiContainerFileResourceAuthorizer['authorize']>[0]
type FileResourceReference = AuthorizationInput['resource']

/** Minimal decoder seam; `createSyncFilesTokenDecoder(secret)` satisfies it. */
export interface SignedTokenDecoder<T> {
  decodeToken(token: string): T | undefined
}

type SharedVaultAssociation = {
  shared_vault_uuid: string
  permission: string
}

export type FileAuthorizationCrossServiceToken = {
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

export type PersonalValetTokenClaims = {
  userUuid: string
  permittedOperation: string
  permittedResources: Array<{
    remoteIdentifier: string
    unencryptedFileSize?: number
  }>
  uploadBytesUsed: number
  uploadBytesLimit: number
}

export type SharedVaultValetTokenClaims = {
  sharedVaultUuid: string
  vaultOwnerUuid: string
  permittedOperation: string
  remoteIdentifier: string
  unencryptedFileSize?: number
  uploadBytesUsed: number
  uploadBytesLimit?: number
}

export type ValetTokenFileResourceAuthorizerOptions = {
  serviceProxy: ServiceProxyInterface
  endpointResolver: EndpointResolverInterface
  authTokenDecoder: SignedTokenDecoder<FileAuthorizationCrossServiceToken>
  valetTokenDecoder: SignedTokenDecoder<PersonalValetTokenClaims | SharedVaultValetTokenClaims>
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_VALET_TOKEN_LENGTH = 8 * 1024

/**
 * Multi-container FILES_V1 authorization.
 *
 * Structurally this is the distributed twin of the home server's canonical
 * authorizer: the live session is re-validated on every operation and the
 * signed valet token is treated as the authoritative ownership, membership,
 * permission and quota snapshot. The difference is what happens to that token
 * afterwards. The home server discards it and touches its own disk; here the
 * token IS the only thing the files service will accept, so it is returned to
 * the adapter and presented — exactly once — as the credential for that one
 * operation. Nothing is ever derived from the socket.
 */
export class ValetTokenFileResourceAuthorizer implements MultiContainerFileResourceAuthorizer {
  constructor(private readonly options: ValetTokenFileResourceAuthorizerOptions) {}

  async authorize(
    input: AuthorizationInput,
    signal: AbortSignal,
  ): Promise<MultiContainerFileAuthorization | undefined> {
    try {
      signal.throwIfAborted()
      if (!this.isAddressableResource(input.resource)) {
        return undefined
      }
      const token = await this.validateSession(input, signal)
      if (!this.sessionAllowsOperation(token, input.resource, input.operation)) {
        return undefined
      }

      if (input.resource.ownershipType === 'user') {
        return await this.authorizePersonalResource(input, token, signal)
      }
      return await this.authorizeSharedVaultResource(input, token, signal)
    } catch {
      return undefined
    }
  }

  /**
   * Identifiers reach a downstream URL path, so anything outside the canonical
   * identifier shape is refused before it can be interpolated.
   */
  private isAddressableResource(resource: FileResourceReference): boolean {
    if (!IDENTIFIER_PATTERN.test(resource.remoteIdentifier)) {
      return false
    }
    if (resource.fileUuid !== undefined && !IDENTIFIER_PATTERN.test(resource.fileUuid)) {
      return false
    }
    if (resource.ownershipType === 'user') {
      return resource.sharedVaultUuid === undefined && resource.sharedVaultOwnerUuid === undefined
    }
    return (
      IDENTIFIER_PATTERN.test(resource.sharedVaultUuid ?? '') &&
      IDENTIFIER_PATTERN.test(resource.sharedVaultOwnerUuid ?? '')
    )
  }

  private async validateSession(
    input: AuthorizationInput,
    signal: AbortSignal,
  ): Promise<FileAuthorizationCrossServiceToken & { authToken: string }> {
    if (!input.identity.authorization) {
      throw new Error('File authorization requires the original session credential.')
    }
    const authorization = input.identity.authorization.replace(/^Bearer\s+/iu, '')
    if (!authorization) {
      throw new Error('File authorization credential is empty.')
    }
    const ownerContext =
      input.resource.ownershipType === 'shared-vault' ? input.resource.sharedVaultOwnerUuid : undefined
    const response = await abortable(
      this.options.serviceProxy.validateSession({
        headers: {
          authorization,
          ...(ownerContext ? { sharedVaultOwnerContext: ownerContext } : {}),
        },
        requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
      }),
      signal,
    )
    if (response.status !== 200 || !isObject(response.data) || typeof response.data.authToken !== 'string') {
      throw new Error('File session is no longer authorized.')
    }
    const authToken = response.data.authToken
    const token = this.options.authTokenDecoder.decodeToken(authToken)
    if (
      !token ||
      !isObject(token.user) ||
      token.user.uuid !== input.identity.userUuid ||
      !isObject(token.session) ||
      token.session.uuid !== input.identity.sessionUuid ||
      !Array.isArray(token.roles)
    ) {
      throw new Error('File session identity changed.')
    }
    signal.throwIfAborted()
    return { ...token, authToken }
  }

  private sessionAllowsOperation(
    token: FileAuthorizationCrossServiceToken,
    resource: FileResourceReference,
    operation: MultiContainerFileOperation,
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
    token: FileAuthorizationCrossServiceToken & { authToken: string },
    signal: AbortSignal,
  ): Promise<MultiContainerFileAuthorization | undefined> {
    const operation = valetOperation(input.operation)
    const minted = await this.mint(
      (request, response, endpointResolver) =>
        this.options.serviceProxy.callAuthServer(
          request,
          response,
          endpointResolver.resolveEndpointOrMethodIdentifier('POST', 'valet-tokens'),
          {
            operation,
            resources: [
              {
                remoteIdentifier: input.resource.remoteIdentifier,
                ...(input.operation === 'upload' ? { unencryptedFileSize: input.decryptedSize } : {}),
              },
            ],
          },
        ),
      token,
      signal,
    )
    if (!minted) {
      return undefined
    }
    const claims = this.options.valetTokenDecoder.decodeToken(minted)
    if (!isPersonalValetTokenClaims(claims)) {
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
    return { storageOwnerUuid: input.identity.userUuid, valetToken: minted }
  }

  private async authorizeSharedVaultResource(
    input: AuthorizationInput,
    token: FileAuthorizationCrossServiceToken & { authToken: string },
    signal: AbortSignal,
  ): Promise<MultiContainerFileAuthorization | undefined> {
    if (
      input.resource.ownershipType !== 'shared-vault' ||
      !input.resource.sharedVaultUuid ||
      !input.resource.sharedVaultOwnerUuid
    ) {
      return undefined
    }
    const sharedVaultUuid = input.resource.sharedVaultUuid
    const operation = valetOperation(input.operation)
    const minted = await this.mint(
      (request, response, endpointResolver) =>
        this.options.serviceProxy.callSyncingServer(
          request,
          response,
          endpointResolver.resolveEndpointOrMethodIdentifier(
            'POST',
            'shared-vaults/:sharedVaultUuid/valet-tokens',
            sharedVaultUuid,
          ),
          {
            file_uuid: input.resource.fileUuid,
            remote_identifier: input.resource.remoteIdentifier,
            operation,
            ...(input.operation === 'upload' ? { unencrypted_file_size: input.decryptedSize } : {}),
          },
        ),
      token,
      signal,
    )
    if (!minted) {
      return undefined
    }
    const claims = this.options.valetTokenDecoder.decodeToken(minted)
    if (
      !isSharedVaultValetTokenClaims(claims) ||
      claims.sharedVaultUuid !== sharedVaultUuid ||
      claims.vaultOwnerUuid !== input.resource.sharedVaultOwnerUuid ||
      claims.remoteIdentifier !== input.resource.remoteIdentifier ||
      claims.permittedOperation !== operation ||
      (input.operation === 'upload' && claims.unencryptedFileSize !== input.decryptedSize) ||
      !this.hasQuota(claims.uploadBytesUsed, claims.uploadBytesLimit, input)
    ) {
      return undefined
    }
    return { storageOwnerUuid: sharedVaultUuid, valetToken: minted }
  }

  /**
   * Drives one mint call through the service proxy outside of an HTTP request,
   * capturing the response the proxy would otherwise have written to a client.
   */
  private async mint(
    call: (request: Request, response: Response, endpointResolver: EndpointResolverInterface) => Promise<unknown>,
    token: FileAuthorizationCrossServiceToken & { authToken: string },
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let capturedStatus = 0
    let capturedBody: unknown
    const captureResponse = {
      locals: this.responseLocals(token),
      setHeader: () => captureResponse,
      status: (code: number) => {
        capturedStatus = code
        return captureResponse
      },
      send: (body: unknown) => {
        capturedBody = body
        return captureResponse
      },
      json: (body: unknown) => {
        capturedBody = body
        return captureResponse
      },
    } as unknown as Response
    const captureRequest = {
      method: 'POST',
      url: '/sockets/sync/files',
      headers: {},
      query: {},
    } as unknown as Request

    await abortable(Promise.resolve(call(captureRequest, captureResponse, this.options.endpointResolver)), signal)
    signal.throwIfAborted()
    if (capturedStatus !== 0 && (capturedStatus < 200 || capturedStatus >= 300)) {
      return undefined
    }
    const body = capturedBody as { valetToken?: unknown; data?: { valetToken?: unknown } } | undefined
    const valetToken = body?.valetToken ?? body?.data?.valetToken
    if (
      typeof valetToken !== 'string' ||
      valetToken.length === 0 ||
      valetToken.length > MAX_VALET_TOKEN_LENGTH ||
      /[\s\u0000-\u001f\u007f]/u.test(valetToken)
    ) {
      return undefined
    }
    return valetToken
  }

  private responseLocals(token: FileAuthorizationCrossServiceToken & { authToken: string }): Record<string, unknown> {
    return {
      authToken: token.authToken,
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

function valetOperation(operation: MultiContainerFileOperation): 'read' | 'write' {
  return operation === 'upload' ? 'write' : 'read'
}

function isPersonalValetTokenClaims(value: unknown): value is PersonalValetTokenClaims {
  return (
    isObject(value) &&
    typeof value.userUuid === 'string' &&
    typeof value.permittedOperation === 'string' &&
    Array.isArray(value.permittedResources)
  )
}

function isSharedVaultValetTokenClaims(value: unknown): value is SharedVaultValetTokenClaims {
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
