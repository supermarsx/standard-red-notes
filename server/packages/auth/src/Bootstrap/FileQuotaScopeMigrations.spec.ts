import { QueryRunner } from 'typeorm'

import { fileQuotaScopeWithoutSubscriptionRow1791600000000 as MySqlMigration } from '../../migrations/mysql/1791600000000-file-quota-scope-without-subscription-row'
import { fileQuotaScopeWithoutSubscriptionRow1791600000000 as SqliteMigration } from '../../migrations/sqlite/1791600000000-file-quota-scope-without-subscription-row'

const CONSTRAINT = 'FK_ad2907de2850d8b531ff23329f3'

/**
 * The slice of `better-sqlite3` this spec uses, declared locally.
 *
 * The package ships no type declarations and `@types/better-sqlite3` is not a
 * dependency of this workspace — importing it directly left this file passing
 * jest and FAILING `tsc`, which on this tree means failing nowhere until a
 * container build. Adding a types package to satisfy one spec would put a
 * lockfile change in front of the contract gates for no behavioural gain, so the
 * four methods actually called are described here instead.
 */
type SqliteStatement = {
  reader: boolean
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  pragma(statement: string): unknown
  close(): unknown
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3') as new (filename: string) => SqliteDatabase

/**
 * Standard Red Notes: the migration that lets an account with NO
 * `user_subscriptions` row keep a file-usage total.
 *
 * *** WHY THIS SPEC RUNS REAL SQL RATHER THAN COUNTING STATEMENTS. ***
 *
 * The defect it fixes was invisible to every unit test in this package and to
 * every type: SQLite enforced the foreign key at INSERT time, the single-container
 * event bus awaited the handler that did the INSERT, and the raised
 * `FOREIGN KEY constraint failed` travelled back out of `FinishUploadSession` —
 * so the UPLOAD answered 400. A statement-shape assertion would have passed over
 * a rebuild that dropped a row, kept the constraint, or lost an index; only
 * executing it against a real database establishes that the constraint is gone,
 * the rows are still there, and the INSERT the server now performs is accepted.
 *
 * `PRAGMA foreign_keys` is turned ON explicitly here, because SQLite defaults it
 * OFF per connection and a test with it off cannot tell a dropped constraint from
 * an unenforced one — which is the exact shape of a gate that is present, passing
 * and incapable of failing.
 */
describe('file-quota-scope sqlite migration, executed', () => {
  const USER_UUID = '11111111-1111-4111-8111-111111111111'
  const SUBSCRIPTION_UUID = '22222222-2222-4222-8222-222222222222'

  type Db = SqliteDatabase

  let db: Db

  /** A `QueryRunner` that really executes against the in-memory database. */
  const runnerFor = (database: Db): QueryRunner =>
    ({
      query: async (sql: string) => {
        const statement = database.prepare(sql)

        return statement.reader ? statement.all() : (statement.run(), [])
      },
    }) as unknown as QueryRunner

  const createSchema = (database: Db, withConstraint: boolean): void => {
    database.exec(
      'CREATE TABLE "user_subscriptions" ("uuid" varchar PRIMARY KEY NOT NULL, "plan_name" varchar(255) NOT NULL, "ends_at" bigint NOT NULL, "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL, "renewed_at" bigint, "cancelled" tinyint NOT NULL DEFAULT (0), "subscription_id" integer, "subscription_type" varchar(24) NOT NULL, "user_uuid" varchar NOT NULL)',
    )
    database.exec(
      'CREATE TABLE "subscription_settings" ("uuid" varchar PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL, "value" text, "server_encryption_version" tinyint NOT NULL DEFAULT (0), "created_at" bigint NOT NULL, "updated_at" bigint NOT NULL, "sensitive" tinyint NOT NULL DEFAULT (0), "user_subscription_uuid" varchar NOT NULL' +
        (withConstraint
          ? `, CONSTRAINT "${CONSTRAINT}" FOREIGN KEY ("user_subscription_uuid") REFERENCES "user_subscriptions" ("uuid") ON DELETE CASCADE ON UPDATE NO ACTION`
          : '') +
        ')',
    )
    database.exec('CREATE INDEX "index_subcsription_settings_on_updated_at" ON "subscription_settings" ("updated_at")')
    database.exec(
      'CREATE INDEX "index_settings_on_name_and_user_subscription_uuid" ON "subscription_settings" ("name", "user_subscription_uuid")',
    )
  }

  const seedSubscriberRow = (database: Db): void => {
    database
      .prepare(
        'INSERT INTO "user_subscriptions" ("uuid","plan_name","ends_at","created_at","updated_at","subscription_type","user_uuid") VALUES (?,?,?,?,?,?,?)',
      )
      .run(SUBSCRIPTION_UUID, 'PRO_PLAN', 1, 1, 1, 'regular', USER_UUID)
    database
      .prepare(
        'INSERT INTO "subscription_settings" ("uuid","name","value","created_at","updated_at","user_subscription_uuid") VALUES (?,?,?,?,?,?)',
      )
      .run('setting-1', 'FILE_UPLOAD_BYTES_USED', '4096', 1, 2, SUBSCRIPTION_UUID)
  }

  const insertUserScopedTotal = (database: Db): { ok: boolean; message?: string } => {
    try {
      database
        .prepare(
          'INSERT INTO "subscription_settings" ("uuid","name","value","created_at","updated_at","user_subscription_uuid") VALUES (?,?,?,?,?,?)',
        )
        .run('setting-2', 'FILE_UPLOAD_BYTES_USED', '8192', 1, 2, USER_UUID)

      return { ok: true }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  const indexNames = (database: Db): string[] =>
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'subscription_settings'")
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_autoindex'))
      .sort()

  const storedSchema = (database: Db): string =>
    (
      database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscription_settings'")
        .get() as { sql: string }
    ).sql

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
  })

  /**
   * THE PRECONDITION, AND IT IS NOT DECORATION. If this insert succeeded before
   * the migration, every assertion below would pass over a migration that did
   * nothing at all.
   */
  it('refuses a user-scoped total before the migration, naming the constraint', () => {
    createSchema(db, true)
    seedSubscriberRow(db)

    const refused = insertUserScopedTotal(db)

    expect(refused.ok).toBe(false)
    expect(refused.message).toContain('FOREIGN KEY constraint failed')
  })

  it('accepts a user-scoped total after the migration', async () => {
    createSchema(db, true)
    seedSubscriberRow(db)

    await new SqliteMigration().up(runnerFor(db))

    expect(insertUserScopedTotal(db)).toEqual({ ok: true })
    expect(storedSchema(db)).not.toContain(CONSTRAINT)
  })

  it('carries every existing settings row through the rebuild', async () => {
    createSchema(db, true)
    seedSubscriberRow(db)

    await new SqliteMigration().up(runnerFor(db))

    expect(
      db.prepare('SELECT "uuid","name","value","user_subscription_uuid" FROM "subscription_settings"').all(),
    ).toEqual([
      { uuid: 'setting-1', name: 'FILE_UPLOAD_BYTES_USED', value: '4096', user_subscription_uuid: SUBSCRIPTION_UUID },
    ])
  })

  it('recreates both indexes the rebuild drops with the table', async () => {
    createSchema(db, true)

    await new SqliteMigration().up(runnerFor(db))

    expect(indexNames(db)).toEqual([
      'index_settings_on_name_and_user_subscription_uuid',
      'index_subcsription_settings_on_updated_at',
    ])
  })

  it('leaves a database that never had the constraint untouched', async () => {
    createSchema(db, false)
    seedSubscriberRow(db)
    const before = storedSchema(db)

    await new SqliteMigration().up(runnerFor(db))

    expect(storedSchema(db)).toBe(before)
    expect(db.prepare('SELECT COUNT(*) AS total FROM "subscription_settings"').get()).toEqual({ total: 1 })
  })

  /**
   * The rollback has to be a rollback, not a stuck migration: reinstating the
   * constraint over a total recorded for an account with no subscription row is
   * impossible, so those rows are dropped first. They are bookkeeping, and
   * `fix-quota` re-derives them from the files actually on disk.
   */
  it('drops the now-unreferenced totals on down, then reinstates the constraint', async () => {
    createSchema(db, true)
    seedSubscriberRow(db)
    await new SqliteMigration().up(runnerFor(db))
    expect(insertUserScopedTotal(db)).toEqual({ ok: true })

    await new SqliteMigration().down(runnerFor(db))

    expect(storedSchema(db)).toContain(CONSTRAINT)
    expect(db.prepare('SELECT "uuid" FROM "subscription_settings"').all()).toEqual([{ uuid: 'setting-1' }])
    expect(insertUserScopedTotal(db).ok).toBe(false)
    expect(indexNames(db)).toHaveLength(2)
  })
})

/**
 * The MySQL twin cannot be executed here, so it is asserted on the SQL it issues —
 * and on the one property the SQLite run cannot cover: that the drop is GUARDED,
 * so the migration is a no-op on a database whose constraint is already absent.
 */
describe('file-quota-scope mysql migration', () => {
  const record = (constraintPresent: boolean): { statements: string[]; queryRunner: QueryRunner } => {
    const statements: string[] = []

    return {
      statements,
      queryRunner: {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('information_schema')) {
            return [{ total: constraintPresent ? 1 : 0 }]
          }
          statements.push(sql)

          return []
        }),
      } as unknown as QueryRunner,
    }
  }

  it('drops the foreign key, and nothing else, when it is present', async () => {
    const { statements, queryRunner } = record(true)

    await new MySqlMigration().up(queryRunner)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toBe(`ALTER TABLE \`subscription_settings\` DROP FOREIGN KEY \`${CONSTRAINT}\``)
  })

  it('issues nothing when the foreign key is already absent', async () => {
    const { statements, queryRunner } = record(false)

    await new MySqlMigration().up(queryRunner)

    expect(statements).toEqual([])
  })

  it('clears the unreferenced totals before reinstating the constraint on down', async () => {
    const { statements, queryRunner } = record(false)

    await new MySqlMigration().down(queryRunner)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('DELETE FROM `subscription_settings`')
    expect(statements[0]).toContain('NOT IN (SELECT `uuid` FROM `user_subscriptions`)')
    expect(statements[1]).toContain('ADD CONSTRAINT')
    expect(statements[1]).toContain(CONSTRAINT)
  })

  it('does not reinstate a constraint that is already there', async () => {
    const { statements, queryRunner } = record(true)

    await new MySqlMigration().down(queryRunner)

    expect(statements).toEqual([])
  })
})
