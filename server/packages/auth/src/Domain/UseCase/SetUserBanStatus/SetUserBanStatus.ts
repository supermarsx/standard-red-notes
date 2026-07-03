import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SetUserBanStatusDTO } from './SetUserBanStatusDTO'

/**
 * Standard Red Notes: admin-only use case to ban or unban a user. Banning sets
 * the `banned` flag plus an audit timestamp, optional reason, ban KIND
 * ('temporary' | 'permanent' | 'shadow', default 'permanent') and, for a
 * temporary ban, an expiry (`bannedUntil`, which must be in the future).
 * Unbanning clears every ban column.
 *
 * Enforcement:
 *   - permanent / active-temporary: rejected in SignIn (new sign-ins) and
 *     AuthenticateUser (existing sessions/tokens) via User.isAccessBlocked(), so
 *     the ban takes effect on the user's next authenticated request.
 *   - temporary once expired: treated as not banned (isAccessBlocked is false).
 *   - shadow: the user still connects, but CreateCrossServiceToken projects a
 *     `shadow_banned` marker so the syncing-server silently degrades their sync.
 */
export class SetUserBanStatus implements UseCaseInterface<User> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  async execute(dto: SetUserBanStatusDTO): Promise<Result<User>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail(`User ${dto.userUuid} not found.`)
    }

    if (dto.banned) {
      const banType = dto.banType ?? 'permanent'
      if (banType !== 'permanent' && banType !== 'temporary' && banType !== 'shadow') {
        return Result.fail(`Invalid ban type '${banType}'. Use 'temporary', 'permanent' or 'shadow'.`)
      }

      let bannedUntil: Date | null = null
      if (banType === 'temporary') {
        if (dto.bannedUntil === null || dto.bannedUntil === undefined) {
          return Result.fail('A temporary ban requires an expiry (bannedUntil).')
        }
        bannedUntil = new Date(dto.bannedUntil)
        if (Number.isNaN(bannedUntil.getTime())) {
          return Result.fail('The temporary ban expiry (bannedUntil) is not a valid date.')
        }
        if (bannedUntil.getTime() <= this.timer.getUTCDate().getTime()) {
          return Result.fail('The temporary ban expiry (bannedUntil) must be in the future.')
        }
      }

      user.banned = true
      user.bannedAt = this.timer.getUTCDate()
      user.banReason = dto.banReason ?? null
      user.banType = banType
      user.bannedUntil = bannedUntil
    } else {
      user.banned = false
      user.bannedAt = null
      user.banReason = null
      user.banType = null
      user.bannedUntil = null
    }

    const savedUser = await this.userRepository.save(user)

    return Result.ok(savedUser)
  }
}
