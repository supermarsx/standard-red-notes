import { Repository, DataSource } from 'typeorm'
import { Logger } from 'winston'

import { SQLItemPersistenceMapper } from '../../Mapping/Persistence/SQLItemPersistenceMapper'
import { SQLItem } from './SQLItem'
import { SQLItemRepository } from './SQLItemRepository'

/**
 * Standard Red Notes: THE UNRESOLVABLE SELF-HEAL LOOP, against a REAL database.
 *
 * A row this server cannot turn into a domain `Item` used to be handled by two
 * paths that disagreed about it:
 *
 *  - `findAll` (and `findByUuid`/`findByUuidAndUserUuid`) caught the mapper's
 *    throw, logged it and moved on, so the row was never DELIVERED;
 *  - `findItemsForComputingIntegrityPayloads` read three columns of raw SQL and
 *    never mapped anything, so the row was REPORTED, every single time.
 *
 * A client holding neither the row nor a way to get it is told it diverges,
 * asks for the row, receives nothing, recomputes, and is told again — a loop it
 * cannot leave by syncing, which is the one thing it can do. The invariant that
 * ends it, and the one this file exists to pin, is:
 *
 *   *** NOTHING MAY BE REPORTED THAT CANNOT BE DELIVERED. ***
 *
 * Both directions are asserted on purpose. A fix that merely stopped reporting
 * things would pass "the broken row is not reported" while quietly dropping the
 * whole account, so every case below that excludes a row is paired with one that
 * insists an ordinary row survives. The reporting query now selects named
 * columns rather than three; if one were ever forgotten, every row would parse
 * as broken and the first case here is what fails.
 *
 * Rows are inserted through TypeORM so the fixture is written in the dialect's
 * own format and hydrates back the way production rows do, and are corrupted
 * afterwards with raw SQL, which is the real sequence: a row written correctly,
 * later made unreadable by a migration that wrote a sentinel the domain does not
 * know (`restrict_content_type` wrote `Unknown`), by a rollback onto a build
 * with a shorter content-type list, or by a BIGINT the driver can only hand back
 * as a string.
 */
describe('SQLItemRepository: rows the mapper refuses', () => {
  let dataSource: DataSource
  let ormRepository: Repository<SQLItem>
  let repository: SQLItemRepository
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000002'
  const otherUserUuid = '00000000-0000-0000-0000-000000000003'

  let nextUuid = 0

  const insertRow = async (overrides: Partial<SQLItem> = {}): Promise<string> => {
    nextUuid += 1
    const row = new SQLItem()
    row.uuid = `00000000-0000-0000-0000-${String(nextUuid).padStart(12, '0')}`
    row.duplicateOf = null
    row.itemsKeyId = 'items-key-id'
    row.content = 'ciphertext'
    row.contentType = 'Note'
    row.contentSize = 10
    row.encItemKey = 'enc-item-key'
    row.authHash = null
    row.userUuid = userUuid
    row.deleted = false
    row.createdAt = new Date(1000)
    row.updatedAt = new Date(2000)
    row.createdAtTimestamp = 100 + nextUuid
    row.updatedAtTimestamp = 200 + nextUuid
    row.updatedWithSession = null
    row.lastEditedBy = null
    row.sharedVaultUuid = null
    row.keySystemIdentifier = null

    Object.assign(row, overrides)

    await ormRepository.insert(row)

    return row.uuid
  }

  const corrupt = async (uuid: string, column: string, value: string | null): Promise<void> => {
    await dataSource.query(`UPDATE items SET ${column} = ? WHERE uuid = ?`, [value, uuid])
  }

  const reportedUuids = async (): Promise<string[]> =>
    (await repository.findItemsForComputingIntegrityPayloads(userUuid)).map((payload) => payload.uuid)

  const deliveredUuids = async (): Promise<string[]> =>
    (await repository.findAll({ userUuid })).map((item) => item.id.toString())

  beforeEach(async () => {
    nextUuid = 0
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SQLItem],
      synchronize: true,
    })
    await dataSource.initialize()
    ormRepository = dataSource.getRepository(SQLItem)

    logger = { error: jest.fn() } as unknown as Logger
    repository = new SQLItemRepository(ormRepository, new SQLItemPersistenceMapper(), logger)
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('reports and delivers an ordinary row, so an exclusion cannot be mistaken for a fix', async () => {
    const uuid = await insertRow()

    expect(await reportedUuids()).toEqual([uuid])
    expect(await deliveredUuids()).toEqual([uuid])
  })

  it('reports and delivers a row whose content type is NULL, which the domain accepts', async () => {
    const uuid = await insertRow()
    await corrupt(uuid, 'content_type', null)

    expect(await reportedUuids()).toEqual([uuid])
    expect(await deliveredUuids()).toEqual([uuid])
  })

  it('never reports a content type the domain does not know, because it can never be delivered', async () => {
    const good = await insertRow()
    const unknownType = await insertRow()
    await corrupt(unknownType, 'content_type', 'Unknown')

    expect(await deliveredUuids()).toEqual([good])
    expect(await reportedUuids()).toEqual([good])
  })

  it('never reports a timestamp the driver hands back as a string, because it can never be delivered', async () => {
    const good = await insertRow()
    const stringTimestamp = await insertRow()
    await corrupt(stringTimestamp, 'created_at_timestamp', 'not-a-number')

    expect(await deliveredUuids()).toEqual([good])
    expect(await reportedUuids()).toEqual([good])
  })

  it('never reports a malformed session uuid, because it can never be delivered', async () => {
    const good = await insertRow()
    const malformedSession = await insertRow()
    await corrupt(malformedSession, 'updated_with_session', 'not-a-uuid')

    expect(await deliveredUuids()).toEqual([good])
    expect(await reportedUuids()).toEqual([good])
  })

  it('keeps every reported row deliverable even when the account is mostly broken', async () => {
    const good = await insertRow()
    const brokenType = await insertRow()
    const brokenTimestamp = await insertRow()
    const brokenDuplicateOf = await insertRow()
    await corrupt(brokenType, 'content_type', 'SN|SomethingFromTheFuture')
    await corrupt(brokenTimestamp, 'updated_at_timestamp', 'yesterday')
    await corrupt(brokenDuplicateOf, 'duplicate_of', 'not-a-uuid')

    const reported = await reportedUuids()
    const delivered = await deliveredUuids()

    expect(reported).toEqual([good])
    expect(reported.every((uuid) => delivered.includes(uuid))).toBe(true)
  })

  it('names an excluded row and its reason to the operator rather than dropping it in silence', async () => {
    const broken = await insertRow()
    await corrupt(broken, 'content_type', 'Unknown')

    await repository.findItemsForComputingIntegrityPayloads(userUuid)

    const logged = (logger.error as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain(broken)
    expect(logged).toContain('Unknown')
  })

  it('leaves another account out of the reporting scope whether or not its rows are mappable', async () => {
    const mine = await insertRow()
    const theirs = await insertRow({ userUuid: otherUserUuid })
    await corrupt(theirs, 'content_type', 'Unknown')

    expect(await reportedUuids()).toEqual([mine])
  })
})
