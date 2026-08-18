import { Repository } from 'typeorm'

import { GetSyncCommandStatus } from '../../Domain/SyncCommand/GetSyncCommandStatus'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { TypeORMSyncCommand } from './TypeORMSyncCommand'
import { TypeORMSyncCommandOutbox } from './TypeORMSyncCommandOutbox'
import { TypeORMSyncCommandOutboxRepository } from './TypeORMSyncCommandOutboxRepository'
import { TypeORMSyncCommandRepository } from './TypeORMSyncCommandRepository'

type OutboxUpdateValues = {
  status?: TypeORMSyncCommandOutbox['status']
  lockToken?: string | null
  lockedAtTimestamp?: number | null
  updatedAtTimestamp?: number
}

type FakeQueryRunner = {
  connect: jest.Mock
  release: jest.Mock
  manager: { getRepository: jest.Mock }
}

const makeOutboxRow = (): TypeORMSyncCommandOutbox => ({
  uuid: 'outbox-1',
  eventJson: JSON.stringify({
    type: 'SYNC_COMMAND_REPLICATION_TEST',
    eventId: 'event-1',
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    meta: {},
  }),
  status: 'pending',
  attempts: 0,
  availableAtTimestamp: 90,
  lockedAtTimestamp: null,
  lockToken: null,
  createdAtTimestamp: 80,
  updatedAtTimestamp: 80,
  publishedAtTimestamp: null,
})

const createOutboxReplicationHarness = (options?: {
  synchronizeFirstTwoSelections?: boolean
  failSelection?: boolean
}) => {
  const nowTimestamp = 100
  const staleBeforeTimestamp = 50
  const masterRows = new Map<string, TypeORMSyncCommandOutbox>([['outbox-1', makeOutboxRow()]])
  const replicaRows = new Map<string, TypeORMSyncCommandOutbox>()

  let selectionCount = 0
  let releaseSelectionBarrier: (() => void) | undefined
  const selectionBarrier = new Promise<void>((resolve) => {
    releaseSelectionBarrier = resolve
  })

  const eligible = (row: TypeORMSyncCommandOutbox): boolean =>
    (row.status === 'pending' && row.availableAtTimestamp <= nowTimestamp) ||
    (row.status === 'dispatching' && row.lockedAtTimestamp !== null && row.lockedAtTimestamp < staleBeforeTimestamp)

  const createSelectBuilder = () => {
    const builder: Record<string, jest.Mock> = {}
    builder.where = jest.fn(() => builder)
    builder.orderBy = jest.fn(() => builder)
    builder.getOne = jest.fn(async () => {
      if (options?.failSelection) {
        throw new Error('simulated master selection failure')
      }

      selectionCount++
      if (options?.synchronizeFirstTwoSelections && selectionCount <= 2) {
        if (selectionCount === 2) {
          releaseSelectionBarrier?.()
        }
        await selectionBarrier
      }

      const candidate = [...masterRows.values()]
        .filter(eligible)
        .sort((left, right) => left.createdAtTimestamp - right.createdAtTimestamp)[0]

      return candidate ? { ...candidate } : null
    })

    return builder
  }

  const createUpdateBuilder = () => {
    const builder: Record<string, jest.Mock> = {}
    let uuid = ''
    let updateValues: OutboxUpdateValues = {}

    builder.update = jest.fn(() => builder)
    builder.set = jest.fn((values: OutboxUpdateValues) => {
      updateValues = values
      return builder
    })
    builder.where = jest.fn((_query: string, parameters: { uuid: string }) => {
      uuid = parameters.uuid
      return builder
    })
    builder.andWhere = jest.fn(() => builder)
    builder.execute = jest.fn(async () => {
      const row = masterRows.get(uuid)
      if (!row || !eligible(row)) {
        return { affected: 0 }
      }

      masterRows.set(uuid, {
        ...row,
        ...updateValues,
        attempts: row.attempts + 1,
      })

      return { affected: 1 }
    })

    return builder
  }

  const masterRepository = {
    createQueryBuilder: jest.fn((alias?: string) => {
      return alias === 'outbox' ? createSelectBuilder() : createUpdateBuilder()
    }),
    findOne: jest.fn(async (query: { where: { uuid: string; lockToken: string } }) => {
      const row = masterRows.get(query.where.uuid)
      return row?.lockToken === query.where.lockToken ? { ...row } : null
    }),
  }

  const runners: FakeQueryRunner[] = []
  const createQueryRunner = jest.fn((_mode: 'master') => {
    const runner: FakeQueryRunner = {
      connect: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      manager: { getRepository: jest.fn(() => masterRepository) },
    }
    runners.push(runner)
    return runner
  })

  const replicaRepository = {
    manager: { dataSource: { createQueryRunner } },
    createQueryBuilder: jest.fn(() => {
      throw new Error('stale replica must not participate in an outbox claim')
    }),
    findOne: jest.fn(async (query: { where: { uuid: string; lockToken: string } }) => {
      const row = replicaRows.get(query.where.uuid)
      return row?.lockToken === query.where.lockToken ? { ...row } : null
    }),
  } as unknown as Repository<TypeORMSyncCommandOutbox>

  return {
    repository: new TypeORMSyncCommandOutboxRepository(replicaRepository, new SyncCommandTransactionContext()),
    masterRows,
    replicaRepository,
    createQueryRunner,
    runners,
    nowTimestamp,
    staleBeforeTimestamp,
  }
}

