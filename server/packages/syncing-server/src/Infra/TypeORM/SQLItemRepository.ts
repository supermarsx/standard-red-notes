import { Repository, SelectQueryBuilder } from 'typeorm'
import { safeErrorLogMetadata, MapperInterface, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { Item } from '../../Domain/Item/Item'
import { ItemQuery } from '../../Domain/Item/ItemQuery'
import { ItemRepositoryInterface } from '../../Domain/Item/ItemRepositoryInterface'
import { ExtendedIntegrityPayload } from '../../Domain/Item/ExtendedIntegrityPayload'
import { ItemContentSizeDescriptor } from '../../Domain/Item/ItemContentSizeDescriptor'
import { ItemStorageUsage } from '../../Domain/Item/ItemStorageUsage'
import { ConcurrentItemUpdateError } from '../../Domain/Item/ConcurrentItemUpdateError'
import { ITEM_MAPPABILITY_COLUMNS, parseItemProjection } from '../../Mapping/Persistence/SQLItemProjectionParser'
import { SQLItem } from './SQLItem'

export class SQLItemRepository implements ItemRepositoryInterface {
  constructor(
    protected ormRepository: Repository<SQLItem>,
    protected mapper: MapperInterface<Item, SQLItem>,
    protected logger: Logger,
  ) {}

  async deleteByUserUuidInSharedVaults(userUuid: Uuid, sharedVaultUuids: Uuid[]): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .delete()
      .from('items')
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .andWhere('shared_vault_uuid IN (:...sharedVaultUuids)', {
        sharedVaultUuids: sharedVaultUuids.map((uuid) => uuid.value),
      })
      .execute()
  }

  async deleteByUserUuidAndNotInSharedVault(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .delete()
      .from('items')
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .andWhere('shared_vault_uuid IS NULL')
      .execute()
  }

  async updateSharedVaultOwner(dto: { sharedVaultUuid: Uuid; fromOwnerUuid: Uuid; toOwnerUuid: Uuid }): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .update()
      .set({
        userUuid: dto.toOwnerUuid.value,
      })
      .where('user_uuid = :fromOwnerUuid AND shared_vault_uuid = :sharedVaultUuid', {
        fromOwnerUuid: dto.fromOwnerUuid.value,
        sharedVaultUuid: dto.sharedVaultUuid.value,
      })
      .execute()
  }

  async unassignFromSharedVault(sharedVaultUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .update()
      .set({
        sharedVaultUuid: null,
      })
      .where('shared_vault_uuid = :sharedVaultUuid', {
        sharedVaultUuid: sharedVaultUuid.value,
      })
      .execute()
  }

  async removeByUuid(uuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .delete()
      .from('items')
      .where('uuid = :uuid', { uuid: uuid.value })
      .execute()
  }

  async insert(item: Item): Promise<void> {
    const projection = this.mapper.toProjection(item)

    await this.ormRepository.insert(projection)
  }

  async update(item: Item, expected: { userUuid: string; updatedAtTimestamp: number }): Promise<void> {
    const projection = this.mapper.toProjection(item)

    const { uuid, userUuid: _userUuid, ...updateValues } = projection

    const result = await this.ormRepository
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

    const serverItem = await this.findByUuidAndUserUuidOnPrimary(uuid, expected.userUuid)
    if (serverItem) {
      throw new ConcurrentItemUpdateError(serverItem)
    }

    throw new Error(`Item ${uuid} disappeared before it could be updated`)
  }

  private async findByUuidAndUserUuidOnPrimary(uuid: string, userUuid: string): Promise<Item | null> {
    const queryRunner = this.ormRepository.manager.dataSource.createQueryRunner('master')
    await queryRunner.connect()

    try {
      const persistence = await queryRunner.manager
        .getRepository(SQLItem)
        .createQueryBuilder('item')
        .where('item.uuid = :uuid AND item.user_uuid = :userUuid', { uuid, userUuid })
        .getOne()

      if (persistence === null) {
        return null
      }

      try {
        return this.mapper.toDomain(persistence)
      } catch (error) {
        this.logger.error(
          `Failed to map item ${uuid} for user ${persistence.userUuid} after a concurrent update.`,
          safeErrorLogMetadata(error),
        )

        return null
      }
    } finally {
      await queryRunner.release()
    }
  }

  async remove(item: Item): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(item))
  }

  async updateContentSize(itemUuid: string, contentSize: number): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .update()
      .set({
        contentSize,
      })
      .where('uuid = :itemUuid', {
        itemUuid,
      })
      .execute()
  }

  async findContentSizeForComputingTransferLimit(query: ItemQuery): Promise<ItemContentSizeDescriptor[]> {
    const queryBuilder = this.createFindAllQueryBuilder(query)
    queryBuilder.select('item.uuid', 'uuid')
    queryBuilder.addSelect('item.content_size', 'contentSize')

    const items = await queryBuilder.getRawMany()

    const itemContentSizeDescriptors: ItemContentSizeDescriptor[] = []
    for (const item of items) {
      const ItemContentSizeDescriptorOrError = ItemContentSizeDescriptor.create(item.uuid, item.contentSize)
      if (ItemContentSizeDescriptorOrError.isFailed()) {
        this.logger.error(
          `Failed to create ItemContentSizeDescriptor for item ${item.uuid}.`,
          safeErrorLogMetadata(ItemContentSizeDescriptorOrError.getError()),
        )
        continue
      }
      itemContentSizeDescriptors.push(ItemContentSizeDescriptorOrError.getValue())
    }

    return itemContentSizeDescriptors
  }

  async sumContentSizeForComputingTransferLimit(query: ItemQuery): Promise<number> {
    const queryBuilder = this.createFindAllQueryBuilder(query)
    queryBuilder.select('SUM(item.content_size)', 'total')

    const result = await queryBuilder.getRawOne<{ total: string | number | null }>()

    if (!result || result.total === null || result.total === undefined) {
      return 0
    }

    return +result.total
  }

  /**
   * Standard Red Notes: the account's stored item payload, in ONE aggregate pass.
   *
   * *** THE TWO COUNTS ARE THE WHOLE POINT, AND THE SUM IS NOT. *** A bare
   * `SUM(content_size)` cannot tell "this account stores nothing" from "every one
   * of this account's rows predates the content_size column", because SQL answers
   * NULL for both an empty set and a set of NULLs. Counting the sized and the
   * unsized rows separately in the same statement makes those two different
   * answers, at no extra round trip, and it is the difference between reporting a
   * true `0 MB` and inventing one.
   *
   * The sum itself needs no `CASE`: SUM already skips NULLs, so guarding them
   * would be a branch that cannot change the answer. One was written here and a
   * mutation proved it inert — present, passing and incapable of being wrong,
   * which is the shape this pane spends its whole existence refusing. It is gone,
   * and the discrimination lives entirely in the two counts beside it.
   *
   * Scope is the user's OWN non-deleted items: no `includeSharedVaultUuids`, so a
   * vault another account owns is that account's storage and not this one's, and
   * `deleted = false` so a soft-deleted row is out (its `content_size` is zeroed
   * on deletion as well, which is why deletion shows up here twice over).
   *
   * Both `CASE` forms and `COALESCE` are standard SQL and behave identically on
   * the two dialects this server ships with (MySQL and SQLite).
   */
  async getStorageUsageForUser(userUuid: Uuid): Promise<ItemStorageUsage> {
    const raw = await this.ormRepository
      .createQueryBuilder('item')
      .select('COALESCE(SUM(item.content_size), 0)', 'sizedBytes')
      .addSelect('COALESCE(SUM(CASE WHEN item.content_size IS NULL THEN 0 ELSE 1 END), 0)', 'sizedItems')
      .addSelect('COALESCE(SUM(CASE WHEN item.content_size IS NULL THEN 1 ELSE 0 END), 0)', 'unsizedItems')
      .where('item.user_uuid = :userUuid', { userUuid: userUuid.value })
      .andWhere('item.deleted = :deleted', { deleted: false })
      .getRawOne<{
        sizedBytes: string | number | null
        sizedItems: string | number | null
        unsizedItems: string | number | null
      }>()

    return {
      sizedBytes: this.wholeNonNegative(raw?.sizedBytes),
      sizedItems: this.wholeNonNegative(raw?.sizedItems),
      unsizedItems: this.wholeNonNegative(raw?.unsizedItems),
    }
  }

  /**
   * A driver's aggregate comes back as a string on MySQL and a number on SQLite,
   * and as `null`/`undefined` for an empty set. Anything that is not a finite,
   * non-negative number becomes 0 — which is correct here and only here, because
   * every one of these three fields is a COUNT or a COALESCEd sum over a scope
   * whose emptiness is itself reported by `sizedItems`/`unsizedItems`.
   */
  private wholeNonNegative(value: string | number | null | undefined): number {
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
    return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }

  async findByUuid(uuid: Uuid): Promise<Item | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('item')
      .where('item.uuid = :uuid', {
        uuid: uuid.value,
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    try {
      const item = this.mapper.toDomain(persistence)

      return item
    } catch (error) {
      this.logger.error(
        `Failed to map item ${uuid.value} for user ${persistence.userUuid} by uuid.`,
        safeErrorLogMetadata(error),
      )

      return null
    }
  }

  async findDatesForComputingIntegrityHash(userUuid: string): Promise<Array<{ updated_at_timestamp: number }>> {
    const rows = await this.findDeliverableRowsForReporting(userUuid)

    return rows
      .map((row) => ({ updated_at_timestamp: row.updatedAtTimestamp }))
      .sort((itemA, itemB) => itemB.updated_at_timestamp - itemA.updated_at_timestamp)
  }

  async findItemsForComputingIntegrityPayloads(userUuid: string): Promise<ExtendedIntegrityPayload[]> {
    const rows = await this.findDeliverableRowsForReporting(userUuid)

    return rows
      .map((row) => ({
        uuid: row.uuid,
        updated_at_timestamp: row.updatedAtTimestamp,
        content_type: row.contentType,
      }))
      .sort((itemA, itemB) => itemB.updated_at_timestamp - itemA.updated_at_timestamp)
  }

  /**
   * Standard Red Notes: NOTHING MAY BE REPORTED THAT CANNOT BE DELIVERED.
   *
   * Both readers above answer "what does the server hold for this account?", and
   * a client compares that answer against its own store and then asks for
   * whatever is missing. Those two questions used to be answered by different
   * code: these readers took three columns of raw SQL and mapped nothing, while
   * the fetch paths build a domain `Item` and drop — with a log line and nothing
   * else — any row the mapper refuses. A row in that gap is reported forever and
   * delivered never, and a client's only remedy, syncing again, reproduces it
   * exactly. The repo has already learned that reliable pushes turn a rare race
   * into a frequent one, so this is not costed as rare: every integrity check
   * from every device of that account spends a full fetch round trip on a row
   * none of them can ever store.
   *
   * So both readers now consult `parseItemProjection`, which IS the fetch path's
   * decision rather than a copy of it, and a row that fails it is excluded here
   * and named in the log so an operator can repair it. Exclusion loses nothing a
   * client could have had: the fetch paths were never able to deliver these rows.
   *
   * The select carries `ITEM_MAPPABILITY_COLUMNS` — every column a mapping
   * decision reads and no more, so an account's `content` is not pulled through
   * an integrity check. `getMany()` and not `getRawMany()` on purpose: the
   * entity hydration is what turns a driver's datetime into a `Date` and a
   * `tinyint` into a boolean, and the fetch path decides on hydrated rows, so a
   * raw read would answer the question about different values than the ones
   * `findAll` will see.
   */
  private async findDeliverableRowsForReporting(userUuid: string): Promise<SQLItem[]> {
    const rows = await this.ormRepository
      .createQueryBuilder('item')
      .select(ITEM_MAPPABILITY_COLUMNS.map((column) => `item.${column}`))
      .where('item.user_uuid = :userUuid', { userUuid: userUuid })
      .andWhere('item.deleted = :deleted', { deleted: false })
      .getMany()

    return rows.filter((row) => {
      const partsOrError = parseItemProjection(row)
      if (partsOrError.isFailed()) {
        this.logger.error(
          `Withheld unmappable item ${row.uuid} for user ${userUuid} from integrity reporting, ` +
            `because no sync can deliver it: ${partsOrError.getError()}`,
        )

        return false
      }

      return true
    })
  }

  async findByUuidAndUserUuid(uuid: string, userUuid: string): Promise<Item | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('item')
      .where('item.uuid = :uuid AND item.user_uuid = :userUuid', {
        uuid,
        userUuid,
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    try {
      const item = this.mapper.toDomain(persistence)

      return item
    } catch (error) {
      this.logger.error(
        `Failed to map item ${uuid} for user ${persistence.userUuid} by uuid and userUuid.`,
        safeErrorLogMetadata(error),
      )

      return null
    }
  }

  async findAll(query: ItemQuery): Promise<Item[]> {
    const persistence = await this.createFindAllQueryBuilder(query).getMany()

    const domainItems: Item[] = []
    for (const persistencItem of persistence) {
      try {
        domainItems.push(this.mapper.toDomain(persistencItem))
      } catch (error) {
        this.logger.error(
          `Failed to map item ${persistencItem.uuid} for user ${persistencItem.userUuid} to domain.`,
          safeErrorLogMetadata(error),
        )
      }
    }

    return domainItems
  }

  async countAll(query: ItemQuery): Promise<number> {
    return this.createFindAllQueryBuilder(query).getCount()
  }

  /**
   * Standard Red Notes: A BULK WRITE NEEDS AN OWNER, NOT JUST A LIST OF UUIDS.
   *
   * This nulls `content`, `enc_item_key` and `auth_hash` as well as flagging the
   * row, so a uuid that reaches it by mistake is not merely hidden, it is
   * emptied. Keyed on `uuid IN (...)` alone, one foreign uuid anywhere in a list
   * assembled from one account's input destroys another account's item, and no
   * caller can hold that invariant on its own. `userUuid` is required rather
   * than optional for that reason: a caller that does not know whose rows these
   * are has no business running this statement.
   *
   * The predicate is positive (`user_uuid = :userUuid`) and not a negation, so a
   * row whose `user_uuid` is NULL — the column is nullable in the MySQL schema
   * this ships with — matches nothing and is left untouched. That is the safe
   * direction for a statement that erases content: a row this server cannot
   * attribute is a row it must not empty.
   */
  async markItemsAsDeleted(itemUuids: Array<string>, updatedAtTimestamp: number, userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder('item')
      .update()
      .set({
        deleted: true,
        content: null,
        encItemKey: null,
        authHash: null,
        updatedAtTimestamp,
      })
      .where('uuid IN (:...uuids)', {
        uuids: itemUuids,
      })
      .andWhere('user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .execute()
  }

  protected createFindAllQueryBuilder(query: ItemQuery): SelectQueryBuilder<SQLItem> {
    const queryBuilder = this.ormRepository.createQueryBuilder('item')

    if (query.sortBy !== undefined && query.sortOrder !== undefined) {
      queryBuilder.orderBy(`item.${query.sortBy}`, query.sortOrder)

      // A timestamp is not unique. Without the UUID tie breaker, a page ending
      // inside a group of equal timestamps can return the same rows forever.
      // Keep every timestamp-ordered query deterministic so descriptor and item
      // fetches agree on the exact page boundary.
      if (query.sortBy === 'updated_at_timestamp') {
        queryBuilder.addOrderBy('item.uuid', query.sortOrder)
      }
    }

    if (query.includeSharedVaultUuids !== undefined && query.includeSharedVaultUuids.length > 0) {
      if (query.userUuid) {
        queryBuilder.where('(item.user_uuid = :userUuid OR item.shared_vault_uuid IN (:...includeSharedVaultUuids))', {
          userUuid: query.userUuid,
          includeSharedVaultUuids: query.includeSharedVaultUuids,
        })
      } else {
        queryBuilder.where('item.shared_vault_uuid IN (:...includeSharedVaultUuids)', {
          includeSharedVaultUuids: query.includeSharedVaultUuids,
        })
      }
    } else if (query.exclusiveSharedVaultUuids !== undefined && query.exclusiveSharedVaultUuids.length > 0) {
      queryBuilder.where('item.shared_vault_uuid IN (:...exclusiveSharedVaultUuids)', {
        exclusiveSharedVaultUuids: query.exclusiveSharedVaultUuids,
      })
    } else if (query.userUuid !== undefined) {
      queryBuilder.where('item.user_uuid = :userUuid', { userUuid: query.userUuid })
    }

    if (query.uuids && query.uuids.length > 0) {
      queryBuilder.andWhere('item.uuid IN (:...uuids)', { uuids: query.uuids })
    }
    if (query.deleted !== undefined) {
      queryBuilder.andWhere('item.deleted = :deleted', { deleted: query.deleted })
    }
    if (query.contentType) {
      if (Array.isArray(query.contentType)) {
        queryBuilder.andWhere('item.content_type IN (:...contentTypes)', { contentTypes: query.contentType })
      } else {
        queryBuilder.andWhere('item.content_type = :contentType', { contentType: query.contentType })
      }
    }
    if (query.lastSyncTime !== undefined && query.syncTimeComparison) {
      if (query.lastSyncUuid !== undefined) {
        const keysetComparison = query.sortOrder === 'DESC' ? '<' : '>'
        queryBuilder.andWhere(
          `(item.updated_at_timestamp ${keysetComparison} :lastSyncTime OR ` +
            `(item.updated_at_timestamp = :lastSyncTime AND item.uuid ${keysetComparison} :lastSyncUuid))`,
          {
            lastSyncTime: query.lastSyncTime,
            lastSyncUuid: query.lastSyncUuid,
          },
        )
      } else {
        queryBuilder.andWhere(`item.updated_at_timestamp ${query.syncTimeComparison} :lastSyncTime`, {
          lastSyncTime: query.lastSyncTime,
        })
      }
    }
    // Standard Red Notes (t99): the own-write skip. Applied here so the three
    // reads that share this builder — the content-size descriptors, the page
    // itself and the more-items count — agree on exactly one page boundary; a
    // predicate on only one of them would make the cursor and the page disagree.
    // A NULL `updated_with_session` never matches, so a topology that does not
    // populate the column re-delivers instead of withholding.
    if (query.excludeUpdatedWithSession !== undefined && query.excludeUpdatedWithSessionUpToTimestamp !== undefined) {
      // Spelled out rather than as NOT(...): in SQL a NULL `updated_with_session`
      // makes the inner conjunction NULL and `NOT NULL` is NULL, so the NOT form
      // would DROP exactly the rows this skip must never touch.
      queryBuilder.andWhere(
        '(item.updated_with_session IS NULL OR item.updated_with_session != :excludeUpdatedWithSession OR ' +
          'item.updated_at_timestamp > :excludeUpdatedWithSessionUpToTimestamp)',
        {
          excludeUpdatedWithSession: query.excludeUpdatedWithSession,
          excludeUpdatedWithSessionUpToTimestamp: query.excludeUpdatedWithSessionUpToTimestamp,
        },
      )
    }
    if (query.createdBetween !== undefined) {
      queryBuilder.andWhere('item.created_at >= :createdAfter AND item.created_at <= :createdBefore', {
        createdAfter: query.createdBetween[0].toISOString(),
        createdBefore: query.createdBetween[1].toISOString(),
      })
    }
    if (query.offset !== undefined) {
      queryBuilder.skip(query.offset)
    }
    if (query.limit !== undefined) {
      queryBuilder.take(query.limit)
    }

    return queryBuilder
  }
}
