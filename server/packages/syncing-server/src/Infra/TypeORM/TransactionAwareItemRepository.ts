import { MapperInterface, safeErrorLogMetadata, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { ExtendedIntegrityPayload } from '../../Domain/Item/ExtendedIntegrityPayload'
import { Item } from '../../Domain/Item/Item'
import { ItemContentSizeDescriptor } from '../../Domain/Item/ItemContentSizeDescriptor'
import { ItemQuery } from '../../Domain/Item/ItemQuery'
import { ItemRepositoryInterface } from '../../Domain/Item/ItemRepositoryInterface'
import { SQLItem } from './SQLItem'
import { SQLItemRepository } from './SQLItemRepository'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { ConcurrentItemUpdateError } from '../../Domain/Item/ConcurrentItemUpdateError'

/**
 * Routes every ItemRepository operation through the command transaction's
 * EntityManager when one is active. AsyncLocalStorage keeps concurrent request
 * scopes isolated; legacy requests continue using the original repository.
 */
export class TransactionAwareItemRepository implements ItemRepositoryInterface {
  constructor(
    private readonly baseRepository: ItemRepositoryInterface,
    private readonly transactionContext: SyncCommandTransactionContext,
    private readonly mapper: MapperInterface<Item, SQLItem>,
    private readonly logger: Logger,
  ) {}

  deleteByUserUuidAndNotInSharedVault(userUuid: Uuid): Promise<void> {
    return this.repository.deleteByUserUuidAndNotInSharedVault(userUuid)
  }

  deleteByUserUuidInSharedVaults(userUuid: Uuid, sharedVaultUuids: Uuid[]): Promise<void> {
    return this.repository.deleteByUserUuidInSharedVaults(userUuid, sharedVaultUuids)
  }

  findAll(query: ItemQuery): Promise<Item[]> {
    return this.repository.findAll(query)
  }

  countAll(query: ItemQuery): Promise<number> {
    return this.repository.countAll(query)
  }

  findContentSizeForComputingTransferLimit(query: ItemQuery): Promise<ItemContentSizeDescriptor[]> {
    return this.repository.findContentSizeForComputingTransferLimit(query)
  }

  sumContentSizeForComputingTransferLimit(query: ItemQuery): Promise<number> {
    return this.repository.sumContentSizeForComputingTransferLimit(query)
  }

  findDatesForComputingIntegrityHash(userUuid: string): Promise<Array<{ updated_at_timestamp: number }>> {
    return this.repository.findDatesForComputingIntegrityHash(userUuid)
  }

  findItemsForComputingIntegrityPayloads(userUuid: string): Promise<ExtendedIntegrityPayload[]> {
    return this.repository.findItemsForComputingIntegrityPayloads(userUuid)
  }

  findByUuidAndUserUuid(uuid: string, userUuid: string): Promise<Item | null> {
    return this.repository.findByUuidAndUserUuid(uuid, userUuid)
  }

  findByUuid(uuid: Uuid): Promise<Item | null> {
    return this.repository.findByUuid(uuid)
  }

  remove(item: Item): Promise<void> {
    return this.repository.remove(item)
  }

  removeByUuid(uuid: Uuid): Promise<void> {
    return this.repository.removeByUuid(uuid)
  }

  insert(item: Item): Promise<void> {
    return this.repository.insert(item)
  }

  async update(item: Item, expected: { userUuid: string; updatedAtTimestamp: number }): Promise<void> {
    const manager = this.transactionContext.manager
    if (!manager) {
      return this.baseRepository.update(item, expected)
    }

    const repository = manager.getRepository(SQLItem)
    const projection = this.mapper.toProjection(item)
    const { uuid, userUuid: _userUuid, ...updateValues } = projection
    const result = await repository
      .createQueryBuilder()
      .update()
      .set(updateValues)
      .where('uuid = :uuid', { uuid })
      .andWhere('user_uuid = :userUuid', { userUuid: expected.userUuid })
      .andWhere('updated_at_timestamp = :expectedUpdatedAtTimestamp', {
        expectedUpdatedAtTimestamp: expected.updatedAtTimestamp,
      })
      .execute()

    if (result.affected === 1) {
      return
    }

    const persistence = await repository
      .createQueryBuilder('item')
      .where('item.uuid = :uuid AND item.user_uuid = :userUuid', { uuid, userUuid: expected.userUuid })
      .getOne()
    if (persistence) {
      try {
        throw new ConcurrentItemUpdateError(this.mapper.toDomain(persistence))
      } catch (error) {
        if (error instanceof ConcurrentItemUpdateError) {
          throw error
        }
        this.logger.error(
          `Failed to map item ${uuid} for user ${persistence.userUuid} after a concurrent command update.`,
          safeErrorLogMetadata(error),
        )
      }
    }

    throw new Error(`Item ${uuid} disappeared before it could be updated`)
  }

  markItemsAsDeleted(itemUuids: string[], updatedAtTimestamp: number): Promise<void> {
    return this.repository.markItemsAsDeleted(itemUuids, updatedAtTimestamp)
  }

  updateContentSize(itemUuid: string, contentSize: number): Promise<void> {
    return this.repository.updateContentSize(itemUuid, contentSize)
  }

  unassignFromSharedVault(sharedVaultUuid: Uuid): Promise<void> {
    return this.repository.unassignFromSharedVault(sharedVaultUuid)
  }

  updateSharedVaultOwner(dto: { sharedVaultUuid: Uuid; fromOwnerUuid: Uuid; toOwnerUuid: Uuid }): Promise<void> {
    return this.repository.updateSharedVaultOwner(dto)
  }

  private get repository(): ItemRepositoryInterface {
    const manager = this.transactionContext.manager
    if (!manager) {
      return this.baseRepository
    }

    return new SQLItemRepository(manager.getRepository(SQLItem), this.mapper, this.logger)
  }
}
