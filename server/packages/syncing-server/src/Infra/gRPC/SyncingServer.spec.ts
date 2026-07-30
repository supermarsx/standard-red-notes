import * as grpc from '@grpc/grpc-js'
import { Result } from '@standardnotes/domain-core'
import { SyncRequest, SyncResponse } from '@standardnotes/grpc'
import { Logger } from 'winston'

import { SyncingServer } from './SyncingServer'

describe('SyncingServer gRPC metadata enforcement', () => {
  let syncItemsUseCase: { execute: jest.Mock }
  let syncResponseFactoryResolver: { resolveSyncResponseFactoryVersion: jest.Mock }
  let mapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let checkForTrafficAbuse: { execute: jest.Mock }
  let logger: jest.Mocked<Logger>
  let grpcResponse: SyncResponse

  const createServer = () =>
    new SyncingServer(
      syncItemsUseCase as never,
      syncResponseFactoryResolver as never,
      mapper,
      checkForTrafficAbuse as never,
      false,
      5,
      100,
      50,
      10_000,
      5_000,
      5,
      logger,
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
})
