import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { DeleteAccount } from '../DeleteAccount/DeleteAccount'

/**
 * Standard Red Notes: admin-only use case to REJECT a pending signup. Reject =
 * hard-delete the pending row via the EXISTING DeleteAccount pipeline (no new
 * "rejected" terminal state; a rejected applicant simply does not exist and may
 * re-apply). Guards that the target is actually PENDING so this endpoint can never
 * be used to delete an already-approved, active account (admins use the dedicated
 * delete-user endpoint for that).
 *
 * NOTE (documented, by design): the invite slot was consumed AT REGISTRATION and
 * is NOT refunded on reject in v1 — the slot means "an account was created via
 * this link"; approval/rejection is a downstream moderation decision.
 */
export class RejectUser implements UseCaseInterface<string> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private deleteAccount: DeleteAccount,
  ) {}

  async execute(dto: { userUuid: string }): Promise<Result<string>> {
    const uuidOrError = Uuid.create(dto.userUuid)
    if (uuidOrError.isFailed()) {
      return Result.fail(uuidOrError.getError())
    }

    const user = await this.userRepository.findOneByUuid(uuidOrError.getValue())
    if (user === null) {
      return Result.fail(`User ${dto.userUuid} not found.`)
    }

    if (!user.isPendingApproval()) {
      return Result.fail('Only a pending (awaiting-approval) account can be rejected.')
    }

    const result = await this.deleteAccount.execute({ userUuid: dto.userUuid })
    if (result.isFailed()) {
      return Result.fail(result.getError())
    }

    return Result.ok(result.getValue())
  }
}
