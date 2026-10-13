import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { RemoveSharedVaultUserDTO } from './RemoveSharedVaultUserDTO'

/**
 * Mirrors a `USER_REMOVED_FROM_SHARED_VAULT` into `auth_shared_vault_users`.
 *
 * Deletes EVERY row for the (shared_vault_uuid, user_uuid) pair. It used to find
 * one row and delete it, so a duplicate left by a redelivered add survived and
 * the removed member kept the vault in `belongs_to_shared_vaults` -- which the
 * revisions service trusts as its only authorization scope.
 *
 * A removal with nothing to remove is success: the mirror already says what the
 * event says, and a redelivered removal must not be logged as a failure.
 */
export class RemoveSharedVaultUser implements UseCaseInterface<void> {
  constructor(private sharedVaultUserRepository: SharedVaultUserRepositoryInterface) {}

  async execute(dto: RemoveSharedVaultUserDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    let sharedVaultUuid: Uuid | undefined
    if (dto.sharedVaultUuid !== undefined) {
      const sharedVaultUuidOrError = Uuid.create(dto.sharedVaultUuid)
      if (sharedVaultUuidOrError.isFailed()) {
        return Result.fail(sharedVaultUuidOrError.getError())
      }
      sharedVaultUuid = sharedVaultUuidOrError.getValue()
    }

    if (sharedVaultUuid) {
      await this.sharedVaultUserRepository.removeByUserUuidAndSharedVaultUuid({
        userUuid,
        sharedVaultUuid,
      })
    } else {
      const sharedVaultUsers = await this.sharedVaultUserRepository.findByUserUuid(userUuid)
      for (const sharedVaultUser of sharedVaultUsers) {
        await this.sharedVaultUserRepository.remove(sharedVaultUser)
      }
    }

    return Result.ok()
  }
}
