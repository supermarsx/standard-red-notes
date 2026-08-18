import { Metadata, ServiceError } from '@grpc/grpc-js'
import { Status } from '@grpc/grpc-js/build/src/constants'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import {
  ISyncingClient,
  SyncCommandResponseMetadata,
  SyncCommandStatusResponse,
  SyncRequest,
  SyncResponse,
} from '@standardnotes/grpc'
import { Request, Response } from 'express'
import { Logger } from 'winston'
import { INTERNAL_GRPC_AUTH_METADATA, InternalGrpcServiceAuth } from '@standardnotes/security'

import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { SyncResponseHttpRepresentation } from '../../Mapping/Sync/Http/SyncResponseHttpRepresentation'
import { GRPCSyncingServerServiceProxy } from './GRPCSyncingServerServiceProxy'
import { SyncRequestGRPCMapper } from '../../Mapping/Sync/GRPC/SyncRequestGRPCMapper'
import { computeSyncCommandDigest, logicalSyncCommandPayload } from '../Sync/SyncCommandDigest'

describe('GRPCSyncingServerServiceProxy', () => {
  let syncingClient: jest.Mocked<ISyncingClient>
  let requestMapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let responseMapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let logger: jest.Mocked<Logger>
  let domainEventFactory: jest.Mocked<DomainEventFactoryInterface>
  let domainEventPublisher: jest.Mocked<DomainEventPublisherInterface>
  let capturedMetadata: Metadata | undefined
  let capturedRequest: SyncRequest | undefined

  let grpcResponse: SyncResponse
  const internalGrpcAuthSecret = 'a'.repeat(64)
  const httpResponse = { retrieved_items: [] } as unknown as SyncResponseHttpRepresentation

  const request = {
    headers: { 'x-snjs-version': '3.0.0' },
  } as unknown as Request

  const responseWith = (locals: Record<string, unknown> = {}): Response =>
    ({
      locals: {
        user: { uuid: 'user-1' },
        readOnlyAccess: false,
        isFreeUser: false,
        hasContentLimit: false,
        ...locals,
      },
    }) as unknown as Response

  const createProxy = (serviceAuthSecret = internalGrpcAuthSecret) =>
    new GRPCSyncingServerServiceProxy(
      syncingClient,
      requestMapper,
      responseMapper,
      logger,
      domainEventFactory,
      domainEventPublisher,
      serviceAuthSecret,
    )

  beforeEach(() => {
    grpcResponse = new SyncResponse()
    capturedMetadata = undefined
    syncingClient = {
      syncItems: jest.fn((grpcRequest, metadata, callback) => {
        capturedRequest = grpcRequest
        capturedMetadata = metadata
        callback(null, grpcResponse)
        return {} as never
      }),
      getSyncCommandStatus: jest.fn(),
    } as unknown as jest.Mocked<ISyncingClient>
    requestMapper = {
      toProjection: jest.fn().mockReturnValue(new SyncRequest()),
      toDomain: jest.fn(),
    }
    responseMapper = {
      toProjection: jest.fn().mockReturnValue(httpResponse),
      toDomain: jest.fn(),
    }
    logger = {
      debug: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventPublisher = {
      publish: jest.fn(),
    } as unknown as jest.Mocked<DomainEventPublisherInterface>
  })

  it('propagates read-only, live-sync, shadow-ban, and account-limit metadata', async () => {
    await createProxy().sync(
      request,
      responseWith({
        readOnlyAccess: true,
        isFreeUser: true,
        hasContentLimit: true,
        liveSyncEnabled: false,
        shadowBanned: true,
      }),
      { api: '20200115' },
    )

    expect(capturedMetadata?.get('x-read-only-access')).toEqual(['true'])
    expect(capturedMetadata?.get('x-is-free-user')).toEqual(['true'])
    expect(capturedMetadata?.get('x-has-content-limit')).toEqual(['true'])
    expect(capturedMetadata?.get('x-live-sync-enabled')).toEqual(['false'])
    expect(capturedMetadata?.get('x-shadow-banned')).toEqual(['true'])
  })

  it('uses compatibility-safe defaults when optional gate locals are absent', async () => {
    await createProxy().sync(request, responseWith(), { api: '20200115' })

    expect(capturedMetadata?.get('x-live-sync-enabled')).toEqual(['true'])
    expect(capturedMetadata?.get('x-shadow-banned')).toEqual(['false'])
  })

  it('maps a successful gRPC response without exposing the request payload', async () => {
    const result = await createProxy().sync(request, responseWith(), {
      api: '20200115',
      items: [{ content: 'sentinel-encrypted-content' }],
    })

    expect(result).toEqual({ status: 200, data: httpResponse })
    expect(responseMapper.toProjection).toHaveBeenCalledWith(grpcResponse)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sentinel-encrypted-content')
  })

  it('keeps legacy sync requests command-free when metadata is absent', async () => {
    const result = await createProxy().sync(request, responseWith(), { api: '20200115', items: [] })

    expect(capturedRequest?.hasCommand()).toBe(false)
    expect(result).toEqual({ status: 200, data: httpResponse })
  })

  it('fails durable commands closed when dedicated service authentication is not configured', async () => {
    const payload = { api: '20200115', items: [], command: { id: 'command-1', digest: '' } }
    payload.command.digest = computeSyncCommandDigest(logicalSyncCommandPayload(payload))

    const proxy = createProxy('')
    const result = await proxy.sync(request, responseWith(), payload)

    expect(proxy.durableCommandAuthenticationReady()).toBe(false)
    expect(result).toEqual({
      status: 503,
      data: {
        error: {
          code: 'sync_command_authentication_unavailable',
          message: 'Durable sync command authentication is unavailable.',
          retryable: true,
        },
      },
    })
    expect(syncingClient.syncItems).not.toHaveBeenCalled()
  })

  it('accepts a complete header pair and a matching body pair case-insensitively', async () => {
    const payload = { api: '20200115', items: [], command: { id: 'command-1', digest: '' } }
    const digest = computeSyncCommandDigest(logicalSyncCommandPayload(payload))
    payload.command.digest = digest.toLowerCase()
    const commandRequest = {
      headers: {
        'x-snjs-version': '3.0.0',
        'x-sync-command-id': 'command-1',
        'x-sync-command-digest': digest.toUpperCase(),
      },
    } as unknown as Request

    await createProxy().sync(commandRequest, responseWith(), payload)

    expect(capturedRequest?.getCommand()?.getId()).toBe('command-1')
    expect(capturedRequest?.getCommand()?.getDigest()).toBe(digest.toUpperCase())
  })

  it('maps the current wire-normalized 20240226 HTTP body losslessly into the WebSocket/gRPC adapter', async () => {
    const realMapper = new SyncRequestGRPCMapper()
    requestMapper.toProjection.mockImplementation((payload) => realMapper.toProjection(payload))
    const digest = 'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61'
    const currentRequest = {
      headers: {
        'x-snjs-version': '3.0.0',
        'x-sync-command-id': 'command-1',
        'x-sync-command-digest': digest,
      },
    } as unknown as Request

    await createProxy().sync(currentRequest, responseWith(), {
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: '2026-08-18T12:34:56.789Z',
          updated_at_timestamp: 1_787_056_496_789,
        },
      ],
      shared_vault_uuids: ['vault-1'],
      sync_token: 'token',
      limit: 150,
    })

    expect(capturedRequest?.getApiVersion()).toBe('20240226')
    expect(capturedRequest?.getSyncToken()).toBe('token')
    expect(capturedRequest?.getLimit()).toBe(150)
    expect(capturedRequest?.getSharedVaultUuidsList()).toEqual(['vault-1'])
    expect(capturedRequest?.getCommand()?.getDigest()).toBe(digest)
    expect(capturedMetadata?.get('x-sync-canonical-digest')).toEqual([digest])
    expect(
      new InternalGrpcServiceAuth(internalGrpcAuthSecret).verify(
        {
          method: 'syncItems',
          userUuid: 'user-1',
          commandId: 'command-1',
          commandDigest: digest,
          bodyDigest: digest,
        },
        {
          version: capturedMetadata?.get(INTERNAL_GRPC_AUTH_METADATA.version)[0] as string,
          timestamp: capturedMetadata?.get(INTERNAL_GRPC_AUTH_METADATA.timestamp)[0] as string,
          signature: capturedMetadata?.get(INTERNAL_GRPC_AUTH_METADATA.signature)[0] as string,
        },
      ),
    ).toBe('valid')
    expect(capturedRequest?.getItemsList()[0]?.toObject()).toMatchObject({
      uuid: 'note-1',
      content: 'ciphertext',
      contentType: 'Note',
      deleted: false,
      createdAt: '2026-08-18T12:34:56.789Z',
      updatedAtTimestamp: 1_787_056_496_789,
    })
  })

  it('rejects a validly-shaped digest that does not match the exact logical request body', async () => {
    const result = await createProxy().sync(
      {
        headers: {
          'x-snjs-version': '3.0.0',
          'x-sync-command-id': 'command-1',
          'x-sync-command-digest': 'a'.repeat(64),
        },
      } as unknown as Request,
      responseWith(),
      { api: '20240226', items: [], limit: 150 },
    )

    expect(result).toEqual({
      status: 409,
      data: {
        error: {
          code: 'sync_command_digest_mismatch',
          message: 'Sync command digest does not match the logical sync request body.',
          retryable: false,
        },
      },
    })
    expect(syncingClient.syncItems).not.toHaveBeenCalled()
  })

  it.each([
    [{ 'x-sync-command-id': 'command-1' }, { api: '20200115', items: [] }],
    [{ 'x-sync-command-digest': 'a'.repeat(64) }, { api: '20200115', items: [] }],
    [{}, { api: '20200115', items: [], command: { id: 'command-1' } }],
    [{}, { api: '20200115', items: [], command: 'invalid' }],
  ])('rejects incomplete or malformed command metadata before calling gRPC', async (headers, payload) => {
    const result = await createProxy().sync(
      { headers: { 'x-snjs-version': '3.0.0', ...headers } } as unknown as Request,
      responseWith(),
      payload,
    )

    expect(result).toEqual({
      status: 400,
      data: {
        error: {
          code: 'invalid_sync_command_metadata',
          message: 'Sync command id and digest must be supplied together.',
          retryable: false,
        },
      },
    })
    expect(syncingClient.syncItems).not.toHaveBeenCalled()
  })

  it('rejects header/body disagreement before calling gRPC', async () => {
    const result = await createProxy().sync(
      {
        headers: {
          'x-snjs-version': '3.0.0',
          'x-sync-command-id': 'header-command',
          'x-sync-command-digest': 'a'.repeat(64),
        },
      } as unknown as Request,
      responseWith(),
      {
        api: '20200115',
        items: [],
        command: { id: 'body-command', digest: 'a'.repeat(64) },
      },
    )

    expect(result).toEqual({
      status: 400,
      data: {
        error: {
          code: 'invalid_sync_command_metadata',
          message: 'Sync command headers and body metadata disagree.',
          retryable: false,
        },
      },
    })
    expect(syncingClient.syncItems).not.toHaveBeenCalled()
  })

  it('returns replay state and committed metadata from a command response', async () => {
    const command = new SyncCommandResponseMetadata()
    command.setId('command-1')
    command.setDigest('a'.repeat(64))
    command.setStatus('committed')
    command.setReplayed(true)
    grpcResponse.setCommand(command)
    responseMapper.toProjection.mockReturnValue({
      ...httpResponse,
      command: { id: 'command-1', digest: 'a'.repeat(64), status: 'committed' },
    })

    await expect(createProxy().sync(request, responseWith(), { api: '20200115', items: [] })).resolves.toMatchObject({
      status: 200,
      replayed: true,
      data: { command: { id: 'command-1', status: 'committed' } },
    })
  })

  it('queries status with the authenticated user/session scope and returns the exact stored result JSON', async () => {
    const statusResponse = new SyncCommandStatusResponse()
    statusResponse.setId('command-1')
    statusResponse.setStatus('committed')
    statusResponse.setDigest('a'.repeat(64))
    statusResponse.setResultJson('{"sync_token":"stored","saved_items":[]}')
    ;(syncingClient.getSyncCommandStatus as jest.Mock).mockImplementation((statusRequest, metadata, callback) => {
      capturedMetadata = metadata
      expect(statusRequest.getId()).toBe('command-1')
      expect(statusRequest.getDigest()).toBe('a'.repeat(64))
      callback(null, statusResponse)
      return {} as never
    })

    const result = await createProxy().getSyncCommandStatus(
      request,
      responseWith({ session: { uuid: 'session-1' } }),
      'command-1',
      'a'.repeat(64),
    )

    expect(capturedMetadata?.get('x-user-uuid')).toEqual(['user-1'])
    expect(capturedMetadata?.get('x-session-uuid')).toEqual(['session-1'])
    expect(result).toEqual({
      status: 200,
      data: {
        command: { id: 'command-1', digest: 'a'.repeat(64), status: 'committed' },
        result: { sync_token: 'stored', saved_items: [] },
      },
    })
  })

  it('does not log encrypted request content when gRPC returns an internal error', async () => {
    const error = Object.assign(new Error('grpc-credential-sentinel'), {
      code: Status.INTERNAL,
      metadata: new Metadata(),
    }) as ServiceError
    syncingClient.syncItems.mockImplementation((_request, metadata, callback) => {
      capturedMetadata = metadata
      callback(error, undefined as never)
      return {} as never
    })

    await expect(
      createProxy().sync(request, responseWith(), {
        api: '20200115',
        items: [{ content: 'sentinel-encrypted-content', auth_hash: 'sentinel-auth-hash' }],
      }),
    ).rejects.toBe(error)

    expect(logger.error).toHaveBeenCalledWith('Internal gRPC error.', {
      codeTag: 'GRPCSyncingServerServiceProxy',
      userId: 'user-1',
      errorType: 'Error',
      errorCode: Status.INTERNAL,
      status: undefined,
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('grpc-credential-sentinel')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sentinel-encrypted-content')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sentinel-auth-hash')
  })
})
