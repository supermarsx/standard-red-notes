import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  runSharedSqliteTransaction,
  sharedSqliteTransactionQueueStatsForTesting,
} from './SharedSqliteTransactionCoordinator'

const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>((done) => {
    release = done
  })
  return { promise, release }
}

describe('Shared SQLite transaction coordination', () => {
  it('serializes separate services using relative, absolute and file URL names for the same database', async () => {
    const firstEntered = deferred()
    const firstGate = deferred()
    let secondEntered = false
    let thirdEntered = false
    const filename = 'shared-auth-sync-test.sqlite'
    const first = runSharedSqliteTransaction({}, filename, async () => {
      firstEntered.release()
      await firstGate.promise
      return 'auth'
    })
    await firstEntered.promise
    const second = runSharedSqliteTransaction({}, resolve(filename), async () => {
      secondEntered = true
      return 'sync'
    })
    const third = runSharedSqliteTransaction({}, pathToFileURL(resolve(filename)).href, async () => {
      thirdEntered = true
      return 'other'
    })
    await Promise.resolve()
    expect(secondEntered).toBe(false)
    expect(thirdEntered).toBe(false)
    expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 1, sqliteFileQueueCount: 1 })
    firstGate.release()
    expect(await Promise.all([first, second, third])).toEqual(['auth', 'sync', 'other'])
    expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 0, sqliteFileQueueCount: 0 })
  })

  it('allows independent in-memory sources and separate files to transact concurrently', async () => {
    const gate = deferred()
    const started = [deferred(), deferred(), deferred(), deferred()]
    const transactions = [':memory:', ':memory:', 'one.sqlite', 'two.sqlite'].map((database, index) =>
      runSharedSqliteTransaction({}, database, async () => {
        started[index].release()
        await gate.promise
        return index
      }),
    )
    await Promise.all(started.map((signal) => signal.promise))
    expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 4, sqliteFileQueueCount: 2 })
    gate.release()
    expect(await Promise.all(transactions)).toEqual([0, 1, 2, 3])
    expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 0, sqliteFileQueueCount: 0 })
  })

  it('releases queues after a rollback so another service can continue', async () => {
    const failed = runSharedSqliteTransaction({}, 'rollback.sqlite', async () => {
      throw new Error('rollback')
    })
    const next = runSharedSqliteTransaction({}, 'rollback.sqlite', async () => 'recovered')
    await expect(failed).rejects.toThrow('rollback')
    await expect(next).resolves.toBe('recovered')
    expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 0, sqliteFileQueueCount: 0 })
  })
})
