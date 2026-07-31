import { Metadata, ServiceError } from '@grpc/grpc-js'
import { Status } from '@grpc/grpc-js/build/src/constants'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { ISyncingClient, SyncRequest, SyncResponse } from '@standardnotes/grpc'
import { Request, Response } from 'express'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { SyncResponseHttpRepresentation } from '../../Mapping/Sync/Http/SyncResponseHttpRepresentation'
import { GRPCSyncingServerServiceProxy } from './GRPCSyncingServerServiceProxy'

describe('GRPCSyncingServerServiceProxy', () => {
  let syncingClient: jest.Mocked<ISyncingClient>
  let requestMapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let responseMapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let logger: jest.Mocked<Logger>
  let domainEventFactory: jest.Mocked<DomainEventFactoryInterface>
  let domainEventPublisher: jest.Mocked<DomainEventPublisherInterface>
  let capturedMetadata: Metadata | undefined

  const grpcResponse = new SyncResponse()
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

  const createProxy = () =>
    new GRPCSyncingServerServiceProxy(
      syncingClient,
      requestMapper,
      responseMapper,
      logger,
      domainEventFactory,
      domainEventPublisher,
    )

  beforeEach(() => {
    capturedMetadata = undefined
    syncingClient = {
      syncItems: jest.fn((_request, metadata, callback) => {
        capturedMetadata = metadata
        callback(null, grpcResponse)
        return {} as never
      }),
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
