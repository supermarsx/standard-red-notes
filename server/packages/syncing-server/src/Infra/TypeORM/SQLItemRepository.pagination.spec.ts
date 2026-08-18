import { SQLItemRepository } from './SQLItemRepository'

describe('SQLItemRepository timestamp pagination', () => {
  const createRepository = () => {
    const queryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    }
    const ormRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    }
    const repository = new SQLItemRepository(ormRepository as never, {} as never, {} as never)

    return { repository, queryBuilder }
  }

  it('orders equal timestamps by UUID and applies an exclusive composite keyset boundary', async () => {
    const { repository, queryBuilder } = createRepository()

    await repository.findContentSizeForComputingTransferLimit({
      userUuid: '00000000-0000-0000-0000-000000000000',
      lastSyncTime: 123,
      lastSyncUuid: '11111111-1111-1111-1111-111111111111',
      syncTimeComparison: '>',
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      limit: 150,
    })

    expect(queryBuilder.orderBy).toHaveBeenCalledWith('item.updated_at_timestamp', 'ASC')
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('item.uuid', 'ASC')
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      '(item.updated_at_timestamp > :lastSyncTime OR ' +
        '(item.updated_at_timestamp = :lastSyncTime AND item.uuid > :lastSyncUuid))',
      {
        lastSyncTime: 123,
        lastSyncUuid: '11111111-1111-1111-1111-111111111111',
      },
    )
  })

  it('keeps the inclusive timestamp-only filter for a legacy cursor', async () => {
    const { repository, queryBuilder } = createRepository()

    await repository.findContentSizeForComputingTransferLimit({
      lastSyncTime: 123,
      syncTimeComparison: '>=',
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      limit: 150,
    })

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('item.updated_at_timestamp >= :lastSyncTime', {
      lastSyncTime: 123,
    })
  })
})
