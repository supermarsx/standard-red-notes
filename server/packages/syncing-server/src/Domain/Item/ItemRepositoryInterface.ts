import { Uuid } from '@standardnotes/domain-core'

import { Item } from './Item'
import { ItemQuery } from './ItemQuery'
import { ExtendedIntegrityPayload } from './ExtendedIntegrityPayload'
import { ItemContentSizeDescriptor } from './ItemContentSizeDescriptor'
import { ItemStorageUsage } from './ItemStorageUsage'

export interface ItemRepositoryInterface {
  deleteByUserUuidAndNotInSharedVault(userUuid: Uuid): Promise<void>
  deleteByUserUuidInSharedVaults(userUuid: Uuid, sharedVaultUuids: Uuid[]): Promise<void>
  findAll(query: ItemQuery): Promise<Item[]>
  countAll(query: ItemQuery): Promise<number>
  findContentSizeForComputingTransferLimit(query: ItemQuery): Promise<Array<ItemContentSizeDescriptor>>
  sumContentSizeForComputingTransferLimit(query: ItemQuery): Promise<number>
  /**
   * Standard Red Notes: the account's own stored item payload, DERIVED from
   * `content_size` at read time rather than kept in a counter beside it.
   *
   * Deliberately NOT expressed through `sumContentSizeForComputingTransferLimit`:
   * that one answers `0` both for an empty account and for an account whose rows
   * all predate the `content_size` column, and a storage report must never merge
   * those. This one reports the measured bytes, how many rows produced them and
   * how many rows carry no size at all, so the caller can say which it was.
   */
  getStorageUsageForUser(userUuid: Uuid): Promise<ItemStorageUsage>
  /**
   * Standard Red Notes: the same measurement as above for a PAGE of accounts, in
   * one statement.
   *
   * *** THIS EXISTS BECAUSE THE SINGLE-ACCOUNT FORM COULD NOT BE REPORTED BY AN
   * ADMIN. *** `getStorageUsageForUser` is reachable only through a self-scoped
   * route, so the admin users list carried uploaded FILE bytes and nothing else
   * and a per-account SPACE report existed for the signed-in operator alone. A
   * list that called the single-account form once per row would be an N+1 over a
   * page of up to 1500 users; one `GROUP BY` is bounded the way the auth list's
   * batched enrichment already is.
   *
   * *** THE MAP IS SPARSE AND THE CALLER MUST FILL IT. *** `GROUP BY` produces no
   * group for an account with no rows, so an account holding nothing is simply
   * ABSENT from the result. That absence is a complete, true zero on this server
   * (there is no users table here to disagree with), and naming it in the caller
   * rather than inventing rows here keeps the one place that decides what an
   * absent figure means next to the report that prints it.
   */
  getStorageUsageForUsers(userUuids: Uuid[]): Promise<Map<string, ItemStorageUsage>>
  findDatesForComputingIntegrityHash(userUuid: string): Promise<Array<{ updated_at_timestamp: number }>>
  findItemsForComputingIntegrityPayloads(userUuid: string): Promise<ExtendedIntegrityPayload[]>
  findByUuidAndUserUuid(uuid: string, userUuid: string): Promise<Item | null>
  findByUuid(uuid: Uuid): Promise<Item | null>
  remove(item: Item): Promise<void>
  removeByUuid(uuid: Uuid): Promise<void>
  insert(item: Item): Promise<void>
  update(item: Item, expected: { userUuid: string; updatedAtTimestamp: number }): Promise<void>
  /**
   * Standard Red Notes: `userUuid` is REQUIRED, and third rather than optional
   * so that a caller which has not established whose rows these are cannot
   * compile. The implementation empties `content`, `enc_item_key` and
   * `auth_hash` in the same statement that flags the rows, so a uuid list
   * crossing an account boundary is data loss and not a visibility bug.
   */
  markItemsAsDeleted(itemUuids: Array<string>, updatedAtTimestamp: number, userUuid: Uuid): Promise<void>
  updateContentSize(itemUuid: string, contentSize: number): Promise<void>
  unassignFromSharedVault(sharedVaultUuid: Uuid): Promise<void>
  updateSharedVaultOwner(dto: { sharedVaultUuid: Uuid; fromOwnerUuid: Uuid; toOwnerUuid: Uuid }): Promise<void>
}
