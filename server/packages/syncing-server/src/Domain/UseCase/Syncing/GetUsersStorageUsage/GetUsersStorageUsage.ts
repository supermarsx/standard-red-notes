import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GetUsersStorageUsageDTO } from './GetUsersStorageUsageDTO'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { UserItemStorageUsage } from './UserItemStorageUsage'

/**
 * Standard Red Notes: how much SERVER storage EACH of several accounts' synced
 * items occupy — the per-account half of the space report that an administrator
 * could not previously get for anybody but themselves.
 *
 * *** WHY A SECOND USE CASE RATHER THAN A LOOP. *** `GetUserStorageUsage` answers
 * for one account and is the right shape for the self-scoped route. An admin users
 * list asks about a PAGE — up to 1500 accounts — and calling the single-account
 * form once per row is the N+1 the auth list's batched enrichment was written to
 * avoid. The measurement itself is not re-derived here: the repository's batched
 * aggregate uses the single-account form's grouping, filter and NULL handling
 * verbatim, and a spec holds the two to the same answer for one account so this
 * cannot become a second, divergent definition of "stored bytes".
 *
 * *** EVERY REQUESTED ACCOUNT COMES BACK, IN THE ORDER IT WAS ASKED ABOUT. *** The
 * repository's `GROUP BY` emits nothing for an account with no items, and a caller
 * handed a short list would have to guess which of its subjects were missing and
 * why. On this server an absent group has exactly one meaning — no non-deleted
 * rows belong to that uuid — and `{0, 0, 0}` is the one case in which zero is a
 * complete, true answer (see `ItemStorageUsage`). It is filled in here, once,
 * rather than at each reader.
 *
 * *** A MALFORMED UUID FAILS THE WHOLE CALL. *** Dropping it would answer with a
 * list shorter than the one asked for and no indication of which subject was
 * discarded — the flattering direction, and the direction that lets a caller
 * mis-key a report without ever being told.
 */
export class GetUsersStorageUsage implements UseCaseInterface<UserItemStorageUsage[]> {
  constructor(private itemRepository: ItemRepositoryInterface) {}

  async execute(dto: GetUsersStorageUsageDTO): Promise<Result<UserItemStorageUsage[]>> {
    const userUuids: Uuid[] = []
    for (const candidate of dto.userUuids) {
      const userUuidOrError = Uuid.create(candidate)
      if (userUuidOrError.isFailed()) {
        return Result.fail(userUuidOrError.getError())
      }
      userUuids.push(userUuidOrError.getValue())
    }

    const usages = await this.itemRepository.getStorageUsageForUsers(userUuids)

    return Result.ok(
      userUuids.map((userUuid) => ({
        userUuid: userUuid.value,
        ...(usages.get(userUuid.value) ?? { sizedBytes: 0, sizedItems: 0, unsizedItems: 0 }),
      })),
    )
  }
}
