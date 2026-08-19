import { Result, SharedVaultUserPermission, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { createHash } from 'node:crypto'

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
 * An allow result carries the exact canonical server updated-at revision read
 * from the same item used for access control. The client uses that revision as
 * a freshness barrier before an elected first editor may seed an empty Y.Doc.
 * Denials never disclose the revision. Any thrown error propagates as
 * Result.fail so callers FAIL CLOSED.
 */
export type CollaborationAccessAuthorization =
  { authorized: false } | { authorized: true; serverUpdatedAtTimestamp: number; collaborationSecurityEpoch: string }

export class AuthorizeCollaborationAccess implements UseCaseInterface<CollaborationAccessAuthorization> {
  constructor(
    private itemRepository: ItemRepositoryInterface,
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
  ) {}

  async execute(dto: AuthorizeCollaborationAccessDTO): Promise<Result<CollaborationAccessAuthorization>> {
    if (dto.readOnlyAccess) {
      return Result.ok({ authorized: false })
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
      return Result.ok({ authorized: false })
    }
    if (item.props.deleted) {
      return Result.ok({ authorized: false })
    }

    const sharedVaultUuid = item.sharedVaultUuid
    if (sharedVaultUuid === null) {
      // Personal notes are accessible only to their owner. The read-only
      // session restriction was applied before the item lookup.
      return Result.ok(
        item.props.userUuid.equals(userUuid)
          ? {
              authorized: true,
              serverUpdatedAtTimestamp: item.props.timestamps.updatedAt,
              collaborationSecurityEpoch: collaborationSecurityEpoch({
                scope: 'personal',
                ownerUuid: item.props.userUuid.toString(),
                itemsKeyId: item.props.itemsKeyId,
                keySystemIdentifier: item.props.keySystemAssociation?.props.keySystemIdentifier ?? null,
              }),
            }
          : { authorized: false },
      )
    }

    // Shared-vault writes always follow the user's current vault permission,
    // even if this account originally created the item.
    const membership = await this.sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid({
      userUuid,
      sharedVaultUuid,
    })

    if (membership === null) {
      return Result.ok({ authorized: false })
    }

    const permission = membership.props.permission.value

    const authorized =
      permission === SharedVaultUserPermission.PERMISSIONS.Write ||
      permission === SharedVaultUserPermission.PERMISSIONS.Admin
    if (!authorized) {
      return Result.ok({ authorized: false })
    }

    const memberships = await this.sharedVaultUserRepository.findBySharedVaultUuid(sharedVaultUuid)
    const membershipSecurityState = memberships
      .map((member) => ({
        userUuid: member.props.userUuid.toString(),
        permission: member.props.permission.value,
        updatedAt: member.props.timestamps.updatedAt,
        designatedSurvivor: member.props.isDesignatedSurvivor,
      }))
      .sort((left, right) =>
        `${left.userUuid}:${left.permission}`.localeCompare(`${right.userUuid}:${right.permission}`),
      )

    return Result.ok({
      authorized: true,
      serverUpdatedAtTimestamp: item.props.timestamps.updatedAt,
      collaborationSecurityEpoch: collaborationSecurityEpoch({
        scope: 'shared-vault',
        sharedVaultUuid: sharedVaultUuid.toString(),
        itemsKeyId: item.props.itemsKeyId,
        keySystemIdentifier: item.props.keySystemAssociation?.props.keySystemIdentifier ?? null,
        memberships: membershipSecurityState,
      }),
    })
  }
}

/**
 * Opaque, deterministic security generation for a collaboration room. It
 * intentionally excludes the note's normal updated-at revision, so ordinary
 * edits do not evict peers, while key or shared-vault membership changes do.
 * Only the digest crosses service boundaries; raw membership identifiers never
 * enter a capability or a gateway log.
 */
function collaborationSecurityEpoch(state: object): string {
  return createHash('sha256').update(JSON.stringify(state), 'utf8').digest('base64url')
}
