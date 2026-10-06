import { Uuid } from '@standardnotes/domain-core'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'

import { SQLItemPersistenceMapper } from '../../Mapping/Persistence/SQLItemPersistenceMapper'
import { SQLItem } from './SQLItem'
import { SQLItemRepository } from './SQLItemRepository'

/**
 * Standard Red Notes: the account's stored-item total, against a REAL database.
 *
 * *** THIS IS NOT A QUERY-BUILDER ASSERTION ON PURPOSE. *** The whole point of
 * `getStorageUsageForUser` is the behaviour of SQL over NULLs — `SUM()` answers
 * NULL for a set of NULLs exactly as it does for an empty set — and a spec that
 * asserted which strings were passed to `select()` would pass over a query that
 * got that wrong. So every case here is written through the repository against an
 * in-memory SQLite, which is one of the two dialects this server ships with and
 * which evaluates `CASE`, `COALESCE` and `SUM` the same way the other does.
 *
 * Rows are inserted with raw SQL rather than through `insert()` because the
 * interesting state — `content_size IS NULL` — is one the domain constructor
 * refuses to produce: `Item` computes a size for any item built without one. That
 * state exists in the wild regardless, in every row written before the column was
 * added by migration, and it is the one that turns a total into a floor.
 */
describe('SQLItemRepository.getStorageUsageForUser', () => {
  let dataSource: DataSource
  let repository: SQLItemRepository

  const userUuid = Uuid.create('00000000-0000-0000-0000-000000000002').getValue()
  const otherUserUuid = Uuid.create('00000000-0000-0000-0000-000000000003').getValue()

  let nextUuid = 0

  const insertRow = async (input: { owner?: Uuid; contentSize: number | null; deleted?: boolean }): Promise<string> => {
    nextUuid += 1
    const uuid = `00000000-0000-0000-0000-${String(nextUuid).padStart(12, '0')}`
    await dataSource.query(
      'INSERT INTO items (uuid, user_uuid, content, content_type, content_size, deleted, created_at, updated_at, created_at_timestamp, updated_at_timestamp) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uuid,
        (input.owner ?? userUuid).value,
        'ciphertext',
        'Note',
        input.contentSize,
        input.deleted === true ? 1 : 0,
        new Date(1).toISOString(),
        new Date(1).toISOString(),
        100,
        100,
      ],
    )
    return uuid
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

    const logger = { error: jest.fn() } as unknown as Logger
    repository = new SQLItemRepository(dataSource.getRepository(SQLItem), new SQLItemPersistenceMapper(), logger)
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('reports an account with no items at all as a complete zero', async () => {
    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 0,
      sizedItems: 0,
      unsizedItems: 0,
    })
  })

  it('sums the recorded sizes and counts the items they came from', async () => {
    await insertRow({ contentSize: 1_000 })
    await insertRow({ contentSize: 2_500 })
    await insertRow({ contentSize: 500 })

    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 4_000,
      sizedItems: 3,
      unsizedItems: 0,
    })
  })

  /**
   * *** THE CASE THE PRE-EXISTING SUM CANNOT EXPRESS. ***
   *
   * `sumContentSizeForComputingTransferLimit` answers `0` here, which is correct
   * for a transfer limit and is a lie in a storage report: this account holds
   * three items and the server simply does not know how big they are. Asserted
   * side by side so the difference is the subject of the test rather than an
   * incidental property of it.
   */
  it('does not report items with no recorded size as zero bytes, unlike the transfer-limit sum', async () => {
    await insertRow({ contentSize: null })
    await insertRow({ contentSize: null })
    await insertRow({ contentSize: null })

    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 0,
      sizedItems: 0,
      unsizedItems: 3,
    })
    expect(
      await repository.sumContentSizeForComputingTransferLimit({ userUuid: userUuid.value, deleted: false }),
    ).toEqual(0)
  })

  it('keeps a partially measured account distinguishable from a fully measured one', async () => {
    await insertRow({ contentSize: 4_096 })
    await insertRow({ contentSize: null })

    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 4_096,
      sizedItems: 1,
      unsizedItems: 1,
    })
  })

  /**
   * Deletion drops out twice over: the delete path zeroes `content_size` AND sets
   * `deleted`. Both are asserted, with a NON-zero size on the deleted row, so a
   * query that forgot the `deleted` filter would fail here rather than passing on
   * the zeroing alone.
   */
  it('excludes deleted items even when they still carry a recorded size', async () => {
    await insertRow({ contentSize: 1_024 })
    await insertRow({ contentSize: 9_999_999, deleted: true })

    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 1_024,
      sizedItems: 1,
      unsizedItems: 0,
    })
  })

  it('excludes deleted items that carry no recorded size from the unmeasured count too', async () => {
    await insertRow({ contentSize: null, deleted: true })

    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 0,
      sizedItems: 0,
      unsizedItems: 0,
    })
  })

  it('counts only the requesting account, never another account sharing the table', async () => {
    await insertRow({ contentSize: 1_024 })
    await insertRow({ owner: otherUserUuid, contentSize: 8_388_608 })
    await insertRow({ owner: otherUserUuid, contentSize: null })

    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 1_024,
      sizedItems: 1,
      unsizedItems: 0,
    })
    expect(await repository.getStorageUsageForUser(otherUserUuid)).toEqual({
      sizedBytes: 8_388_608,
      sizedItems: 1,
      unsizedItems: 1,
    })
  })

  /**
   * The behavioural statement the whole feature rests on: the figure is DERIVED,
   * so an item whose recorded size changes changes the total with no counter to
   * update, and a deletion removes its bytes completely.
   */
  it('follows a create, a grow, a shrink and a delete with no counter to keep in step', async () => {
    const first = await insertRow({ contentSize: 1_000 })
    await insertRow({ contentSize: 1_000 })
    expect((await repository.getStorageUsageForUser(userUuid)).sizedBytes).toEqual(2_000)

    await repository.updateContentSize(first, 50_000)
    expect((await repository.getStorageUsageForUser(userUuid)).sizedBytes).toEqual(51_000)

    await repository.updateContentSize(first, 10)
    expect((await repository.getStorageUsageForUser(userUuid)).sizedBytes).toEqual(1_010)

    await repository.markItemsAsDeleted([first], 200)
    await repository.updateContentSize(first, 0)
    expect(await repository.getStorageUsageForUser(userUuid)).toEqual({
      sizedBytes: 1_000,
      sizedItems: 1,
      unsizedItems: 0,
    })
  })
})
