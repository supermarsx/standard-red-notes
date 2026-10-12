import { DataSource } from 'typeorm'
import { Logger } from 'winston'

import { SQLItemPersistenceMapper } from '../../../../Mapping/Persistence/SQLItemPersistenceMapper'
import { SQLItem } from '../../../../Infra/TypeORM/SQLItem'
import { SQLItemRepository } from '../../../../Infra/TypeORM/SQLItemRepository'
import { GetUsersStorageUsage } from './GetUsersStorageUsage'

/**
 * Standard Red Notes: the admin per-account read against a REAL database, because
 * what went wrong lives between this use case and the database and a mocked
 * repository hides both halves of it.
 *
 * A uuid is case-insensitive on input, and `Uuid.create` accepts either spelling
 * and keeps the one it was given. Asked about an account in UPPER CASE, this use
 * case therefore queried `user_uuid IN ('3A91…')`:
 *
 *   - on SQLite the comparison is case-sensitive, so no row matched;
 *   - on MySQL the collation is case-insensitive, so the rows DID match -- and
 *     came back keyed on the stored lower-case uuid, which the upper-case lookup
 *     into the result map then missed.
 *
 * Either way the answer was `{ sizedBytes: 0, sizedItems: 0 }`: a complete,
 * measured-looking zero for an account holding megabytes. Measured on both a
 * running all-in-one and a running compose stack, through the gateway.
 */
describe('GetUsersStorageUsage against a real database', () => {
  let dataSource: DataSource
  let useCase: GetUsersStorageUsage

  const ALICE = '3a9102fa-f130-4506-b030-7c6d123dfa18'
  const BOB = '6d29edf1-0866-40fd-be34-fb3c717679ff'
  const NOBODY = 'cc2da10f-fdb2-4ca7-9035-75cdbfea80a5'

  let nextUuid = 0
  const insertItem = async (owner: string, contentSize: number): Promise<void> => {
    nextUuid += 1
    await dataSource.query(
      'INSERT INTO items (uuid, user_uuid, content, content_type, content_size, deleted, created_at, updated_at, created_at_timestamp, updated_at_timestamp) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        `00000000-0000-0000-0000-${String(nextUuid).padStart(12, '0')}`,
        owner,
        'ciphertext',
        'Note',
        contentSize,
        0,
        new Date(1).toISOString(),
        new Date(1).toISOString(),
        100,
        100,
      ],
    )
  }

  beforeEach(async () => {
    nextUuid = 0
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SQLItem],
      synchronize: true,
    })
    await dataSource.initialize()
    useCase = new GetUsersStorageUsage(
      new SQLItemRepository(dataSource.getRepository(SQLItem), new SQLItemPersistenceMapper(), {
        error: jest.fn(),
      } as unknown as Logger),
    )
    // Stored the way the server stores them: lower case.
    await insertItem(ALICE, 1_500_000)
    await insertItem(ALICE, 1_107)
    await insertItem(BOB, 702_212)
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('answers an account asked about in UPPER CASE with its real figure, never a zero', async () => {
    const result = await useCase.execute({ userUuids: [ALICE.toUpperCase()] })

    expect(result.getValue()).toEqual([{ userUuid: ALICE, sizedBytes: 1_501_107, sizedItems: 2, unsizedItems: 0 }])
  })

  it('names the account in its canonical spelling, whatever spelling asked', async () => {
    const result = await useCase.execute({ userUuids: [BOB.toUpperCase(), ALICE, NOBODY.toUpperCase()] })

    // One spelling per account in the answer, so the same account cannot appear
    // under two names with two different figures.
    expect(result.getValue()).toEqual([
      { userUuid: BOB, sizedBytes: 702_212, sizedItems: 1, unsizedItems: 0 },
      { userUuid: ALICE, sizedBytes: 1_501_107, sizedItems: 2, unsizedItems: 0 },
      // An account with no items is still the one true zero.
      { userUuid: NOBODY, sizedBytes: 0, sizedItems: 0, unsizedItems: 0 },
    ])
  })

  it('gives both spellings of one account the same figure', async () => {
    const result = await useCase.execute({ userUuids: [ALICE, ALICE.toUpperCase()] })

    expect(result.getValue().map((usage) => usage.sizedBytes)).toEqual([1_501_107, 1_501_107])
  })

  it('still refuses a value that is not a uuid in any spelling', async () => {
    const result = await useCase.execute({ userUuids: [ALICE.toUpperCase(), 'NOT-A-UUID'] })

    expect(result.isFailed()).toBe(true)
    // ... and says so about the value it was GIVEN, not a respelling of it.
    expect(result.getError()).toBe('Given value is not a valid uuid: NOT-A-UUID')
  })
})
