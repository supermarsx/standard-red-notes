import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { DataSource, MigrationInterface } from 'typeorm'

import { addVaultsUserRole1791849600000 } from '../../migrations/sqlite/1791849600000-add-vaults-user-role'
import { CANONICAL_ADMIN_ROLE_NAMES } from '../Domain/Role/CanonicalRoles'

const SQLITE_MIGRATIONS = join(__dirname, '..', '..', 'migrations', 'sqlite')
const MYSQL_MIGRATIONS = join(__dirname, '..', '..', 'migrations', 'mysql')
const VAULTS_USER_MIGRATION = '1791849600000-add-vaults-user-role.ts'

type MigrationClass = new () => MigrationInterface

/** Every migration class in a directory, in the order TypeORM runs them. */
const migrationsIn = async (directory: string, before?: string): Promise<MigrationClass[]> => {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .filter((file) => before === undefined || file < before)

  const classes: MigrationClass[] = []
  for (const file of files) {
    const exported = (await import(join(directory, file))) as Record<string, unknown>
    for (const candidate of Object.values(exported)) {
      if (typeof candidate === 'function' && typeof (candidate as MigrationClass).prototype?.up === 'function') {
        classes.push(candidate as MigrationClass)
      }
    }
  }

  return classes
}

/**
 * Standard Red Notes: the roles the admin surface PROMISES against the roles a
 * freshly migrated all-in-one database CONTAINS.
 *
 * *** WHY THIS RUNS THE REAL MIGRATIONS. *** `CANONICAL_ADMIN_ROLES` says there
 * are four roles and the Admin pane repeats it ("the system exposes exactly four
 * roles"). On the all-in-one container there were three: MySQL's
 * `add_vaults_user` migration was never ported to sqlite, so VAULTS_USER was a
 * name with no row. The pane listed three under a sentence saying four, and
 * `srn-admin roles grant <user> VAULTS_USER` answered "Granted" and changed
 * nothing. No spec could see it, because every spec that touches roles seeds its
 * own; the only thing that knows what the all-in-one really holds is its own
 * migrations, run in order on a real database, which is what this does.
 *
 * The list of roles is the server's own (`CANONICAL_ADMIN_ROLE_NAMES`), and the
 * migrations are read from the directory. So a fifth canonical role added
 * without a sqlite migration turns this red, with nothing here to remember.
 */
describe('the canonical roles in a migrated all-in-one (sqlite) database', () => {
  const open = async (migrations: MigrationClass[]): Promise<DataSource> => {
    const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', migrations, logging: false })
    await dataSource.initialize()
    await dataSource.runMigrations()

    return dataSource
  }

  const roleNames = async (dataSource: DataSource): Promise<string[]> =>
    ((await dataSource.query('SELECT DISTINCT name FROM roles')) as Array<{ name: string }>).map((role) => role.name)

  it('holds every role the admin surface says exists', async () => {
    const all = await migrationsIn(SQLITE_MIGRATIONS)
    // The directory really was read: the schema, the seed and the newest one.
    expect(all.length).toBeGreaterThan(40)
    const dataSource = await open(all)

    try {
      const present = await roleNames(dataSource)

      expect(CANONICAL_ADMIN_ROLE_NAMES.length).toBeGreaterThanOrEqual(4)
      expect(CANONICAL_ADMIN_ROLE_NAMES.filter((name) => !present.includes(name))).toEqual([])
    } finally {
      await dataSource.destroy()
    }
  }, 120_000)

  it('did not hold VAULTS_USER before this migration, which is what the pane showed', async () => {
    const dataSource = await open(await migrationsIn(SQLITE_MIGRATIONS, VAULTS_USER_MIGRATION))

    try {
      const present = await roleNames(dataSource)

      expect(CANONICAL_ADMIN_ROLE_NAMES.filter((name) => !present.includes(name))).toEqual(['VAULTS_USER'])
    } finally {
      await dataSource.destroy()
    }
  }, 120_000)

  it('adds the same role MySQL has, once, and no second one beside a role already there', async () => {
    const dataSource = await open(await migrationsIn(SQLITE_MIGRATIONS))

    try {
      const rows = (await dataSource.query("SELECT uuid, version FROM roles WHERE name = 'VAULTS_USER'")) as Array<{
        uuid: string
        version: number
      }>
      // The uuid is MySQL's own, read from MySQL's migration rather than typed here.
      const mysqlUuid = /VALUES \("([0-9a-f-]{36})", "VAULTS_USER", 1\)/.exec(
        readFileSync(join(MYSQL_MIGRATIONS, '1694157482134-add_vaults_user.ts'), 'utf8'),
      )?.[1]
      expect(mysqlUuid).toBeDefined()
      expect(rows).toEqual([{ uuid: mysqlUuid, version: 1 }])

      // Run it again: an operator's database on which it has already run, or one
      // where the role was put in by hand, must come out with exactly one.
      const migration = new addVaultsUserRole1791849600000()
      const runner = dataSource.createQueryRunner()
      await migration.up(runner)
      await dataSource.query(
        "UPDATE roles SET uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' WHERE name = 'VAULTS_USER'",
      )
      await migration.up(runner)
      await runner.release()

      expect(await dataSource.query("SELECT uuid FROM roles WHERE name = 'VAULTS_USER'")).toEqual([
        { uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      ])
    } finally {
      await dataSource.destroy()
    }
  }, 120_000)
})
