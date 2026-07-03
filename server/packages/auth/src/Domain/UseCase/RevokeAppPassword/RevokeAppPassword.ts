import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'

import { RevokeAppPasswordDTO } from './RevokeAppPasswordDTO'

/**
 * Standard Red Notes: soft-revoke an app password. Unlike DeleteAppPassword
 * (which hard-deletes the row), this stamps `revoked_at` and keeps the record so
 * there is an audit trail of app passwords that once existed. VerifyAppPassword
 * rejects a revoked password immediately, so revocation cuts off access right
 * away while preserving the trail.
 */
export class RevokeAppPassword implements UseCaseInterface<string> {
  constructor(private appPasswordRepository: AppPasswordRepositoryInterface) {}

  async execute(dto: RevokeAppPasswordDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not revoke app password: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const appPassword = await this.appPasswordRepository.findById(new UniqueEntityId(dto.appPasswordId))
    // Ownership check: never allow revoking another user's app password.
    if (!appPassword || appPassword.props.userUuid !== userUuid.value) {
      return Result.fail('App password not found')
    }

    if (appPassword.isRevoked()) {
      return Result.ok('App password already revoked')
    }

    appPassword.revoke()

    await this.appPasswordRepository.save(appPassword)

    return Result.ok('App password revoked')
  }
}
