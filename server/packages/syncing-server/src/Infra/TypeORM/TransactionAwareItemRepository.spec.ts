import { EntityManager } from 'typeorm'
import { Logger } from 'winston'

import { Item } from '../../Domain/Item/Item'
import { ItemRepositoryInterface } from '../../Domain/Item/ItemRepositoryInterface'
import { SQLItem } from './SQLItem'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { TransactionAwareItemRepository } from './TransactionAwareItemRepository'

describe('TransactionAwareItemRepository', () => {
  const item = {} as Item
  let baseRepository: jest.Mocked<ItemRepositoryInterface>
  let transactionContext: SyncCommandTransactionContext
  let ormRepository: { insert: jest.Mock; createQueryBuilder: jest.Mock }
  let manager: EntityManager
  let mapper: { toProjection: jest.Mock; toDomain: jest.Mock }
  let queryBuilder: Record<string, jest.Mock>

  const createRepository = () =>
    new TransactionAwareItemRepository(baseRepository, transactionContext, mapper, {
      error: jest.fn(),
    } as unknown as Logger)

  beforeEach(() => {
    baseRepository = {
      insert: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<ItemRepositoryInterface>
    transactionContext = new SyncCommandTransactionContext()
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    ormRepository = {
      insert: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    }
    manager = {
      getRepository: jest.fn().mockReturnValue(ormRepository),
    } as unknown as EntityManager
    mapper = {
      toProjection: jest.fn().mockReturnValue({ uuid: 'item-1', userUuid: 'user-1', content: 'ciphertext' }),
      toDomain: jest.fn(),
    }
  })

  it('keeps legacy item writes on the original repository outside a command', async () => {
    await createRepository().insert(item)

    expect(baseRepository.insert).toHaveBeenCalledWith(item)
    expect(manager.getRepository).not.toHaveBeenCalled()
  })

  it('routes inserts and optimistic updates through the active transaction EntityManager', async () => {
    const repository = createRepository()

    await transactionContext.run(manager, async () => {
      await repository.insert(item)
      await repository.update(item, { userUuid: 'user-1', updatedAtTimestamp: 123 })
    })

    expect(manager.getRepository).toHaveBeenCalledWith(SQLItem)
    expect(ormRepository.insert).toHaveBeenCalledWith(mapper.toProjection.mock.results[0].value)
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('updated_at_timestamp = :expectedUpdatedAtTimestamp', {
      expectedUpdatedAtTimestamp: 123,
    })
    expect(baseRepository.insert).not.toHaveBeenCalled()
    expect(baseRepository.update).not.toHaveBeenCalled()
    expect(transactionContext.manager).toBeUndefined()
  })

  it('restores context after an in-transaction repository failure', async () => {
    ormRepository.insert.mockRejectedValue(new Error('write failed'))

    await expect(
      transactionContext.run(manager, async () => {
        await createRepository().insert(item)
      }),
    ).rejects.toThrow('write failed')
    expect(transactionContext.manager).toBeUndefined()
  })
})
