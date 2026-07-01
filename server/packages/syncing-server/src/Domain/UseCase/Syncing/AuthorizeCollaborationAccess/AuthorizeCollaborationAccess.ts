import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { AuthorizeCollaborationAccessDTO } from './AuthorizeCollaborationAccessDTO'

/**
 * Standard Red Notes: decide whether `userUuid` may collaborate on the note
 * (item) `itemUuid` over the realtime gateway relay. This is the SINGLE source
 * of truth the collaboration-room capability is minted from, and it reuses the
 * exact same access rules the sync layer enforces:
 *
 *   - the note's OWNER (item.user_uuid === userUuid) may always access it; OR
 *   - if the note is associated with a shared vault, the user must be a MEMBER
 *     of that shared vault (same intersection GetItems performs between the
 *     note's shared_vault_uuid and the user's vault memberships).
 *
 * Returns Result.ok(true) only when access is proven; Result.ok(false) for a
 * definitively-not-authorized case (item missing / not a member). Any thrown
 * error propagates as Result.fail so callers FAIL CLOSED.
 */
export class AuthorizeCollaborationAccess implements UseCaseInterface<boolean> {
  constructor(
    private itemRepository: ItemRepositoryInterface,
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
  ) {}

  async execute(dto: AuthorizeCollaborationAccessDTO): Promise<Result<boolean>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`User uuid is invalid: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const itemUuidOrError = Uuid.create(dto.itemUuid)
    if (itemUuidOrError.isFailed()) {
      return Result.fail(`Item uuid is invalid: ${itemUuidOrError.getError()}`)
    }
    const itemUuid = itemUuidOrError.getValue()

    const item = await this.itemRepository.findByUuid(itemUuid)
    if (item === null) {
      // Unknown note: deny. (A brand-new note not yet synced is owned locally and
      // does not need a relay room until it exists server-side.)
      return Result.ok(false)
    }

    // Owner always has access.
    if (item.props.userUuid.equals(userUuid)) {
      return Result.ok(true)
    }

    // Otherwise the note must live in a shared vault the user is a member of.
    const sharedVaultUuid = item.sharedVaultUuid
    if (sharedVaultUuid === null) {
      // A non-shared note owned by someone else: deny.
      return Result.ok(false)
    }

    const membership = await this.sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid({
      userUuid,
      sharedVaultUuid,
    })

    return Result.ok(membership !== null)
  }
}
