import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GetUserStorageUsageDTO } from './GetUserStorageUsageDTO'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemStorageUsage } from '../../../Item/ItemStorageUsage'

/**
 * Standard Red Notes: how much SERVER storage this account's synced items occupy.
 *
 * *** WHY THIS EXISTS AT ALL. *** The admin diagnostics pane reported an account's
 * uploaded-FILE bytes and nothing else, so a vault of ten thousand notes and no
 * attachments read "0 MB used" — and the operator's complaint was precisely that
 * the pane does not report user storage usage. Notes ARE the storage; attachments
 * are usually the smaller half.
 *
 * *** DERIVED, NEVER COUNTED. *** There is no running total anywhere and this use
 * case does not create one. It aggregates `items.content_size`, which the write
 * paths already maintain inside the same transaction as the item itself:
 *
 *   - CREATE — `SaveNewItem` sets `contentSize` from the serialised item before
 *     the insert, and `Item`'s own constructor computes one for any item built
 *     without it.
 *   - UPDATE — `UpdateExistingItem` recomputes it on every save, before the update.
 *   - DELETE — `UpdateExistingItem` sets `contentSize = 0` AND `deleted = true` on
 *     a delete hash; this aggregate filters `deleted = false`, so a deletion drops
 *     out of the total twice over and cannot leave a residue behind.
 *   - HARD DELETE — account or vault removal deletes the rows, and a deleted row
 *     contributes nothing to an aggregate over the table.
 *
 * A parallel counter would have to be touched on all four and would drift
 * permanently the first time one of them was missed. An aggregate cannot drift:
 * there is nothing to keep in step. What it CAN be is stale in one direction only
 * — a row whose `content_size` is NULL because it predates the column — and that
 * is reported rather than folded into the sum. `FixContentSizes` is the existing
 * heal for exactly that, and the response says whether it is needed.
 *
 * *** WHAT IS DELIBERATELY NOT IN THE FIGURE. *** Revisions (note history) are a
 * different service with its own table and its own pruning schedule, and uploaded
 * files are bytes on the files service that this server never sees. Neither is
 * guessed at here. The caller composes the account total from this figure and the
 * file total it reads from auth, and reports which halves it had.
 */
export class GetUserStorageUsage implements UseCaseInterface<ItemStorageUsage> {
  constructor(private itemRepository: ItemRepositoryInterface) {}

  async execute(dto: GetUserStorageUsageDTO): Promise<Result<ItemStorageUsage>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }

    const usage = await this.itemRepository.getStorageUsageForUser(userUuidOrError.getValue())

    return Result.ok(usage)
  }
}
