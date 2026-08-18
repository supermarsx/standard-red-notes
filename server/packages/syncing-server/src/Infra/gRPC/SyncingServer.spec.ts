import * as grpc from '@grpc/grpc-js'
import { Result } from '@standardnotes/domain-core'
import {
  ItemHash,
  SyncCommandMetadata,
  SyncCommandResponseMetadata,
  SyncCommandStatusRequest,
  SyncRequest,
  SyncResponse,
} from '@standardnotes/grpc'
import { Logger } from 'winston'
import { INTERNAL_GRPC_AUTH_METADATA, InternalGrpcAuthScope, InternalGrpcServiceAuth } from '@standardnotes/security'

import { SyncingServer } from './SyncingServer'
import { SyncCommandProtocolError } from '../../Domain/SyncCommand/SyncCommandTypes'

describe('SyncingServer gRPC metadata enforcement', () => {
  let syncItemsUseCase: { execute: jest.Mock }
  let syncResponseFactoryResolver: { resolveSyncResponseFactoryVersion: jest.Mock }
  let mapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let checkForTrafficAbuse: { execute: jest.Mock }
  let logger: jest.Mocked<Logger>
  let grpcResponse: SyncResponse
  let executeSyncCommand: { execute: jest.Mock }
  let getSyncCommandStatus: { execute: jest.Mock }
  const internalGrpcAuthSecret = 'a'.repeat(64)

  const createServer = (options?: { secret?: string; strictAbuseProtection?: boolean }) =>
    new SyncingServer(
      syncItemsUseCase as never,
      syncResponseFactoryResolver as never,
      mapper,
      checkForTrafficAbuse as never,
      options?.strictAbuseProtection ?? false,
      5,
      100,
      50,
      10_000,
      5_000,
      5,
      logger,
      executeSyncCommand as never,
      getSyncCommandStatus as never,
      options?.secret ?? internalGrpcAuthSecret,
    )

  const callWith = (metadataValues: Record<string, string> = {}) => {
    const metadata = new grpc.Metadata()
    metadata.set('x-user-uuid', '00000000-0000-0000-0000-000000000001')
    metadata.set('x-snjs-version', '3.0.0')
    for (const [key, value] of Object.entries(metadataValues)) {
      metadata.set(key, value)
    }

    return {
      request: new SyncRequest(),
      metadata,
    } as grpc.ServerUnaryCall<SyncRequest, SyncResponse>
  }

  const authenticate = (metadata: grpc.Metadata, scope: InternalGrpcAuthScope, timestamp?: number): void => {
    const proof = new InternalGrpcServiceAuth(
      internalGrpcAuthSecret,
      timestamp === undefined ? Date.now : () => timestamp,
    ).sign(scope)
    metadata.set(INTERNAL_GRPC_AUTH_METADATA.version, proof.version)
    metadata.set(INTERNAL_GRPC_AUTH_METADATA.timestamp, proof.timestamp)
    metadata.set(INTERNAL_GRPC_AUTH_METADATA.signature, proof.signature)
  }

  const authenticateSyncCall = (call: grpc.ServerUnaryCall<SyncRequest, SyncResponse>, timestamp?: number): void => {
    const command = call.request.getCommand()
    authenticate(
      call.metadata,
      {
        method: 'syncItems',
        userUuid: call.metadata.get('x-user-uuid')[0] as string,
        sessionUuid: (call.metadata.get('x-session-uuid')[0] as string | undefined) ?? null,
        commandId: command?.getId() ?? '',
        commandDigest: command?.getDigest(),
        bodyDigest: (call.metadata.get('x-sync-canonical-digest')[0] as string | undefined) ?? undefined,
      },
      timestamp,
    )
  }

  beforeEach(() => {
    grpcResponse = new SyncResponse()
    syncItemsUseCase = {
      execute: jest.fn().mockResolvedValue(Result.ok({})),
    }
    syncResponseFactoryResolver = {
      resolveSyncResponseFactoryVersion: jest.fn().mockReturnValue({
        createResponse: jest.fn().mockResolvedValue({}),
      }),
    }
    mapper = {
      toProjection: jest.fn().mockReturnValue(grpcResponse),
      toDomain: jest.fn(),
    }
    checkForTrafficAbuse = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    }
    logger = {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>
    executeSyncCommand = {
      execute: jest.fn(),
    }
    getSyncCommandStatus = {
      execute: jest.fn(),
    }
  })

  it('passes gateway authorization and degradation metadata into SyncItems', async () => {
    const callback = jest.fn()

    await createServer().syncItems(
      callWith({
        'x-read-only-access': 'true',
        'x-is-free-user': 'true',
        'x-has-content-limit': 'true',
        'x-live-sync-enabled': 'false',
        'x-shadow-banned': 'true',
      }),
      callback,
    )

    expect(syncItemsUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnlyAccess: true,
        isFreeUser: true,
        hasContentLimit: true,
        liveSyncEnabled: false,
        shadowBanned: true,
      }),
    )
    expect(callback).toHaveBeenCalledWith(null, grpcResponse)
  })

  it('uses compatibility-safe defaults when optional gate metadata is absent', async () => {
    await createServer().syncItems(callWith(), jest.fn())

    expect(syncItemsUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnlyAccess: false,
        isFreeUser: false,
        hasContentLimit: false,
        liveSyncEnabled: true,
        shadowBanned: false,
      }),
    )
  })

  it('reconstructs the exact cross-transport canonical body including api and excludes command metadata', async () => {
    const call = callWith({ 'x-session-uuid': 'session-1' })
    call.request.setApiVersion('20240226')
    call.request.setSyncToken('token')
    call.request.setLimit(150)
    call.request.setSharedVaultUuidsList(['vault-1'])
    const item = new ItemHash()
    item.setUuid('note-1')
    item.setContent('ciphertext')
    item.setContentType('Note')
    item.setDeleted(false)
    item.setCreatedAt('2026-08-18T12:34:56.789Z')
    item.setUpdatedAtTimestamp(1_787_056_496_789)
    call.request.setItemsList([item])
    const command = new SyncCommandMetadata()
    command.setId('command-1')
    command.setDigest('ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61')
    call.metadata.set('x-sync-canonical-digest', command.getDigest())
    call.request.setCommand(command)
    authenticateSyncCall(call)
    executeSyncCommand.execute.mockResolvedValue({
      response: { command: { id: command.getId(), digest: command.getDigest(), status: 'committed' } },
      replayed: false,
    })

    await createServer().syncItems(call, jest.fn())

    expect(executeSyncCommand.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userUuid: '00000000-0000-0000-0000-000000000001',
        sessionUuid: 'session-1',
        metadata: { id: 'command-1', digest: command.getDigest() },
        canonicalDigest: command.getDigest(),
        canonicalPayload: {
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
          limit: 150,
          shared_vault_uuids: ['vault-1'],
          sync_token: 'token',
        },
      }),
    )
  })

  it('fails durable metadata closed when service authentication is absent or stale', async () => {
    const call = callWith({ 'x-session-uuid': 'session-1' })
    call.request.setApiVersion('20200115')
    const command = new SyncCommandMetadata()
    command.setId('command-1')
    command.setDigest('a'.repeat(64))
    call.request.setCommand(command)
    const unconfiguredCallback = jest.fn()

    await createServer({ secret: '' }).syncItems(call, unconfiguredCallback)

    expect(unconfiguredCallback.mock.calls[0][0].metadata.get('x-sync-error-response-code')).toEqual(['503'])
    expect(executeSyncCommand.execute).not.toHaveBeenCalled()
    expect(checkForTrafficAbuse.execute).not.toHaveBeenCalled()

    authenticateSyncCall(call, Date.now() - 60_001)
    const staleCallback = jest.fn()
    await createServer().syncItems(call, staleCallback)

    expect(staleCallback.mock.calls[0][0].metadata.get('x-sync-error-code')).toEqual([
      'sync_command_authentication_failed',
    ])
    expect(staleCallback.mock.calls[0][0].metadata.get('x-sync-error-response-code')).toEqual(['401'])
    expect(executeSyncCommand.execute).not.toHaveBeenCalled()
  })

  it('returns a committed replay without invoking mutable abuse checks', async () => {
    const call = callWith({ 'x-session-uuid': 'session-1' })
    call.request.setApiVersion('20200115')
    const command = new SyncCommandMetadata()
    command.setId('command-1')
    command.setDigest('a'.repeat(64))
    call.request.setCommand(command)
    authenticateSyncCall(call)
    const responseCommand = new SyncCommandResponseMetadata()
    responseCommand.setId('command-1')
    responseCommand.setDigest(command.getDigest())
    responseCommand.setStatus('committed')
    grpcResponse.setCommand(responseCommand)
    checkForTrafficAbuse.execute.mockResolvedValue(Result.fail('rate limited'))
    executeSyncCommand.execute.mockResolvedValue({
      response: { command: { id: command.getId(), digest: command.getDigest(), status: 'committed' } },
      replayed: true,
    })
    const callback = jest.fn()

    await createServer({ strictAbuseProtection: true }).syncItems(call, callback)

    expect(callback).toHaveBeenCalledWith(null, grpcResponse)
    expect(checkForTrafficAbuse.execute).not.toHaveBeenCalled()
    expect(executeSyncCommand.execute).toHaveBeenCalledWith(
      expect.objectContaining({ beforeExecute: expect.any(Function) }),
    )
  })

  it.each([
    ['sync_command_digest_mismatch', 409, 'false'],
    ['sync_command_pending', 409, 'true'],
  ])('maps %s into a structured gRPC error contract', async (code, httpStatus, retryable) => {
    const call = callWith({ 'x-session-uuid': 'session-1' })
    call.request.setApiVersion('20200115')
    const command = new SyncCommandMetadata()
    command.setId('command-1')
    command.setDigest('a'.repeat(64))
    call.request.setCommand(command)
    authenticateSyncCall(call)
    executeSyncCommand.execute.mockRejectedValue(new SyncCommandProtocolError(code, 'command error', httpStatus))
    const callback = jest.fn()

    await createServer().syncItems(call, callback)

    const serviceError = callback.mock.calls[0][0]
    expect(serviceError.metadata.get('x-sync-error-code')).toEqual([code])
    expect(serviceError.metadata.get('x-sync-error-response-code')).toEqual([String(httpStatus)])
    expect(serviceError.metadata.get('x-sync-error-retryable')).toEqual([retryable])
  })

  it('rejects an unsupported durable API version before executing sync items', async () => {
    const call = callWith({ 'x-session-uuid': 'session-1' })
    call.request.setApiVersion('unsupported')
    const command = new SyncCommandMetadata()
    command.setId('command-1')
    command.setDigest('a'.repeat(64))
    call.request.setCommand(command)
    authenticateSyncCall(call)
    const callback = jest.fn()

    await createServer().syncItems(call, callback)

    expect(executeSyncCommand.execute).not.toHaveBeenCalled()
    expect(syncItemsUseCase.execute).not.toHaveBeenCalled()
    const serviceError = callback.mock.calls[0][0]
    expect(serviceError.metadata.get('x-sync-error-code')).toEqual(['invalid_sync_command_metadata'])
    expect(serviceError.metadata.get('x-sync-error-response-code')).toEqual(['400'])
  })

  it('marks an exact committed replay on the serialized response metadata', async () => {
    const call = callWith({ 'x-session-uuid': 'session-1' })
    call.request.setApiVersion('20200115')
    const requestCommand = new SyncCommandMetadata()
    requestCommand.setId('command-1')
    requestCommand.setDigest('a'.repeat(64))
    call.request.setCommand(requestCommand)
    authenticateSyncCall(call)
    const responseCommand = new SyncCommandResponseMetadata()
    responseCommand.setId('command-1')
    responseCommand.setDigest('a'.repeat(64))
    responseCommand.setStatus('committed')
    grpcResponse.setCommand(responseCommand)
    executeSyncCommand.execute.mockResolvedValue({
      response: { command: { id: 'command-1', digest: 'a'.repeat(64), status: 'committed' } },
      replayed: true,
    })
    const callback = jest.fn()

    await createServer().syncItems(call, callback)

    expect(callback).toHaveBeenCalledWith(null, grpcResponse)
    expect(grpcResponse.getCommand()?.getReplayed()).toBe(true)
  })

  it('passes user/session/digest scope into status and returns committed result JSON', async () => {
    const metadata = new grpc.Metadata()
    metadata.set('x-user-uuid', 'user-1')
    metadata.set('x-session-uuid', 'session-1')
    const request = new SyncCommandStatusRequest()
    request.setId('command-1')
    request.setDigest('a'.repeat(64))
    authenticate(metadata, {
      method: 'getSyncCommandStatus',
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: 'command-1',
      commandDigest: 'a'.repeat(64),
    })
    getSyncCommandStatus.execute.mockResolvedValue({
      command: { id: 'command-1', digest: 'a'.repeat(64), status: 'committed' },
      result: { sync_token: 'stored', saved_items: [] },
    })
    const callback = jest.fn()

    await createServer().getSyncCommandStatus({ request, metadata } as never, callback)

    expect(getSyncCommandStatus.execute).toHaveBeenCalledWith({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: 'command-1',
      requestDigest: 'a'.repeat(64),
    })
    const response = callback.mock.calls[0][1]
    expect(response.getStatus()).toBe('committed')
    expect(response.getResultJson()).toBe('{"sync_token":"stored","saved_items":[]}')
  })
})
