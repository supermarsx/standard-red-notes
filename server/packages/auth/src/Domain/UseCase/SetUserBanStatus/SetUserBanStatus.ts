import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { SetUserBanStatusDTO } from './SetUserBanStatusDTO'

/**
 * Standard Red Notes: admin-only use case to ban or unban a user. Banning sets
 * the `banned` flag (plus an audit timestamp and optional reason); unbanning
 * clears all three. Enforcement lives in SignIn (blocks new sign-ins) and
 * AuthenticateUser (rejects existing sessions/tokens), so a ban takes effect on
 * the banned user's next authenticated request.
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
      user.banned = true
      user.bannedAt = this.timer.getUTCDate()
      user.banReason = dto.banReason ?? null
    } else {
      user.banned = false
      user.bannedAt = null
      user.banReason = null
    }

    const savedUser = await this.userRepository.save(user)

    return Result.ok(savedUser)
  }
}
