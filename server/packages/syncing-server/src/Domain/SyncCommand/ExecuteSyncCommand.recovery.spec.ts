import { DataSource, EntityManager } from 'typeorm'

import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { ExecuteSyncCommand } from './ExecuteSyncCommand'
import { StoredSyncCommand, SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import { computeSyncCommandDigest } from './SyncCommandTypes'

const passthroughTransactions = {
  async transaction<T>(callback: (manager: EntityManager) => Promise<T>): Promise<T> {
    return callback({} as EntityManager)
  },
} as unknown as DataSource

const canonicalPayload = { api: '20200115', items: [] }
const digest = computeSyncCommandDigest(canonicalPayload)

const storedCommand = (overrides: Partial<StoredSyncCommand> = {}): StoredSyncCommand => ({
  uuid: 'command-uuid',
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  commandId: 'command-1',
  requestDigest: digest,
  status: 'accepted',
  responseJson: null,
  expiresAtTimestamp: 1,
  ...overrides,
})

const createRepository = (): jest.Mocked<SyncCommandRepositoryInterface> => ({
  insertAcceptedIfAbsent: jest.fn().mockResolvedValue(undefined),
  find: jest.fn().mockResolvedValue(storedCommand()),
  claimAccepted: jest.fn().mockResolvedValue(true),
  commit: jest.fn().mockResolvedValue(undefined),
  deleteExpired: jest.fn().mockResolvedValue(0),
})

const createUseCase = (repository: SyncCommandRepositoryInterface, dispatcher = { wake: jest.fn() }) =>
  new ExecuteSyncCommand(
    passthroughTransactions,
    new SyncCommandTransactionContext(),
    repository,
    dispatcher as never,
    60_000,
  )

const baseDto = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  metadata: { id: 'command-1', digest },
  canonicalPayload,
}

describe('ExecuteSyncCommand digest source', () => {
  it('trusts a pre-computed canonical digest over re-hashing the payload', async () => {
    const repository = createRepository()
    const execute = jest.fn().mockResolvedValue({ sync_token: 'ok' })

    // The payload here would hash to something else entirely; callers that
    // already canonicalised upstream must not be re-canonicalised differently.
    const result = await createUseCase(repository).execute({
      ...baseDto,
      canonicalPayload: { something: 'that hashes differently' },
      canonicalDigest: digest,
      execute,
    })

    expect(result.replayed).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refuses a pre-computed digest that disagrees with what the client presented', async () => {
    const repository = createRepository()
    const execute = jest.fn()

    await expect(
      createUseCase(repository).execute({
        ...baseDto,
        canonicalDigest: computeSyncCommandDigest({ items: [{ uuid: 'other' }] }),
        execute,
      }),
    ).rejects.toMatchObject({ code: 'sync_command_digest_mismatch', httpStatus: 409 })

    expect(execute).not.toHaveBeenCalled()
    expect(repository.insertAcceptedIfAbsent).not.toHaveBeenCalled()
  })
})

/**
 * A command is claimed for execution by exactly one request. Everything here is
 * what the request that LOST that claim sees, which is the case duplicate
 * submissions actually hit in production.
 */
describe('ExecuteSyncCommand losing the execution claim', () => {
  it('replays the winner’s stored response instead of executing again', async () => {
    const repository = createRepository()
    const committed = storedCommand({
      status: 'committed',
      responseJson: JSON.stringify({
        sync_token: 'winner',
        command: { id: 'command-1', digest, status: 'committed' },
      }),
    })
    repository.find
      .mockResolvedValueOnce(storedCommand())
      .mockResolvedValueOnce(storedCommand())
      .mockResolvedValue(committed)
    repository.claimAccepted.mockResolvedValue(false)
    const execute = jest.fn()
    const dispatcher = { wake: jest.fn() }

    const result = await createUseCase(repository, dispatcher).execute({ ...baseDto, execute })

    expect(result.replayed).toBe(true)
    expect(result.response).toMatchObject({ sync_token: 'winner' })
    // The mutation belongs to the winner; running it again would double-apply it.
    expect(execute).not.toHaveBeenCalled()
    expect(repository.commit).not.toHaveBeenCalled()
    // Nothing new was committed, so there is nothing for the dispatcher to send.
    expect(dispatcher.wake).not.toHaveBeenCalled()
  })

  it('reports the command as still in progress when the winner has not committed yet', async () => {
    const repository = createRepository()
    repository.claimAccepted.mockResolvedValue(false)
    const execute = jest.fn()

    // 409 rather than an error: the client should retry, not treat this as failure.
    await expect(createUseCase(repository).execute({ ...baseDto, execute })).rejects.toMatchObject({
      code: 'sync_command_pending',
      httpStatus: 409,
    })

    expect(execute).not.toHaveBeenCalled()
  })

  it('reports still-in-progress when the winner committed without a stored response', async () => {
    const repository = createRepository()
    repository.claimAccepted.mockResolvedValue(false)
    repository.find
      .mockResolvedValueOnce(storedCommand())
      .mockResolvedValueOnce(storedCommand())
      .mockResolvedValue(storedCommand({ status: 'committed', responseJson: null }))

    await expect(createUseCase(repository).execute({ ...baseDto, execute: jest.fn() })).rejects.toMatchObject({
      code: 'sync_command_pending',
    })
  })
})

/**
 * Storage-level invariants. None of these should ever happen, which is exactly
 * why they must fail loudly: continuing past a dropped row would execute a
 * mutation whose idempotency record does not exist.
 */
describe('ExecuteSyncCommand storage invariants', () => {
  it('refuses to proceed when the acceptance row cannot be read back', async () => {
    const repository = createRepository()
    repository.find.mockResolvedValue(null)

    await expect(createUseCase(repository).execute({ ...baseDto, execute: jest.fn() })).rejects.toThrow(
      'Sync command acceptance was not persisted.',
    )
  })

  it('refuses to proceed when the accepted command vanishes before execution', async () => {
    const repository = createRepository()
    repository.find.mockResolvedValueOnce(storedCommand()).mockResolvedValue(null)
    const execute = jest.fn()

    await expect(createUseCase(repository).execute({ ...baseDto, execute })).rejects.toThrow(
      'Accepted sync command disappeared before execution.',
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses to replay a committed command that has no stored response', async () => {
    const repository = createRepository()
    repository.find
      .mockResolvedValueOnce(storedCommand())
      .mockResolvedValue(storedCommand({ status: 'committed', responseJson: null }))

    await expect(createUseCase(repository).execute({ ...baseDto, execute: jest.fn() })).rejects.toThrow(
      'Committed sync command is missing its replay result.',
    )
  })

  it('refuses a command id that was accepted under a different digest', async () => {
    const repository = createRepository()
    repository.find.mockResolvedValue(storedCommand({ requestDigest: computeSyncCommandDigest({ other: true }) }))

    await expect(createUseCase(repository).execute({ ...baseDto, execute: jest.fn() })).rejects.toMatchObject({
      code: 'sync_command_digest_mismatch',
      httpStatus: 409,
    })
  })
})
