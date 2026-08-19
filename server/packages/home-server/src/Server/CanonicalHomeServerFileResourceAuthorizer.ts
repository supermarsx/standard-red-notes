import type { Request, Response } from 'express'

import { ServiceIdentifier, type ServiceContainerInterface, type ServiceInterface } from '@standardnotes/domain-core'

import type {
  HomeServerFileAuthorization,
  HomeServerFileOperation,
  HomeServerFileResourceAuthorizer,
} from './HomeServerSyncFilesAdapter'

type AuthorizationInput = Parameters<HomeServerFileResourceAuthorizer['authorize']>[0]
type FileResourceReference = AuthorizationInput['resource']

type SessionValidationResult = {
  status: number
  data: unknown
}

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
    } catch {
      return undefined
    }
  }

  private async validateSession(input: AuthorizationInput, signal: AbortSignal): Promise<HomeServerCrossServiceToken> {
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
      this.options.sessionValidator.validateSession({
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
    const token = this.options.authTokenDecoder.decodeToken(response.data.authToken)
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
        { locals } as unknown as Response & never,
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
