import { AppDataSource } from './DataSource'
import { Env } from './Env'

describe('AppDataSource', () => {
  afterEach(async () => {
    jest.restoreAllMocks()
  })

  it('returns the same, already-connected data source instance on repeated access after initialize()', async () => {
    // Mirrors exactly how Container.ts wires the container: it calls `initialize()`
    // once (Container.ts:613-614), then later reads the `.dataSource` getter directly
    // (not the private, already-connected field) three separate times to construct
    // AuthInviteMutationTransactionRunner (line ~1098), TypeORMEmailBackupStateRepository
    // (line ~1763) and TypeORMNextcloudBackupStateRepository (line ~3044). All reads must
    // observe the same connected instance, or those consumers silently receive a fresh,
    // never-connected one.
    const env = new Env({ DB_TYPE: 'sqlite', DB_SQLITE_DATABASE_PATH: ':memory:' })
    const appDataSource = new AppDataSource({ env, runMigrations: false })

    await appDataSource.initialize()

    const first = appDataSource.dataSource
    const second = appDataSource.dataSource
    const third = appDataSource.dataSource

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(third.isInitialized).toBe(true)

    await first.destroy()
  })

  it('executes a durable-mutation-style transaction against the data source handed to AuthInviteMutationTransactionRunner-style consumers, on the SQLite driver', async () => {
    // This is the exact reproduction of the syncing-server production bug, applied to
    // auth's own copy of AppDataSource: a fresh AppDataSource is initialized (as
    // Container.ts does at startup), then `.dataSource` is read again (as Container.ts
    // does when constructing AuthInviteMutationTransactionRunner / TypeORMEmailBackupStateRepository
    // / TypeORMNextcloudBackupStateRepository) and a transaction is opened on the value
    // obtained from that second read - the same call shape as
    // AuthInviteMutationTransactionRunner's transactional invite-mutation path.
    //
    // Without the cached early-return in the `dataSource` getter, this would reject with
    //   TypeError: Cannot read properties of undefined (reading 'prepare')
    // thrown inside TypeORM's BetterSqlite3QueryRunner, because the second `.dataSource`
    // read would silently return a brand-new DataSource whose better-sqlite3 driver never
    // connected (no `databaseConnection`) - it was never the instance `initialize()` ran.
    const env = new Env({ DB_TYPE: 'sqlite', DB_SQLITE_DATABASE_PATH: ':memory:' })
    const appDataSource = new AppDataSource({ env, runMigrations: false })

    await appDataSource.initialize()

    const dataSourceForDurableMutations = appDataSource.dataSource

    await expect(dataSourceForDurableMutations.transaction(async () => 'committed')).resolves.toBe('committed')

    await dataSourceForDurableMutations.destroy()
  })
})
