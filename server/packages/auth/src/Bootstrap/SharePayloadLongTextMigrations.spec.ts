import { DataSource, QueryRunner } from 'typeorm'

import { sharePayloadLongText1791700000000 as MySqlMigration } from '../../migrations/mysql/1791700000000-share-payload-longtext'
import { TypeORMShare } from '../Infra/TypeORM/TypeORMShare'

/**
 * Standard Red Notes: a share link now carries the images the note embeds (the
 * reader has no session, so it cannot fetch them), which makes the stored
 * ciphertext as large as the note PLUS its images.
 *
 * MySQL's `TEXT` stops at 65,535 bytes and, outside strict mode, TRUNCATES
 * rather than erroring — so the failure mode is a share that stores fine and
 * then tells every reader the link is undecryptable. Widening the column is the
 * whole server-side change; there is no new route and no new credential.
 */
describe('share payload longtext migration', () => {
  const record = (): { statements: string[]; queryRunner: QueryRunner } => {
    const statements: string[] = []

    return {
      statements,
      queryRunner: { query: jest.fn(async (sql: string) => statements.push(sql)) } as unknown as QueryRunner,
    }
  }

  it('widens shares.encrypted_payload to longtext in one statement', async () => {
    const { statements, queryRunner } = record()

    await new MySqlMigration().up(queryRunner)

    expect(statements).toHaveLength(1)
    const sql = (statements[0] as string).toLowerCase()
    expect(sql).toContain('alter table')
    expect(sql).toContain('`shares`')
    expect(sql).toContain('`encrypted_payload`')
    expect(sql).toContain('longtext')
    // Dropping NOT NULL would let a share row exist with no ciphertext at all,
    // which the public read path would hand to the viewer as an empty envelope.
    expect(sql).toContain('not null')
  })

  it('narrows it back on down, and touches nothing else', async () => {
    const { statements, queryRunner } = record()

    await new MySqlMigration().down(queryRunner)

    expect(statements).toHaveLength(1)
    expect((statements[0] as string).toLowerCase()).toBe(
      'alter table `shares` modify `encrypted_payload` text not null',
    )
  })

  /**
   * SQLite gets no twin migration, and this is the evidence rather than the
   * claim. Two separate things are proved against a REAL in-memory database:
   *
   *  1. `TypeORMShare` still initialises under the SQLite driver. TypeORM's
   *     `AbstractSqliteDriver.supportedDataTypes` does not list `longtext`, so
   *     declaring it on the entity would make `EntityMetadataValidator` throw
   *     at DataSource initialisation — the single container would fail to boot
   *     while every build, lint and unit test stayed green. The entity
   *     therefore still says `text`, and only the physical MySQL column moves.
   *
   *  2. SQLite's TEXT affinity carries no length limit, so a payload far past
   *     MySQL's 64 KiB ceiling round-trips byte-for-byte with no migration.
   */
  describe('sqlite needs no widening', () => {
    let dataSource: DataSource

    beforeEach(async () => {
      dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [TypeORMShare],
        synchronize: true,
      })
      await dataSource.initialize()
    })

    afterEach(async () => {
      await dataSource.destroy()
    })

    it('stores and returns a payload far past MySQL’s TEXT ceiling, unchanged', async () => {
      const repository = dataSource.getRepository(TypeORMShare)
      // 1 MiB: an order of magnitude past 65,535 bytes, and the size an
      // embedded screenshot actually reaches.
      const payload = 'x'.repeat(1024 * 1024)

      const saved = await repository.save({
        uuid: '00000000-0000-4000-8000-0000000000aa',
        userUuid: '00000000-0000-4000-8000-0000000000bb',
        type: 'note',
        encryptedPayload: payload,
        nickname: null,
        createdAt: 1_000,
        revoked: false,
        oneTimeView: false,
        viewExpiresMinutes: null,
        firstOpenedAt: null,
      })

      const loaded = await repository.findOneBy({ uuid: saved.uuid })

      expect(loaded).not.toBeNull()
      expect((loaded as TypeORMShare).encryptedPayload).toHaveLength(payload.length)
      expect((loaded as TypeORMShare).encryptedPayload).toBe(payload)
    })
  })
})
