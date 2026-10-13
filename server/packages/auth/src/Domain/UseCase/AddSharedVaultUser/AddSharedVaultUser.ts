import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UseCaseInterface,
  Uuid,
} from '@standardnotes/domain-core'

import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { AddSharedVaultUserDTO } from './AddSharedVaultUserDTO'

/**
 * Mirrors a `USER_ADDED_TO_SHARED_VAULT` into `auth_shared_vault_users`.
 *
 * An UPSERT keyed on (shared_vault_uuid, user_uuid), never a blind insert. SQS
 * delivers at least once, so the same event can arrive twice; a second row for
 * one membership used to survive the later removal (which deleted one row) and
 * keep a removed member in `belongs_to_shared_vaults`. The table now carries a
 * unique index on the pair, so a blind insert would also throw on redelivery.
 *
 * An event OLDER than the row it would overwrite is acknowledged and dropped:
 * a redelivered add must not undo a permission change that happened after it.
 */
export class AddSharedVaultUser implements UseCaseInterface<void> {
  constructor(private sharedVaultUserRepository: SharedVaultUserRepositoryInterface) {}

  async execute(dto: AddSharedVaultUserDTO): Promise<Result<void>> {
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

    const timestampsOrError = Timestamps.create(dto.createdAt, dto.updatedAt)
    if (timestampsOrError.isFailed()) {
      return Result.fail(timestampsOrError.getError())
    }
    const timestamps = timestampsOrError.getValue()

    const existing = await this.sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid({
      userUuid,
      sharedVaultUuid,
    })
    if (existing) {
      if (existing.props.timestamps.updatedAt > timestamps.updatedAt) {
        return Result.ok()
      }

      existing.props.permission = permission
      existing.props.timestamps = timestamps

      await this.sharedVaultUserRepository.save(existing)

      return Result.ok()
    }

    const sharedVaultUserOrError = SharedVaultUser.create({
      userUuid,
      sharedVaultUuid,
      permission,
      timestamps,
      isDesignatedSurvivor: false,
    })
    if (sharedVaultUserOrError.isFailed()) {
      return Result.fail(sharedVaultUserOrError.getError())
    }
    const sharedVaultUser = sharedVaultUserOrError.getValue()

    await this.sharedVaultUserRepository.save(sharedVaultUser)

    return Result.ok()
  }
}
