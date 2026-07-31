import { DataSource, EntityManager } from 'typeorm'

import {
  authTypeORMTransactionQueueStatsForTesting,
  runAuthTypeORMTransaction,
} from './AuthTypeORMTransactionCoordinator'

describe('AuthTypeORMTransactionCoordinator', () => {
  const fakeSqliteDataSource = (
    database: string,
    onTransaction: (transaction: (manager: EntityManager) => Promise<string>) => Promise<string>,
  ) =>
    ({
      options: { type: 'better-sqlite3', database },
      transaction: onTransaction,
    }) as unknown as DataSource

  it('does not globally serialize independent SQLite database files', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let enterFirst!: () => void
    let enterSecond!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve))
    const firstEntered = new Promise<void>((resolve) => (enterFirst = resolve))
    const secondEntered = new Promise<void>((resolve) => (enterSecond = resolve))
    const first = fakeSqliteDataSource('first.sqlite', async (transaction) => {
      enterFirst()
      await firstGate
      return transaction({} as EntityManager)
    })
    const second = fakeSqliteDataSource('second.sqlite', async (transaction) => {
      enterSecond()
      await secondGate
      return transaction({} as EntityManager)
    })

    const firstResult = runAuthTypeORMTransaction(first, async () => 'first')
    const secondResult = runAuthTypeORMTransaction(second, async () => 'second')
    await Promise.all([firstEntered, secondEntered])
    expect(authTypeORMTransactionQueueStatsForTesting()).toEqual({
      activeQueueKeyCount: 2,
      sqliteFileQueueCount: 2,
    })

    releaseFirst()
    releaseSecond()
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(['first', 'second'])
    expect(authTypeORMTransactionQueueStatsForTesting()).toEqual({
      activeQueueKeyCount: 0,
      sqliteFileQueueCount: 0,
    })
  })

  it('cleans an in-memory DataSource queue after a transaction rejection', async () => {
    const dataSource = fakeSqliteDataSource(':memory:', async () => {
      throw new Error('forced rollback')
    })

    await expect(runAuthTypeORMTransaction(dataSource, async () => 'unreachable')).rejects.toThrow('forced rollback')
    expect(authTypeORMTransactionQueueStatsForTesting()).toEqual({
      activeQueueKeyCount: 0,
      sqliteFileQueueCount: 0,
    })
  })
})