describe('TypeORM sync command replication consistency', () => {
  // This fake deliberately gives reads on the default repository a stale replica
  // while the explicit master QueryRunner sees current state. A live replicated
  // MySQL topology remains an environment-level integration gate.
  it('claims and returns a master row despite a stale replica, then releases the runner', async () => {
    const harness = createOutboxReplicationHarness()

    const claimed = await harness.repository.claimNext(harness.nowTimestamp, harness.staleBeforeTimestamp, 'claim-1')

    expect(claimed).toMatchObject({ uuid: 'outbox-1', lockToken: 'claim-1' })
    expect(claimed?.event.createdAt).toEqual(new Date('2026-08-18T00:00:00.000Z'))
    expect(harness.createQueryRunner).toHaveBeenCalledWith('master')
    expect(harness.replicaRepository.createQueryBuilder).not.toHaveBeenCalled()
    expect(harness.runners).toHaveLength(1)
    expect(harness.runners[0].connect).toHaveBeenCalledTimes(1)
    expect(harness.runners[0].manager.getRepository).toHaveBeenCalledWith(TypeORMSyncCommandOutbox)
    expect(harness.runners[0].release).toHaveBeenCalledTimes(1)
  })

  it('keeps competing master claims exclusive when both select the same candidate', async () => {
    const harness = createOutboxReplicationHarness({ synchronizeFirstTwoSelections: true })

    const claims = await Promise.all([
      harness.repository.claimNext(harness.nowTimestamp, harness.staleBeforeTimestamp, 'claim-1'),
      harness.repository.claimNext(harness.nowTimestamp, harness.staleBeforeTimestamp, 'claim-2'),
    ])

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
    expect(new Set(claims.flatMap((claim) => (claim ? [claim.lockToken] : [])))).toEqual(
      new Set([harness.masterRows.get('outbox-1')?.lockToken]),
    )
    expect(harness.runners).toHaveLength(2)
    expect(harness.runners.every((runner) => runner.release.mock.calls.length === 1)).toBe(true)
  })

  it('releases the master runner when claiming fails', async () => {
    const harness = createOutboxReplicationHarness({ failSelection: true })

    await expect(
      harness.repository.claimNext(harness.nowTimestamp, harness.staleBeforeTimestamp, 'claim-1'),
    ).rejects.toThrow('simulated master selection failure')

    expect(harness.runners).toHaveLength(1)
    expect(harness.runners[0].connect).toHaveBeenCalledTimes(1)
    expect(harness.runners[0].release).toHaveBeenCalledTimes(1)
  })

  it('serves STATUS from master-committed state instead of a stale replica', async () => {
    const digest = 'a'.repeat(64)
    const staleReplicaCommand: TypeORMSyncCommand = {
      uuid: 'command-1',
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: 'command-1',
      requestDigest: digest,
      status: 'accepted',
      responseJson: null,
      executionToken: null,
      createdAtTimestamp: 1,
      updatedAtTimestamp: 1,
      expiresAtTimestamp: Date.now() + 60_000,
    }
    const masterCommand: TypeORMSyncCommand = {
      ...staleReplicaCommand,
      status: 'committed',
      responseJson: JSON.stringify({ saved_items: [{ uuid: 'note-1' }] }),
      updatedAtTimestamp: 2,
    }
    const masterRepository = { findOne: jest.fn(async () => masterCommand) }
    const runner: FakeQueryRunner = {
      connect: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      manager: { getRepository: jest.fn(() => masterRepository) },
    }
    const createQueryRunner = jest.fn((_mode: 'master') => runner)
    const replicaRepository = {
      manager: { dataSource: { createQueryRunner } },
      findOne: jest.fn(async () => staleReplicaCommand),
    } as unknown as Repository<TypeORMSyncCommand>
    const repository = new TypeORMSyncCommandRepository(replicaRepository, new SyncCommandTransactionContext())
    const getStatus = new GetSyncCommandStatus(repository)

    const result = await getStatus.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: 'command-1',
      requestDigest: digest,
    })

    expect(result).toEqual({
      command: { id: 'command-1', digest, status: 'committed' },
      result: { saved_items: [{ uuid: 'note-1' }] },
    })
    expect(createQueryRunner).toHaveBeenCalledWith('master')
    expect(replicaRepository.findOne).not.toHaveBeenCalled()
    expect(runner.manager.getRepository).toHaveBeenCalledWith(TypeORMSyncCommand)
    expect(runner.release).toHaveBeenCalledTimes(1)
  })
})
