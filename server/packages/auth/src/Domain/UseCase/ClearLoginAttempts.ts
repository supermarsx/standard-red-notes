import { Result, UseCaseInterface, Username } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { LockRepositoryInterface } from '../User/LockRepositoryInterface'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { ClearLoginAttemptsDTO } from './ClearLoginAttemptsDTO'

export class ClearLoginAttempts implements UseCaseInterface<void> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private lockRepository: LockRepositoryInterface,
    private logger: Logger,
  ) {}

  async execute(dto: ClearLoginAttemptsDTO): Promise<Result<void>> {
    /**
     * Standard Red Notes: `skipValidation` is REQUIRED here and must stay.
     *
     * SignIn and IncreaseLoginAttempts both resolve the identifier with
     * `{ skipValidation: true }` — deliberately, so accounts created before the
     * 2025 username rules can still sign in and still be counted. Clearing was
     * the only one of the three that validated, so for any legacy identifier the
     * 2025 rules reject (non-ASCII, consecutive special characters, a leading or
     * trailing `.`/`_`/`-`/`@`/`+`, under three characters) this returned
     * Result.fail BEFORE resetting anything: a SUCCESSFUL sign-in cleared
     * neither the email key nor the uuid key.
     *
     * Those users therefore accumulated failed attempts across successful
     * sessions and eventually locked themselves out with ordinary typos — the
     * counter only ever went up. The increment side and the clear side MUST
     * agree on how an identifier is resolved, or the lockout counter is not a
     * counter of consecutive failures at all.
     *
     * Empty/whitespace-only and non-string input is still rejected: those checks
     * run in Username.create regardless of skipValidation.
     */
    const usernameOrError = Username.create(dto.email, { skipValidation: true })
    if (usernameOrError.isFailed()) {
      return Result.fail(usernameOrError.getError())
    }
    const username = usernameOrError.getValue()

    await this.lockRepository.resetLockCounter(dto.email)

    const user = await this.userRepository.findOneByUsernameOrEmail(username)

    if (!user) {
      return Result.ok()
    }

    this.logger.debug('Resetting lock counter for user', {
      userId: user.uuid,
    })

    await this.lockRepository.resetLockCounter(user.uuid)

    return Result.ok()
  }
}
