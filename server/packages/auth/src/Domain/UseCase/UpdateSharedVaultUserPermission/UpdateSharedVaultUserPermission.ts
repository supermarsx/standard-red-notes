import { Result, SharedVaultUserPermission, Timestamps, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { UpdateSharedVaultUserPermissionDTO } from './UpdateSharedVaultUserPermissionDTO'

/**
 * Keeps auth's MIRROR of a shared-vault membership (`auth_shared_vault_users`) in step
 * with the syncing-server's row when a member's permission changes in place.
 *
 * This is not bookkeeping. `CreateCrossServiceToken` projects the mirror as
 * `belongs_to_shared_vaults[].permission`, and both file authorizers --
 * `ValetTokenFileResourceAuthorizer` on compose and
 * `CanonicalHomeServerFileResourceAuthorizer` on the bundled single container -- refuse
 * an UPLOAD outright when that value reads `read`. A promotion that never reached here
 * would therefore grant item writes while leaving shared-vault FILE uploads refused, with
 * nothing anywhere reporting a disagreement.
 *
 * It UPDATES the row it finds rather than creating one. `AddSharedVaultUser` mints a
 * fresh `UniqueEntityId` on every call, and `auth_shared_vault_users` has no unique index
 * on (user_uuid, shared_vault_uuid), so reusing it here would leave two rows for one
 * membership and `findByUserUuid` would project whichever the query happened to return
 * first -- a permission that flips between requests.
 */
export class UpdateSharedVaultUserPermission implements UseCaseInterface<void> {
  constructor(private sharedVaultUserRepository: SharedVaultUserRepositoryInterface) {}

  async execute(dto: UpdateSharedVaultUserPermissionDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const sharedVaultUuidOrError = Uuid.create(dto.sharedVaultUuid)
    if (sharedVaultUuidOrError.isFailed()) {
      return Result.fail(sharedVaultUuidOrError.getError())
    }
    const sharedVaultUuid = sharedVaultUuidOrError.getValue()

    const permissionOrError = SharedVaultUserPermission.create(dto.permission)
    if (permissionOrError.isFailed()) {
      return Result.fail(permissionOrError.getError())
    }
    const permission = permissionOrError.getValue()

    const sharedVaultUser = await this.sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid({
      userUuid,
      sharedVaultUuid,
    })
    if (!sharedVaultUser) {
      return Result.fail('User is not a member of the shared vault')
    }

    const timestampsOrError = Timestamps.create(sharedVaultUser.props.timestamps.createdAt, dto.updatedAt)
    if (timestampsOrError.isFailed()) {
      return Result.fail(timestampsOrError.getError())
    }

    sharedVaultUser.props.permission = permission
    sharedVaultUser.props.timestamps = timestampsOrError.getValue()

    await this.sharedVaultUserRepository.save(sharedVaultUser)

    return Result.ok()
  }
}
