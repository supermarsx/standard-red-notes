import { DataSource, EntityManager } from 'typeorm'

import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { ExecuteSyncCommand, MAX_SYNC_COMMAND_EXECUTION_ATTEMPTS } from './ExecuteSyncCommand'
import { StoredSyncCommand, SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import {
  computeSyncCommandDigest,
  SyncCommandClaimLostError,
  SyncCommandTransactionAbortedError,
} from './SyncCommandTypes'

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
  deleteAcceptedIfUnclaimed: jest.fn().mockResolvedValue(true),
  deleteExpired: jest.fn().mockResolvedValue(0),
})

const createUseCase = (
  repository: SyncCommandRepositoryInterface,
  dispatcher = { wake: jest.fn() },
  dataSource: DataSource = passthroughTransactions,
) => new ExecuteSyncCommand(dataSource, new SyncCommandTransactionContext(), repository, dispatcher as never, 60_000)

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

/** What TypeORM throws when MariaDB refuses a write over a row changed since it was read. */
const recordChangedSinceLastRead = () =>
  Object.assign(new Error("Record has changed since last read in table 'items'; try restarting transaction"), {
    name: 'QueryFailedError',
    driverError: { errno: 1020, code: 'ER_CHECKREAD' },
  })

/**
 * Two people saving the same shared note is all it takes for the database to abort one of
 * the two commands. That is not a failure of the command: nothing it did was kept, so it is
 * run again, and the second run reads the row the other save left.
 */
describe('ExecuteSyncCommand when the database aborts the execution', () => {
  it.each([
    ['the database error itself', () => recordChangedSinceLastRead()],
    ['a transaction the guard found dead', () => new SyncCommandTransactionAbortedError(recordChangedSinceLastRead())],
    ['a claim that was rolled back under the commit', () => new SyncCommandClaimLostError()],
  ])('runs the execution again after %s, and commits once', async (_name, failure) => {
    const repository = createRepository()
    const execute = jest.fn().mockRejectedValueOnce(failure()).mockResolvedValue({ sync_token: 'second-attempt' })
    const beforeExecute = jest.fn().mockResolvedValue(undefined)
    const dispatcher = { wake: jest.fn() }

    const result = await createUseCase(repository, dispatcher).execute({ ...baseDto, beforeExecute, execute })

    expect(result.replayed).toBe(false)
    expect(result.response).toMatchObject({ sync_token: 'second-attempt', command: { status: 'committed' } })
    expect(execute).toHaveBeenCalledTimes(2)
    // The admission check counts a request, and a retry is the same request.
    expect(beforeExecute).toHaveBeenCalledTimes(1)
    expect(repository.commit).toHaveBeenCalledTimes(1)
    expect(dispatcher.wake).toHaveBeenCalledTimes(1)
    // The command is still this request's to finish; its acceptance must not be withdrawn.
    expect(repository.deleteAcceptedIfUnclaimed).not.toHaveBeenCalled()
  })

  it('stops after a bounded number of attempts and withdraws the acceptance', async () => {
    const repository = createRepository()
    const execute = jest.fn().mockImplementation(async () => {
      throw recordChangedSinceLastRead()
    })

    await expect(createUseCase(repository).execute({ ...baseDto, execute })).rejects.toMatchObject({
      driverError: { errno: 1020 },
    })

    expect(execute).toHaveBeenCalledTimes(MAX_SYNC_COMMAND_EXECUTION_ATTEMPTS)
    expect(repository.commit).not.toHaveBeenCalled()
    expect(repository.deleteAcceptedIfUnclaimed).toHaveBeenCalledTimes(1)
    expect(repository.deleteAcceptedIfUnclaimed).toHaveBeenCalledWith('user-1', 'session-1', 'command-1')
  })
})

/**
 * The acceptance is committed before the execution, on its own. Left behind after a failed
 * execution it answers every status query `accepted`, which a client reads as "still being
 * processed" and waits on until the record expires a day later.
 */
describe('ExecuteSyncCommand when the execution fails', () => {
  it('does not run an ordinary failure again, and withdraws the acceptance', async () => {
    const repository = createRepository()
    const execute = jest.fn().mockRejectedValue(new Error('Invalid Version: 20240226'))

    await expect(createUseCase(repository).execute({ ...baseDto, execute })).rejects.toThrow(
      'Invalid Version: 20240226',
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(repository.deleteAcceptedIfUnclaimed).toHaveBeenCalledWith('user-1', 'session-1', 'command-1')
  })

  it('reports the execution failure, not a failure to withdraw the acceptance', async () => {
    const repository = createRepository()
    repository.deleteAcceptedIfUnclaimed.mockRejectedValue(new Error('database is gone'))

    await expect(
      createUseCase(repository).execute({
        ...baseDto,
        execute: jest.fn().mockRejectedValue(new Error('first failure')),
      }),
    ).rejects.toThrow('first failure')
  })

  it('leaves a command that someone else is executing exactly as it is', async () => {
    const repository = createRepository()
    repository.claimAccepted.mockResolvedValue(false)

    await expect(createUseCase(repository).execute({ ...baseDto, execute: jest.fn() })).rejects.toMatchObject({
      code: 'sync_command_pending',
    })

    expect(repository.deleteAcceptedIfUnclaimed).not.toHaveBeenCalled()
  })
})

/**
 * An item is saved by reading it and then updating it `WHERE updated_at_timestamp = <what was
 * read>`, so that a concurrent save matches nothing and comes back as a sync conflict. That
 * only works if the update sees the row as it is now.
 */
describe('ExecuteSyncCommand execution isolation', () => {
  const recordingDataSource = (type: string) => {
    const calls: unknown[][] = []
    const dataSource = {
      options: { type },
      transaction: jest.fn(async (...parameters: unknown[]) => {
        calls.push(parameters.slice(0, -1))
        return (parameters[parameters.length - 1] as (manager: EntityManager) => Promise<unknown>)({} as EntityManager)
      }),
    } as unknown as DataSource
    return { dataSource, calls }
  }

  it.each(['mysql', 'mariadb'])('executes under READ COMMITTED on %s', async (type) => {
    const { dataSource, calls } = recordingDataSource(type)

    await createUseCase(createRepository(), { wake: jest.fn() }, dataSource).execute({
      ...baseDto,
      execute: jest.fn().mockResolvedValue({ sync_token: 'ok' }),
    })

    // First the acceptance, at the default level; then the execution.
    expect(calls).toEqual([[], ['READ COMMITTED']])
  })

  it.each(['better-sqlite3', 'sqlite'])('keeps the default level on %s, which has no such level', async (type) => {
    const { dataSource, calls } = recordingDataSource(type)

    await createUseCase(createRepository(), { wake: jest.fn() }, dataSource).execute({
      ...baseDto,
      execute: jest.fn().mockResolvedValue({ sync_token: 'ok' }),
    })

    expect(calls).toEqual([[], []])
  })
})
