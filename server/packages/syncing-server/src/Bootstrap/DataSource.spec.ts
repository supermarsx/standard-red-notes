import { AppDataSource } from './DataSource'
import { Env } from './Env'

describe('AppDataSource', () => {
  afterEach(async () => {
    jest.restoreAllMocks()
  })

  it('returns the same, already-connected data source instance on repeated access after initialize()', async () => {
    // Mirrors exactly how Container.ts wires the container: it calls `initialize()`
    // once, then later reads the `.dataSource` getter directly (not the private,
    // already-connected field) to construct ExecuteSyncCommand and
    // InviteMutationTransactionRunner. Both reads must observe the same connected
    // instance, or those consumers silently receive a fresh, never-connected one.
    const env = new Env({ DB_TYPE: 'sqlite', DB_SQLITE_DATABASE_PATH: ':memory:' })
    const appDataSource = new AppDataSource({ env, runMigrations: false })

    await appDataSource.initialize()

    const first = appDataSource.dataSource
    const second = appDataSource.dataSource

    expect(second).toBe(first)
    expect(second.isInitialized).toBe(true)

    await first.destroy()
  })

  it('executes a durable-command-style transaction against the data source handed to ExecuteSyncCommand-style consumers, on the SQLite driver', async () => {
    // This is the exact reproduction of the production bug: a fresh AppDataSource is
    // initialized (as Container.ts does at startup), then `.dataSource` is read again
    // (as Container.ts does when constructing ExecuteSyncCommand / InviteMutationTransactionRunner)
    // and a transaction is opened on the value obtained from that second read - the same shape
    // as `ExecuteSyncCommand.execute()`'s `this.dataSource.transaction(...)` call.
    //
    // Before the fix: this rejects with
    //   TypeError: Cannot read properties of undefined (reading 'prepare')
    // thrown inside TypeORM's BetterSqlite3QueryRunner, because the second `.dataSource`
    // read silently returned a brand-new DataSource whose better-sqlite3 driver never
    // connected (no `databaseConnection`) - it was never the instance `initialize()` ran.
    const env = new Env({ DB_TYPE: 'sqlite', DB_SQLITE_DATABASE_PATH: ':memory:' })
    const appDataSource = new AppDataSource({ env, runMigrations: false })

    await appDataSource.initialize()

    const dataSourceForDurableCommands = appDataSource.dataSource

    await expect(dataSourceForDurableCommands.transaction(async () => 'committed')).resolves.toBe('committed')

    await dataSourceForDurableCommands.destroy()
  })
})
