import { Result, SharedVaultUserPermission, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { AuthorizeCollaborationAccessDTO } from './AuthorizeCollaborationAccessDTO'

/**
 * Standard Red Notes: decide whether `userUuid` may collaborate on the note
 * (item) `itemUuid` over the realtime gateway relay. This is the SINGLE source
 * of truth the collaboration-room capability is minted from, and it reuses the
 * exact same write-access rules the sync layer enforces:
 *
 *   - read-only sessions and read-scoped MCP sessions are denied;
 *   - the OWNER of a personal note may access it; OR
 *   - if the note is associated with a shared vault, every user (including the
 *     item creator) must currently have WRITE or ADMIN permission for that
 *     vault. A creator later downgraded to READ must not bypass the live-write
 *     policy through item ownership.
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
    if (dto.readOnlyAccess) {
      return Result.ok(false)
    }

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

    const sharedVaultUuid = item.sharedVaultUuid
    if (sharedVaultUuid === null) {
      // Personal notes are accessible only to their owner. The read-only
      // session restriction was applied before the item lookup.
      return Result.ok(item.props.userUuid.equals(userUuid))
    }

    // Shared-vault writes always follow the user's current vault permission,
    // even if this account originally created the item.
    const membership = await this.sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid({
      userUuid,
      sharedVaultUuid,
    })

    if (membership === null) {
      return Result.ok(false)
    }

    const permission = membership.props.permission.value

    return Result.ok(
      permission === SharedVaultUserPermission.PERMISSIONS.Write ||
        permission === SharedVaultUserPermission.PERMISSIONS.Admin,
    )
  }
}
