import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'
import { Logger } from 'winston'

import { computeSyncCommandDigest, SyncCommandProtocolError } from '../../../Domain/SyncCommand/SyncCommandTypes'
import { BaseItemsController } from './BaseItemsController'

describe('BaseItemsController durable sync commands', () => {
  let checkForTrafficAbuse: { execute: jest.Mock }
  let syncItems: { execute: jest.Mock }
  let responseFactory: { createResponse: jest.Mock }
  let syncResponseFactoryResolver: { resolveSyncResponseFactoryVersion: jest.Mock }
  let executeSyncCommand: { execute: jest.Mock }
  let getSyncCommandStatus: { execute: jest.Mock }
  let logger: jest.Mocked<Logger>
  let setHeader: jest.Mock

  const modernResponse = {
    retrieved_items: [],
    saved_items: [],
    conflicts: [],
    sync_token: 'stored-token',
    messages: [],
    shared_vaults: [],
    shared_vault_invites: [],
    notifications: [],
  }

  const createController = (strictAbuseProtection = false) =>
    new BaseItemsController(
      checkForTrafficAbuse as never,
      syncItems as never,
      {} as never,
      {} as never,
      {} as never,
      syncResponseFactoryResolver,
      logger,
      strictAbuseProtection,
      5,
      100,
      50,
      10_000,
      5_000,
      5,
      undefined,
      undefined,
      executeSyncCommand as never,
      getSyncCommandStatus as never,
    )

  const response = (): Response =>
    ({
      locals: {
        user: { uuid: 'user-1' },
        session: { uuid: 'session-1' },
        readOnlyAccess: false,
        isFreeUser: false,
        hasContentLimit: false,
      },
      setHeader,
    }) as unknown as Response

  const request = (body: Record<string, unknown>, headers: Record<string, string | string[]> = {}): Request =>
    ({ body, headers, params: {} }) as unknown as Request

  beforeEach(() => {
    checkForTrafficAbuse = { execute: jest.fn().mockResolvedValue(Result.ok()) }
    syncItems = { execute: jest.fn().mockResolvedValue(Result.ok({})) }
    responseFactory = { createResponse: jest.fn().mockResolvedValue(modernResponse) }
    syncResponseFactoryResolver = {
      resolveSyncResponseFactoryVersion: jest.fn().mockReturnValue(responseFactory),
    }
    executeSyncCommand = {
      execute: jest.fn().mockImplementation(async (dto) => {
        await dto.beforeExecute?.()
        const syncResponse = await dto.execute()
        return {
          response: {
            ...syncResponse,
            command: { id: dto.metadata.id, digest: dto.metadata.digest.toLowerCase(), status: 'committed' },
          },
          replayed: false,
        }
      }),
    }
    getSyncCommandStatus = { execute: jest.fn() }
    logger = {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    } as unknown as jest.Mocked<Logger>
    setHeader = jest.fn()
  })

  it('keeps a current 20240226 request without metadata on the unchanged legacy execution path', async () => {
    const result = await createController().sync(request({ api: '20240226', items: [] }), response())

    expect(executeSyncCommand.execute).not.toHaveBeenCalled()
    expect(syncItems.execute).toHaveBeenCalledTimes(1)
    expect((result as results.JsonResult).json).toEqual(modernResponse)
    expect(setHeader).not.toHaveBeenCalled()
  })

  it.each(['20200115', '20240226'])('commits durable commands on supported API version %s', async (api) => {
    const logicalBody = { api, items: [] }
    const digest = computeSyncCommandDigest(logicalBody)
    const result = await createController().sync(
      request(logicalBody, {
        'x-sync-command-id': 'command-1',
        'x-sync-command-digest': digest,
      }),
      response(),
    )

    expect(executeSyncCommand.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        metadata: { id: 'command-1', digest },
        canonicalPayload: logicalBody,
      }),
    )
    expect((result as results.JsonResult).json).toEqual({
      ...modernResponse,
      command: { id: 'command-1', digest, status: 'committed' },
    })
    expect(setHeader).toHaveBeenCalledWith('X-Sync-Command-Status', 'committed')
    expect(setHeader).toHaveBeenCalledWith('X-Sync-Command-Replayed', 'false')
  })

  it('returns an exact committed replay even when current abuse checks would reject new work', async () => {
    const logicalBody = { api: '20240226', items: [] }
    const digest = computeSyncCommandDigest(logicalBody)
    checkForTrafficAbuse.execute.mockResolvedValue(Result.fail('rate limited'))
    executeSyncCommand.execute.mockResolvedValue({
      response: {
        ...modernResponse,
        command: { id: 'command-1', digest, status: 'committed' },
      },
      replayed: true,
    })

    const result = await createController(true).sync(
      request(logicalBody, {
        'x-sync-command-id': 'command-1',
        'x-sync-command-digest': digest,
      }),
      response(),
    )

    expect((result as results.JsonResult).json).toEqual({
      ...modernResponse,
      command: { id: 'command-1', digest, status: 'committed' },
    })
    expect(checkForTrafficAbuse.execute).not.toHaveBeenCalled()
    expect(syncItems.execute).not.toHaveBeenCalled()
    expect(setHeader).toHaveBeenCalledWith('X-Sync-Command-Replayed', 'true')
  })

  it.each(['20161215', 'unsupported'])(
    'rejects unsupported durable API version %s without mutating items',
    async (api) => {
      const logicalBody = { api, items: [] }
      const result = await createController().sync(
        request(logicalBody, {
          'x-sync-command-id': 'command-1',
          'x-sync-command-digest': computeSyncCommandDigest(logicalBody),
        }),
        response(),
      )

      expect(result.statusCode).toBe(400)
      expect((result as results.JsonResult).json).toEqual({
        error: {
          code: 'invalid_sync_command_metadata',
          message: 'Durable sync commands require a supported modern sync API version.',
          retryable: false,
        },
      })
      expect(syncItems.execute).not.toHaveBeenCalled()
      expect(executeSyncCommand.execute).not.toHaveBeenCalled()
    },
  )

  it('rejects one-header-only and header/body disagreement before item mutation', async () => {
    const oneHeader = await createController().sync(
      request({ api: '20240226', items: [] }, { 'x-sync-command-id': 'command-1' }),
      response(),
    )
    const mismatchBody = { api: '20240226', items: [], command: { id: 'body-id', digest: 'a'.repeat(64) } }
    const disagreement = await createController().sync(
      request(mismatchBody, {
        'x-sync-command-id': 'header-id',
        'x-sync-command-digest': 'a'.repeat(64),
      }),
      response(),
    )

    expect(oneHeader.statusCode).toBe(400)
    expect(disagreement.statusCode).toBe(400)
    expect(syncItems.execute).not.toHaveBeenCalled()
  })

  it('preserves digest mismatch and pending retry contracts from the command executor', async () => {
    const logicalBody = { api: '20240226', items: [] }
    const digest = computeSyncCommandDigest(logicalBody)
    executeSyncCommand.execute.mockRejectedValueOnce(
      new SyncCommandProtocolError('sync_command_digest_mismatch', 'digest changed', 409),
    )
    const mismatch = await createController().sync(
      request(logicalBody, {
        'x-sync-command-id': 'command-1',
        'x-sync-command-digest': digest,
      }),
      response(),
    )
    executeSyncCommand.execute.mockRejectedValueOnce(
      new SyncCommandProtocolError('sync_command_pending', 'still processing', 409),
    )
    const pending = await createController().sync(
      request(logicalBody, {
        'x-sync-command-id': 'command-2',
        'x-sync-command-digest': digest,
      }),
      response(),
    )

    expect((mismatch as results.JsonResult).json).toEqual({
      error: { code: 'sync_command_digest_mismatch', message: 'digest changed', retryable: false },
    })
    expect((pending as results.JsonResult).json).toEqual({
      error: { code: 'sync_command_pending', message: 'still processing', retryable: true },
    })
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '1')
  })

  it('returns scope-safe status through the dedicated route use case', async () => {
    getSyncCommandStatus.execute.mockResolvedValue({ command: { id: 'command-1', status: 'unknown' } })
    const statusRequest = request({}, { 'x-sync-command-digest': 'a'.repeat(64) })
    statusRequest.params.commandId = 'command-1'

    const result = await createController().getSyncCommandStatus(statusRequest, response())

    expect(getSyncCommandStatus.execute).toHaveBeenCalledWith({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: 'command-1',
      requestDigest: 'a'.repeat(64),
    })
    expect((result as results.JsonResult).json).toEqual({ command: { id: 'command-1', status: 'unknown' } })
  })
})
