import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UseCaseInterface,
  Uuid,
} from '@standardnotes/domain-core'

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
 * It UPDATES the row it finds, keeping its uuid and createdAt. When the mirror has NO row
 * it CREATES one: the event is published by the syncing-server only after it changed a
 * membership row that exists there, so a missing mirror row means an earlier
 * `USER_ADDED_TO_SHARED_VAULT` was lost -- and refusing would keep the member out of the
 * token for good. (`auth_shared_vault_users` is unique on (shared_vault_uuid, user_uuid),
 * so this cannot become a second row.)
 *
 * An event OLDER than the row is acknowledged and dropped, so two permission changes
 * delivered out of order still leave the later one in place.
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
      const timestampsOrError = Timestamps.create(dto.updatedAt, dto.updatedAt)
      if (timestampsOrError.isFailed()) {
        return Result.fail(timestampsOrError.getError())
      }
      const createdOrError = SharedVaultUser.create({
        userUuid,
        sharedVaultUuid,
        permission,
        timestamps: timestampsOrError.getValue(),
        isDesignatedSurvivor: false,
      })
      if (createdOrError.isFailed()) {
        return Result.fail(createdOrError.getError())
      }

      await this.sharedVaultUserRepository.save(createdOrError.getValue())

      return Result.ok()
    }

    if (sharedVaultUser.props.timestamps.updatedAt > dto.updatedAt) {
      return Result.ok()
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
