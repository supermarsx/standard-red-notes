import type { Request, Response } from 'express'

import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import type { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'
import {
  ValetTokenFileResourceAuthorizer,
  type FileAuthorizationCrossServiceToken,
  type PersonalValetTokenClaims,
  type SharedVaultValetTokenClaims,
  type SignedTokenDecoder,
} from './ValetTokenFileResourceAuthorizer'
import type { MultiContainerFileResourceAuthorizer } from './MultiContainerSyncFilesAdapter'

type AuthorizeInput = Parameters<MultiContainerFileResourceAuthorizer['authorize']>[0]

type MintCall = {
  service: 'auth' | 'syncing'
  endpoint: string
  payload: unknown
  locals: Record<string, unknown>
}

const IDENTITY = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer live-session-credential',
}

const PERSONAL = { ownershipType: 'user' as const, remoteIdentifier: 'resource-1' }

const SHARED = {
  ownershipType: 'shared-vault' as const,
  remoteIdentifier: 'resource-2',
  fileUuid: 'file-2',
  sharedVaultUuid: 'vault-1',
  sharedVaultOwnerUuid: 'owner-1',
}

const BASE_TOKEN: FileAuthorizationCrossServiceToken = {
  user: { uuid: 'user-1' },
  roles: [{ name: 'CORE_USER' }],
  session: { uuid: 'session-1' },
  belongs_to_shared_vaults: [{ shared_vault_uuid: 'vault-1', permission: 'write' }],
}

const PERSONAL_CLAIMS: PersonalValetTokenClaims = {
  userUuid: 'user-1',
  permittedOperation: 'read',
  permittedResources: [{ remoteIdentifier: 'resource-1' }],
  uploadBytesUsed: 0,
  uploadBytesLimit: -1,
}

const SHARED_CLAIMS: SharedVaultValetTokenClaims = {
  sharedVaultUuid: 'vault-1',
  vaultOwnerUuid: 'owner-1',
  permittedOperation: 'read',
  remoteIdentifier: 'resource-2',
  uploadBytesUsed: 0,
  uploadBytesLimit: -1,
}

class FakeServiceProxy {
  validateSessionCalls: unknown[] = []
  mintCalls: MintCall[] = []
  sessionStatus = 200
  sessionData: unknown = { authToken: 'auth-token' }
  mintStatus = 200
  mintBody: unknown = { data: { valetToken: 'minted.valet.token' } }
  throwOnMint?: Error

  async validateSession(dto: unknown) {
    this.validateSessionCalls.push(dto)
    return { status: this.sessionStatus, data: this.sessionData, headers: { contentType: 'application/json' } }
  }

