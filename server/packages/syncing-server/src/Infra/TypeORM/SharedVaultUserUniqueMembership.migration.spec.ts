import { DataSource, QueryRunner } from 'typeorm'

import { AddUniqueSharedVaultMembership1787100000000 } from '../../../migrations/sqlite/1787100000000-add-unique-shared-vault-membership'

/**
 * The unique membership constraint has to be installable on a database that ALREADY contains
 * duplicate rows — a blind `CREATE UNIQUE INDEX` would abort the migration run and leave the
 * deployment stuck. This exercises the real migration class against a real SQLite database seeded
 * with duplicates, so the SQL asserted here is literally the SQL that will run.
 *
 * It lives under src/ rather than next to the migration so that it can never be picked up by the
 * `migrations/<engine>/*.js` glob the DataSource uses to discover migrations.
 */
describe('AddUniqueSharedVaultMembership (sqlite)', () => {
  const VAULT_A = '0000000a-0000-0000-0000-00000000000a'
  const VAULT_B = '0000000b-0000-0000-0000-00000000000b'
  const USER_ONE = '00000001-0000-0000-0000-000000000001'
  const USER_TWO = '00000002-0000-0000-0000-000000000002'

  let dataSource: DataSource
  let queryRunner: QueryRunner

  type Row = {
    uuid: string
    shared_vault_uuid: string
    user_uuid: string
    updated_at_timestamp: number
    is_designated_survivor: number
  }

  const insertMembership = async (row: {
    uuid: string
    sharedVaultUuid: string
    userUuid: string
    permission?: string
    updatedAtTimestamp: number
    isDesignatedSurvivor?: boolean
  }): Promise<void> => {
    await queryRunner.query(
      'INSERT INTO "shared_vault_users" ("uuid", "shared_vault_uuid", "user_uuid", "permission", ' +
        '"created_at_timestamp", "updated_at_timestamp", "is_designated_survivor") VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        row.uuid,
        row.sharedVaultUuid,
        row.userUuid,
        row.permission ?? 'write',
        1,
        row.updatedAtTimestamp,
        row.isDesignatedSurvivor ? 1 : 0,
      ],
    )
  }

  const allMemberships = (): Promise<Row[]> =>
    queryRunner.query(
      'SELECT "uuid", "shared_vault_uuid", "user_uuid", "updated_at_timestamp", "is_designated_survivor" ' +
        'FROM "shared_vault_users" ORDER BY "uuid"',
    )

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' })
    await dataSource.initialize()
    queryRunner = dataSource.createQueryRunner()

    // The table exactly as migrations leave it immediately before this one runs
    // (1695284249461-add-designated-survivor).
    await queryRunner.query(
      'CREATE TABLE "shared_vault_users" ("uuid" varchar PRIMARY KEY NOT NULL, ' +
        '"shared_vault_uuid" varchar(36) NOT NULL, "user_uuid" varchar(36) NOT NULL, ' +
        '"permission" varchar(24) NOT NULL, "created_at_timestamp" bigint NOT NULL, ' +
        '"updated_at_timestamp" bigint NOT NULL, "is_designated_survivor" boolean NOT NULL DEFAULT (0))',
    )
    await queryRunner.query('CREATE INDEX "user_uuid_on_shared_vault_users" ON "shared_vault_users" ("user_uuid")')
    await queryRunner.query(
      'CREATE INDEX "shared_vault_uuid_on_shared_vault_users" ON "shared_vault_users" ("shared_vault_uuid")',
    )
  })

  afterEach(async () => {
    await queryRunner.release()
    await dataSource.destroy()
  })

  it('de-duplicates an existing database and then installs the constraint', async () => {
    // (VAULT_A, USER_ONE): three rows. The newest wins; the uuid tie-break decides between the two
    // that share updated_at_timestamp.
    await insertMembership({ uuid: 'a1', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 100 })
    await insertMembership({ uuid: 'a2', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 300 })
    await insertMembership({ uuid: 'a3', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 300 })

    // (VAULT_A, USER_TWO): the designated survivor is the OLDER row and must still be the one kept,
    // because losing that flag loses emergency access to the vault.
    await insertMembership({
      uuid: 'b1',
      sharedVaultUuid: VAULT_A,
      userUuid: USER_TWO,
      updatedAtTimestamp: 100,
      isDesignatedSurvivor: true,
    })
    await insertMembership({ uuid: 'b2', sharedVaultUuid: VAULT_A, userUuid: USER_TWO, updatedAtTimestamp: 500 })

    // (VAULT_B, USER_ONE): not a duplicate of anything; must survive untouched.
    await insertMembership({ uuid: 'c1', sharedVaultUuid: VAULT_B, userUuid: USER_ONE, updatedAtTimestamp: 100 })

    // Precondition: the database really does contain duplicates before the migration runs, which is
    // the only state in which a blind CREATE UNIQUE INDEX would fail.
    const before = await allMemberships()
    expect(before).toHaveLength(6)
    expect(before.filter((row) => row.shared_vault_uuid === VAULT_A && row.user_uuid === USER_ONE)).toHaveLength(3)
    expect(before.filter((row) => row.shared_vault_uuid === VAULT_A && row.user_uuid === USER_TWO)).toHaveLength(2)

    await new AddUniqueSharedVaultMembership1787100000000().up(queryRunner)

    const after = await allMemberships()
    expect(after.map((row) => row.uuid)).toEqual(['a2', 'b1', 'c1'])

    // The constraint is now live: a second row for an existing membership is rejected.
    await expect(
      insertMembership({ uuid: 'a4', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 900 }),
    ).rejects.toThrow(/UNIQUE/i)

    // ...while an unrelated membership still inserts, so the index is not simply rejecting everything.
    await insertMembership({ uuid: 'd1', sharedVaultUuid: VAULT_B, userUuid: USER_TWO, updatedAtTimestamp: 900 })
    expect((await allMemberships()).map((row) => row.uuid)).toEqual(['a2', 'b1', 'c1', 'd1'])
  })

  it('leaves a database without duplicates untouched', async () => {
    await insertMembership({ uuid: 'a1', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 100 })
    await insertMembership({ uuid: 'b1', sharedVaultUuid: VAULT_A, userUuid: USER_TWO, updatedAtTimestamp: 200 })
    await insertMembership({ uuid: 'c1', sharedVaultUuid: VAULT_B, userUuid: USER_ONE, updatedAtTimestamp: 300 })

    expect(await allMemberships()).toHaveLength(3)

    await new AddUniqueSharedVaultMembership1787100000000().up(queryRunner)

    expect((await allMemberships()).map((row) => row.uuid)).toEqual(['a1', 'b1', 'c1'])
  })

  it('drops the constraint on down', async () => {
    await insertMembership({ uuid: 'a1', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 100 })

    const migration = new AddUniqueSharedVaultMembership1787100000000()
    await migration.up(queryRunner)

    // Precondition: the constraint really was installed, so the success after down() means it was
    // removed rather than never created.
    await expect(
      insertMembership({ uuid: 'a2', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 200 }),
    ).rejects.toThrow(/UNIQUE/i)

    await migration.down(queryRunner)

    await insertMembership({ uuid: 'a3', sharedVaultUuid: VAULT_A, userUuid: USER_ONE, updatedAtTimestamp: 300 })
    expect((await allMemberships()).map((row) => row.uuid)).toEqual(['a1', 'a3'])
  })
})
