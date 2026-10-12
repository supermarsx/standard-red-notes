import { EntityManager } from 'typeorm'

import { SyncCommandTransactionAbortedError } from '../../Domain/SyncCommand/SyncCommandTypes'
import { abortsDatabaseTransaction, SyncCommandTransactionContext } from './SyncCommandTransactionContext'

/** What TypeORM hands back when the driver refuses a statement. */
const queryFailed = (driverError: Record<string, unknown>): Error =>
  Object.assign(new Error(String(driverError.message ?? 'query failed')), { name: 'QueryFailedError', driverError })

const recordChanged = () =>
  queryFailed({
    errno: 1020,
    code: 'ER_CHECKREAD',
    message: "Record has changed since last read in table 'items'; try restarting transaction",
  })

/**
 * A transaction whose database rolls it back on one named statement, exactly as MariaDB does:
 * that statement fails, and anything sent afterwards would run on its own, outside it.
 */
function transactionThatAbortsOn(statement: string, failure: () => Error = recordChanged) {
  const sent: string[] = []
  const queryRunner = {
    query: jest.fn(async (sql: string) => {
      sent.push(sql)
      if (sql === statement) {
        throw failure()
      }
      return [{ ok: true }]
    }),
  }
  const original = queryRunner.query
  return { manager: { queryRunner } as unknown as EntityManager, queryRunner, original, sent }
}

describe('SyncCommandTransactionContext', () => {
  it('sends nothing more once the database has rolled the transaction back', async () => {
    const context = new SyncCommandTransactionContext()
    const { manager, queryRunner, original, sent } = transactionThatAbortsOn('UPDATE items')

    await expect(
      context.run(manager, async () => {
        await queryRunner.query('UPDATE sync_commands SET execution_token')
        // Saving one item is allowed to fail, and the code that saves items carries on.
        await expect(queryRunner.query('UPDATE items')).rejects.toMatchObject({ driverError: { errno: 1020 } })

        // Everything from here would have been committed on its own, outside the command.
        await expect(queryRunner.query('UPDATE items SET second')).rejects.toBeInstanceOf(
          SyncCommandTransactionAbortedError,
        )
        await expect(queryRunner.query('INSERT INTO sync_command_outbox')).rejects.toBeInstanceOf(
          SyncCommandTransactionAbortedError,
        )

        // Storing the command's result is refused too, which is what ends the attempt.
        await queryRunner.query('UPDATE sync_commands SET status')
      }),
    ).rejects.toBeInstanceOf(SyncCommandTransactionAbortedError)

    expect(sent).toEqual(['UPDATE sync_commands SET execution_token', 'UPDATE items'])
    // The guard comes off: TypeORM still has to send ROLLBACK, and some drivers reuse the runner.
    expect(queryRunner.query).toBe(original)
    await expect(queryRunner.query('ROLLBACK')).resolves.toEqual([{ ok: true }])
    expect(context.manager).toBeUndefined()
  })

  it('names the database error that ended the transaction', async () => {
    const context = new SyncCommandTransactionContext()
    const { manager, queryRunner } = transactionThatAbortsOn('UPDATE items')

    const failure = await context
      .run(manager, async () => {
        await queryRunner.query('UPDATE items').catch(() => undefined)
        await queryRunner.query('UPDATE sync_commands SET status')
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SyncCommandTransactionAbortedError)
    expect((failure as SyncCommandTransactionAbortedError).cause).toMatchObject({ driverError: { errno: 1020 } })
  })

  it('carries on after a statement that failed without costing the transaction', async () => {
    const context = new SyncCommandTransactionContext()
    const { manager, queryRunner, sent } = transactionThatAbortsOn('INSERT duplicate', () =>
      queryFailed({ errno: 1062, code: 'ER_DUP_ENTRY', message: 'Duplicate entry' }),
    )

    await context.run(manager, async () => {
      await expect(queryRunner.query('INSERT duplicate')).rejects.toMatchObject({ driverError: { errno: 1062 } })
      await queryRunner.query('UPDATE items')
    })

    expect(sent).toEqual(['INSERT duplicate', 'UPDATE items'])
  })

  it('keeps two concurrent transactions apart', async () => {
    const context = new SyncCommandTransactionContext()
    const doomed = transactionThatAbortsOn('UPDATE items')
    const healthy = transactionThatAbortsOn('never sent')
    let releaseHealthy!: () => void
    const healthyMayFinish = new Promise<void>((resolve) => (releaseHealthy = resolve))

    const healthyRun = context.run(healthy.manager, async () => {
      await healthyMayFinish
      await healthy.queryRunner.query('UPDATE items')
      return 'committed'
    })
    await expect(
      context.run(doomed.manager, async () => {
        await doomed.queryRunner.query('UPDATE items').catch(() => undefined)
        await doomed.queryRunner.query('UPDATE sync_commands SET status')
      }),
    ).rejects.toBeInstanceOf(SyncCommandTransactionAbortedError)
    releaseHealthy()

    await expect(healthyRun).resolves.toBe('committed')
    expect(healthy.sent).toEqual(['UPDATE items'])
  })

  it('runs unguarded when the manager has no query runner of its own', async () => {
    const context = new SyncCommandTransactionContext()

    await expect(
      context.run({} as EntityManager, async () => {
        return context.manager !== undefined
      }),
    ).resolves.toBe(true)
  })
})

describe('abortsDatabaseTransaction', () => {
  // Number and name are pinned apart: a driver is not obliged to supply both.
  it.each([
    ['MariaDB record changed since last read, by number', { errno: 1020 }],
    ['MariaDB record changed since last read, by name', { code: 'ER_CHECKREAD' }],
    ['a deadlock, by number', { errno: 1213 }],
    ['a deadlock, by name', { code: 'ER_LOCK_DEADLOCK' }],
    ['a lock wait timeout, by number', { errno: 1205 }],
    ['a lock wait timeout, by name', { code: 'ER_LOCK_WAIT_TIMEOUT' }],
    ['a busy SQLite database', { code: 'SQLITE_BUSY' }],
    ['a stale SQLite snapshot', { code: 'SQLITE_BUSY_SNAPSHOT' }],
    ['a locked SQLite table', { code: 'SQLITE_LOCKED' }],
  ])('recognises %s, wrapped by TypeORM or bare', (_name, driverError) => {
    expect(abortsDatabaseTransaction(queryFailed(driverError))).toBe(true)
    expect(abortsDatabaseTransaction(driverError)).toBe(true)
  })

  it.each([
    ['a duplicate key', queryFailed({ errno: 1062, code: 'ER_DUP_ENTRY' })],
    ['a constraint failure', queryFailed({ code: 'SQLITE_CONSTRAINT' })],
    ['an ordinary error', new Error('simulated process failure')],
    ['nothing', undefined],
    ['a string', 'ER_CHECKREAD'],
  ])('does not mistake %s for one', (_name, error) => {
    expect(abortsDatabaseTransaction(error)).toBe(false)
  })
})
