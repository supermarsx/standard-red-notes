import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SessionRepositoryInterface } from '../../Session/SessionRepositoryInterface'
import { EphemeralSessionRepositoryInterface } from '../../Session/EphemeralSessionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../../Session/RevokedSessionRepositoryInterface'
import { SetUserSuspensionDTO } from './SetUserSuspensionDTO'

/**
 * Standard Red Notes: admin-only use case to SUSPEND or UNSUSPEND a user.
 * Suspension is a reversible, neutral administrative hold — first-class and
 * SEPARATE from a ban. Suspending sets the `suspended` flag plus an audit
 * timestamp and optional reason, and is folded into User.isAccessBlocked(), so
 * enforcement reuses the existing SignIn + AuthenticateUser choke point (no new
 * call sites). Unsuspending clears every suspension column.
 *
 * Immediate revocation: the isAccessBlocked() gate already denies any surviving
 * token on its next authenticated request, but on suspend we ALSO delete every
 * session kind (session + ephemeral + revoked) so the user is signed out at
 * once, mirroring AccountDeletionRequestedEventHandler.removeSessions.
 * Unsuspend does NOT recreate sessions — the user signs in fresh.
 */
export class SetUserSuspension implements UseCaseInterface<User> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private sessionRepository: SessionRepositoryInterface,
    private ephemeralSessionRepository: EphemeralSessionRepositoryInterface,
    private revokedSessionRepository: RevokedSessionRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  async execute(dto: SetUserSuspensionDTO): Promise<Result<User>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail(`User ${dto.userUuid} not found.`)
    }

    if (dto.suspended) {
      user.suspended = true
      user.suspendedAt = this.timer.getUTCDate()
      user.suspendedReason = dto.suspendedReason ?? null
    } else {
      user.suspended = false
      user.suspendedAt = null
      user.suspendedReason = null
    }

    const savedUser = await this.userRepository.save(user)

    if (dto.suspended) {
      await this.removeSessions(user.uuid)
    }

    return Result.ok(savedUser)
  }

  /**
   * Standard Red Notes: revoke every session kind for immediacy on suspend.
   * Mirrors AccountDeletionRequestedEventHandler.removeSessions.
   */
  private async removeSessions(userUuid: string): Promise<void> {
    const sessions = await this.sessionRepository.findAllByUserUuid(userUuid)
    for (const session of sessions) {
      await this.sessionRepository.remove(session)
    }

    const ephemeralSessions = await this.ephemeralSessionRepository.findAllByUserUuid(userUuid)
    for (const ephemeralSession of ephemeralSessions) {
      await this.ephemeralSessionRepository.deleteOne(ephemeralSession.uuid, ephemeralSession.userUuid)
    }

    const revokedSessions = await this.revokedSessionRepository.findAllByUserUuid(userUuid)
    for (const revokedSession of revokedSessions) {
      await this.revokedSessionRepository.remove(revokedSession)
    }
  }
}
