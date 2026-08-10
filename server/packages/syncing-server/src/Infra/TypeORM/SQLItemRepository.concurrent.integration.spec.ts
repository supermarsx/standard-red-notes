import { ContentType, Dates, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'

import { ConcurrentItemUpdateError } from '../../Domain/Item/ConcurrentItemUpdateError'
import { Item } from '../../Domain/Item/Item'
import { SQLItemPersistenceMapper } from '../../Mapping/Persistence/SQLItemPersistenceMapper'
import { SQLItem } from './SQLItem'
import { SQLItemRepository } from './SQLItemRepository'

describe('SQLItemRepository concurrent updates', () => {
  let dataSource: DataSource
  let repository: SQLItemRepository

  const itemUuid = '00000000-0000-0000-0000-000000000001'
  const userUuid = Uuid.create('00000000-0000-0000-0000-000000000002').getValue()

  const createItem = (content: string, updatedAtTimestamp: number) =>
    Item.create(
      {
        duplicateOf: null,
        itemsKeyId: 'items-key',
        content,
        contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
        encItemKey: 'encrypted-key',
        authHash: 'auth-hash',
        userUuid,
        deleted: false,
        updatedWithSession: null,
        dates: Dates.create(new Date(1), new Date(updatedAtTimestamp)).getValue(),
        timestamps: Timestamps.create(100, updatedAtTimestamp).getValue(),
      },
      new UniqueEntityId(itemUuid),
    ).getValue()

  beforeEach(async () => {
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

  it('allows exactly one writer for a shared expected timestamp and returns the winner to the loser', async () => {
    const expectedUpdatedAtTimestamp = 100
    await repository.insert(createItem('original', expectedUpdatedAtTimestamp))

    const first = await repository.findByUuidAndUserUuid(itemUuid, userUuid.value)
    const second = await repository.findByUuidAndUserUuid(itemUuid, userUuid.value)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const firstWriter = first as Item
    firstWriter.props.content = 'first-writer'
    firstWriter.props.timestamps = Timestamps.create(100, 200).getValue()
    firstWriter.props.dates = Dates.create(new Date(1), new Date(200)).getValue()

    const secondWriter = second as Item
    secondWriter.props.content = 'second-writer'
    secondWriter.props.timestamps = Timestamps.create(100, 201).getValue()
    secondWriter.props.dates = Dates.create(new Date(1), new Date(201)).getValue()

    const outcomes = await Promise.allSettled([
      repository.update(firstWriter, { userUuid: userUuid.value, updatedAtTimestamp: expectedUpdatedAtTimestamp }),
      repository.update(secondWriter, { userUuid: userUuid.value, updatedAtTimestamp: expectedUpdatedAtTimestamp }),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(ConcurrentItemUpdateError)

    const persisted = await repository.findByUuidAndUserUuid(itemUuid, userUuid.value)
    expect(persisted).not.toBeNull()
    expect(['first-writer', 'second-writer']).toContain(persisted?.props.content)

    const conflict = rejected[0].reason as ConcurrentItemUpdateError
    expect(conflict.serverItem.props.content).toBe(persisted?.props.content)
    expect(conflict.serverItem.props.timestamps.updatedAt).toBe(persisted?.props.timestamps.updatedAt)
  })

  it('matches and preserves the persisted owner instead of accepting ownership from the mutated item', async () => {
    await repository.insert(createItem('original', 100))
    const loaded = await repository.findByUuidAndUserUuid(itemUuid, userUuid.value)
    expect(loaded).not.toBeNull()

    const changed = loaded as Item
    changed.props.userUuid = Uuid.create('00000000-0000-0000-0000-000000000003').getValue()
    changed.props.content = 'updated-content'
    changed.props.timestamps = Timestamps.create(100, 200).getValue()
    changed.props.dates = Dates.create(new Date(1), new Date(200)).getValue()

    await repository.update(changed, { userUuid: userUuid.value, updatedAtTimestamp: 100 })

    const persisted = await repository.findByUuidAndUserUuid(itemUuid, userUuid.value)
    expect(persisted?.props.content).toBe('updated-content')
    expect(persisted?.props.userUuid.value).toBe(userUuid.value)
    expect(await repository.findByUuidAndUserUuid(itemUuid, '00000000-0000-0000-0000-000000000003')).toBeNull()
  })
})