  callAuthServer = async (
    _request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> => this.mint('auth', response, endpoint, payload)

  callSyncingServer = async (
    _request: Request,
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> => this.mint('syncing', response, endpoint, payload)

  private async mint(
    service: 'auth' | 'syncing',
    response: Response,
    endpoint: string,
    payload?: Record<string, unknown> | string,
  ): Promise<void> {
    this.mintCalls.push({ service, endpoint, payload, locals: response.locals as Record<string, unknown> })
    if (this.throwOnMint) {
      throw this.throwOnMint
    }
    response.status(this.mintStatus).send(this.mintBody)
  }
}

const endpointResolver: EndpointResolverInterface = {
  resolveEndpointOrMethodIdentifier: (_method: string, endpoint: string, ...params: string[]) => {
    let index = 0
    return endpoint.replace(/:[a-zA-Z0-9]+/g, (match) => (index < params.length ? params[index++] : match))
  },
}

function decoderOf<T>(value: T | undefined): SignedTokenDecoder<T> {
  return { decodeToken: () => value }
}

function build(
  overrides: {
    token?: FileAuthorizationCrossServiceToken | undefined
    claims?: PersonalValetTokenClaims | SharedVaultValetTokenClaims | undefined
  } = {},
) {
  const serviceProxy = new FakeServiceProxy()
  const authorizer = new ValetTokenFileResourceAuthorizer({
    serviceProxy: serviceProxy as unknown as ServiceProxyInterface,
    endpointResolver,
    authTokenDecoder: decoderOf('token' in overrides ? overrides.token : BASE_TOKEN),
    valetTokenDecoder: decoderOf('claims' in overrides ? overrides.claims : PERSONAL_CLAIMS),
  })
  return { serviceProxy, authorizer }
}

const signal = (): AbortSignal => new AbortController().signal

function input(patch: Partial<AuthorizeInput> = {}): AuthorizeInput {
  return {
    identity: IDENTITY,
    resource: PERSONAL,
    operation: 'download',
    ...patch,
  } as AuthorizeInput
}

describe('ValetTokenFileResourceAuthorizer', () => {
  describe('personal resources', () => {
    it('re-validates the live session and returns the freshly minted credential', async () => {
      const { serviceProxy, authorizer } = build()

      const result = await authorizer.authorize(input(), signal())

      expect(result).toEqual({ storageOwnerUuid: 'user-1', valetToken: 'minted.valet.token' })
      expect(serviceProxy.validateSessionCalls).toEqual([
        {
          headers: { authorization: 'live-session-credential' },
          requestMetadata: { url: '/sockets/sync/files', method: 'POST' },
        },
      ])
      expect(serviceProxy.mintCalls).toHaveLength(1)
      expect(serviceProxy.mintCalls[0].service).toBe('auth')
      expect(serviceProxy.mintCalls[0].endpoint).toBe('valet-tokens')
      expect(serviceProxy.mintCalls[0].payload).toEqual({
        operation: 'read',
        resources: [{ remoteIdentifier: 'resource-1' }],
      })
      expect(serviceProxy.mintCalls[0].locals.authToken).toBe('auth-token')
    })

    it('requests a write credential carrying the declared decrypted size for an upload', async () => {
      const { serviceProxy, authorizer } = build({
        claims: {
          ...PERSONAL_CLAIMS,
          permittedOperation: 'write',
          permittedResources: [{ remoteIdentifier: 'resource-1', unencryptedFileSize: 500 }],
        },
      })

      const result = await authorizer.authorize(input({ operation: 'upload', decryptedSize: 500 }), signal())

      expect(result).toEqual({ storageOwnerUuid: 'user-1', valetToken: 'minted.valet.token' })
      expect(serviceProxy.mintCalls[0].payload).toEqual({
        operation: 'write',
        resources: [{ remoteIdentifier: 'resource-1', unencryptedFileSize: 500 }],
      })
    })

    it('accepts a mint response that is not envelope-wrapped', async () => {
      const { serviceProxy, authorizer } = build()
      serviceProxy.mintBody = { valetToken: 'bare.valet.token' }

      expect(await authorizer.authorize(input(), signal())).toEqual({
        storageOwnerUuid: 'user-1',
        valetToken: 'bare.valet.token',
      })
    })
  })

  describe('shared-vault resources', () => {
    it('mints through the syncing server with the vault owner context', async () => {
      const { serviceProxy, authorizer } = build({ claims: SHARED_CLAIMS })

      const result = await authorizer.authorize(input({ resource: SHARED }), signal())

      expect(result).toEqual({ storageOwnerUuid: 'vault-1', valetToken: 'minted.valet.token' })
      expect(serviceProxy.validateSessionCalls[0]).toMatchObject({
        headers: { authorization: 'live-session-credential', sharedVaultOwnerContext: 'owner-1' },
      })
      expect(serviceProxy.mintCalls[0].service).toBe('syncing')
      expect(serviceProxy.mintCalls[0].endpoint).toBe('shared-vaults/vault-1/valet-tokens')
      expect(serviceProxy.mintCalls[0].payload).toEqual({
        file_uuid: 'file-2',
        remote_identifier: 'resource-2',
        operation: 'read',
      })
    })

    it.each([
      ['the session is not a member', { belongs_to_shared_vaults: [] }],
      [
        'the membership names an unknown permission',
        { belongs_to_shared_vaults: [{ shared_vault_uuid: 'vault-1', permission: 'lurker' }] },
      ],
      [
        'the membership is for another vault',
        { belongs_to_shared_vaults: [{ shared_vault_uuid: 'vault-9', permission: 'admin' }] },
      ],
      ['collaboration is disabled', { collaboration_enabled: false }],
    ])('denies and never mints when %s', async (_label, patch) => {
      const { serviceProxy, authorizer } = build({ token: { ...BASE_TOKEN, ...patch }, claims: SHARED_CLAIMS })

      expect(await authorizer.authorize(input({ resource: SHARED }), signal())).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it('denies an upload for a read-only vault member', async () => {
      const { serviceProxy, authorizer } = build({
        token: { ...BASE_TOKEN, belongs_to_shared_vaults: [{ shared_vault_uuid: 'vault-1', permission: 'read' }] },
        claims: SHARED_CLAIMS,
      })

      expect(
        await authorizer.authorize(input({ resource: SHARED, operation: 'upload', decryptedSize: 10 }), signal()),
      ).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it.each([
      ['a mismatched vault', { sharedVaultUuid: 'vault-9' }],
      ['a mismatched vault owner', { vaultOwnerUuid: 'owner-9' }],
      ['a mismatched resource', { remoteIdentifier: 'resource-9' }],
      ['a mismatched operation', { permittedOperation: 'write' }],
    ])('rejects minted claims carrying %s', async (_label, patch) => {
      const { authorizer } = build({ claims: { ...SHARED_CLAIMS, ...patch } })
      expect(await authorizer.authorize(input({ resource: SHARED }), signal())).toBeUndefined()
    })
  })

  describe('session revalidation', () => {
    it('denies without the original session credential and never calls out', async () => {
      const { serviceProxy, authorizer } = build()

      const result = await authorizer.authorize(
        input({ identity: { ...IDENTITY, authorization: undefined } }),
        signal(),
      )

      expect(result).toBeUndefined()
      expect(serviceProxy.validateSessionCalls).toHaveLength(0)
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it('denies an empty bearer credential', async () => {
      const { serviceProxy, authorizer } = build()
      expect(
        await authorizer.authorize(input({ identity: { ...IDENTITY, authorization: 'Bearer ' } }), signal()),
      ).toBeUndefined()
      expect(serviceProxy.validateSessionCalls).toHaveLength(0)
    })

    it.each([
      ['the session is no longer valid', (proxy: FakeServiceProxy) => (proxy.sessionStatus = 401)],
      ['the session response carries no token', (proxy: FakeServiceProxy) => (proxy.sessionData = {})],
      ['the session response is not an object', (proxy: FakeServiceProxy) => (proxy.sessionData = 'nope')],
    ])('denies and never mints when %s', async (_label, mutate) => {
      const { serviceProxy, authorizer } = build()
      mutate(serviceProxy)

      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it('denies when the cross-service token cannot be verified', async () => {
      const { serviceProxy, authorizer } = build({ token: undefined })
      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it.each([
      ['the user changed', { user: { uuid: 'user-9' } }],
      ['the session changed', { session: { uuid: 'session-9' } }],
      ['the roles are missing', { roles: undefined as unknown as unknown[] }],
    ])('denies when %s', async (_label, patch) => {
      const { serviceProxy, authorizer } = build({ token: { ...BASE_TOKEN, ...patch } })
      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it('denies every operation when live sync is disabled for the account', async () => {
      const { serviceProxy, authorizer } = build({ token: { ...BASE_TOKEN, live_sync_enabled: false } })
      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it.each([
      ['a read-only session', { session: { uuid: 'session-1', readonly_access: true } }],
      ['a read-scoped MCP token', { mcp_scope: { access: 'read' } }],
      ['an account at its content limit', { hasContentLimit: true }],
      ['a shadow-banned account', { shadow_banned: true }],
    ])('denies an upload from %s', async (_label, patch) => {
      const { serviceProxy, authorizer } = build({ token: { ...BASE_TOKEN, ...patch } })

      expect(await authorizer.authorize(input({ operation: 'upload', decryptedSize: 10 }), signal())).toBeUndefined()
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })

    it('still allows a download from a read-only session', async () => {
      const { authorizer } = build({ token: { ...BASE_TOKEN, session: { uuid: 'session-1', readonly_access: true } } })
      expect(await authorizer.authorize(input(), signal())).toEqual({
        storageOwnerUuid: 'user-1',
        valetToken: 'minted.valet.token',
      })
    })
  })

  describe('resource addressing', () => {
    it.each([
      ['a traversal identifier', { ownershipType: 'user' as const, remoteIdentifier: '../../etc/passwd' }],
      ['an identifier with a path separator', { ownershipType: 'user' as const, remoteIdentifier: 'a/b' }],
      ['an identifier with a query separator', { ownershipType: 'user' as const, remoteIdentifier: 'a?b=c' }],
      [
        'a vault identifier with a path separator',
        {
          ownershipType: 'shared-vault' as const,
          remoteIdentifier: 'resource-2',
          sharedVaultUuid: 'vault/../other',
          sharedVaultOwnerUuid: 'owner-1',
        },
      ],
      [
        'a personal reference carrying vault fields',
        { ownershipType: 'user' as const, remoteIdentifier: 'resource-1', sharedVaultUuid: 'vault-1' },
      ],
    ])('refuses %s before any downstream call', async (_label, resource) => {
      const { serviceProxy, authorizer } = build()

      expect(await authorizer.authorize(input({ resource } as Partial<AuthorizeInput>), signal())).toBeUndefined()
      expect(serviceProxy.validateSessionCalls).toHaveLength(0)
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })
  })

  describe('minted credential checks', () => {
    it.each([
      ['a mismatched user', { userUuid: 'user-9' }],
      ['a mismatched operation', { permittedOperation: 'write' }],
      ['a mismatched resource', { permittedResources: [{ remoteIdentifier: 'resource-9' }] }],
      ['no resource at all', { permittedResources: [] }],
      [
        'more resources than requested',
        { permittedResources: [{ remoteIdentifier: 'resource-1' }, { remoteIdentifier: 'resource-2' }] },
      ],
    ])('rejects claims carrying %s', async (_label, patch) => {
      const { authorizer } = build({ claims: { ...PERSONAL_CLAIMS, ...patch } })
      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
    })

    it('rejects an upload whose minted size disagrees with the declared size', async () => {
      const { authorizer } = build({
        claims: {
          ...PERSONAL_CLAIMS,
          permittedOperation: 'write',
          permittedResources: [{ remoteIdentifier: 'resource-1', unencryptedFileSize: 99 }],
        },
      })
      expect(await authorizer.authorize(input({ operation: 'upload', decryptedSize: 100 }), signal())).toBeUndefined()
    })

    it('rejects a token that cannot be verified', async () => {
      const { authorizer } = build({ claims: undefined })
      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
    })

    it.each([
      ['a non-2xx mint', (proxy: FakeServiceProxy) => (proxy.mintStatus = 403)],
      ['a mint that returned no token', (proxy: FakeServiceProxy) => (proxy.mintBody = { data: {} })],
      ['a non-string token', (proxy: FakeServiceProxy) => (proxy.mintBody = { data: { valetToken: 42 } })],
      [
        'an oversized token',
        (proxy: FakeServiceProxy) => (proxy.mintBody = { data: { valetToken: 'v'.repeat(8 * 1024 + 1) } }),
      ],
      ['a whitespace token', (proxy: FakeServiceProxy) => (proxy.mintBody = { data: { valetToken: 'a b' } })],
      ['a mint that threw', (proxy: FakeServiceProxy) => (proxy.throwOnMint = new Error('downstream down'))],
    ])('denies on %s', async (_label, mutate) => {
      const { serviceProxy, authorizer } = build()
      mutate(serviceProxy)
      expect(await authorizer.authorize(input(), signal())).toBeUndefined()
    })
  })

  describe('quota', () => {
    it('allows an upload that fits the remaining allowance', async () => {
      const { authorizer } = build({
        claims: {
          ...PERSONAL_CLAIMS,
          permittedOperation: 'write',
          permittedResources: [{ remoteIdentifier: 'resource-1', unencryptedFileSize: 100 }],
          uploadBytesUsed: 100,
          uploadBytesLimit: 1000,
        },
      })
      expect(await authorizer.authorize(input({ operation: 'upload', decryptedSize: 100 }), signal())).toEqual({
        storageOwnerUuid: 'user-1',
        valetToken: 'minted.valet.token',
      })
    })

    it.each([
      ['the allowance is exhausted', { uploadBytesUsed: 950, uploadBytesLimit: 1000 }],
      ['the allowance is exactly consumed', { uploadBytesUsed: 900, uploadBytesLimit: 1000 }],
      ['the reported usage is nonsense', { uploadBytesUsed: -5, uploadBytesLimit: 1000 }],
      ['the reported limit is nonsense', { uploadBytesUsed: 0, uploadBytesLimit: -7 }],
    ])('denies an upload when %s', async (_label, patch) => {
      const { authorizer } = build({
        claims: {
          ...PERSONAL_CLAIMS,
          permittedOperation: 'write',
          permittedResources: [{ remoteIdentifier: 'resource-1', unencryptedFileSize: 100 }],
          ...patch,
        },
      })
      expect(await authorizer.authorize(input({ operation: 'upload', decryptedSize: 100 }), signal())).toBeUndefined()
    })

    it('ignores quota for a download', async () => {
      const { authorizer } = build({ claims: { ...PERSONAL_CLAIMS, uploadBytesUsed: 10_000, uploadBytesLimit: 10 } })
      expect(await authorizer.authorize(input(), signal())).toBeDefined()
    })
  })

  describe('cancellation', () => {
    it('denies and never calls out once the signal is aborted', async () => {
      const { serviceProxy, authorizer } = build()
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))

      expect(await authorizer.authorize(input(), controller.signal)).toBeUndefined()
      expect(serviceProxy.validateSessionCalls).toHaveLength(0)
      expect(serviceProxy.mintCalls).toHaveLength(0)
    })
  })
})
