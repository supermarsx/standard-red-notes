import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SendApprovalNotification } from '../SendApprovalNotification/SendApprovalNotification'

/**
 * Standard Red Notes: admin-only use case to APPROVE a pending user. Sets
 * approved=1 + approved_at (and an optional note), which clears the
 * pending_approval branch of isAccessBlocked so the user can sign in. Fires a
 * best-effort approval-notification email (never fails the approval). Idempotent:
 * approving an already-approved user is a no-op success.
 */
export class ApproveUser implements UseCaseInterface<User> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private timer: TimerInterface,
    private sendApprovalNotification?: SendApprovalNotification,
    private signInUrl?: string,
    private logger?: { error: (message: string) => void },
  ) {}

  async execute(dto: { userUuid: string; approvalNote?: string | null }): Promise<Result<User>> {
    const uuidOrError = Uuid.create(dto.userUuid)
    if (uuidOrError.isFailed()) {
      return Result.fail(uuidOrError.getError())
    }

    const user = await this.userRepository.findOneByUuid(uuidOrError.getValue())
    if (user === null) {
      return Result.fail(`User ${dto.userUuid} not found.`)
    }

    user.approved = true
    user.approvedAt = this.timer.getUTCDate()
    if (dto.approvalNote !== undefined) {
      user.approvalNote = dto.approvalNote
    }

    const saved = await this.userRepository.save(user)

    // Best-effort approval email — a send failure never fails the approval.
    if (this.sendApprovalNotification !== undefined) {
      try {
        await this.sendApprovalNotification.execute({ email: saved.email, signInUrl: this.signInUrl })
      } catch (error) {
        this.logger?.error(`Could not send approval notification: ${(error as Error).message}`)
      }
    }

    return Result.ok(saved)
  }
}
