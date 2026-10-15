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

it('serializes normalized shared memory URIs without conflating independent named memory databases', async () => {
  const firstEntered = deferred(),
    gate = deferred()
  let sameEntered = false,
    otherEntered = false
  const first = runSharedSqliteTransaction({}, 'file:shared-memory?cache=shared&mode=memory', async () => {
    firstEntered.release()
    await gate.promise
    return 'first'
  })
  await firstEntered.promise
  const same = runSharedSqliteTransaction({}, 'file:shared-memory?mode=memory&cache=shared', async () => {
    sameEntered = true
    return 'same'
  })
  const other = runSharedSqliteTransaction({}, 'file:other-memory?mode=memory&cache=shared', async () => {
    otherEntered = true
    return 'other'
  })
  await other
  expect(sameEntered).toBe(false)
  expect(otherEntered).toBe(true)
  gate.release()
  expect(await Promise.all([first, same])).toEqual(['first', 'same'])
  expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 0, sqliteFileQueueCount: 0 })
})

it('normalizes percent-encoded file URIs and the explicit memory URI form', async () => {
  const started = deferred(),
    gate = deferred()
  let sameEntered = false
  const first = runSharedSqliteTransaction({}, 'file:encoded%20shared.sqlite', async () => {
    started.release()
    await gate.promise
  })
  await started.promise
  const second = runSharedSqliteTransaction({}, resolve('encoded shared.sqlite'), async () => {
    sameEntered = true
  })
  await Promise.resolve()
  expect(sameEntered).toBe(false)
  gate.release()
  await Promise.all([first, second])
  await expect(runSharedSqliteTransaction({}, 'file::memory:?cache=shared', async () => 'memory')).resolves.toBe(
    'memory',
  )
  expect(sharedSqliteTransactionQueueStatsForTesting()).toEqual({ activeQueueKeyCount: 0, sqliteFileQueueCount: 0 })
})
