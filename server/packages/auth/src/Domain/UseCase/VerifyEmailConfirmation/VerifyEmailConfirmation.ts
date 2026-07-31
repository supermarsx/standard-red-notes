import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { EmailConfirmationTokenRepositoryInterface } from '../../EmailConfirmation/EmailConfirmationTokenRepositoryInterface'
import { hashEmailConfirmationToken } from '../../EmailConfirmation/hashEmailConfirmationToken'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { TimerInterface } from '@standardnotes/time'

import { VerifyEmailConfirmationDTO } from './VerifyEmailConfirmationDTO'
import { VerifyEmailConfirmationResponse } from './VerifyEmailConfirmationResponse'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

/**
 * Standard Red Notes: consumes an email-confirmation token. On success it marks
 * the user email_confirmed = true, stamps email_confirmed_at, and consumes the
 * token (single-use). Invalid / expired / already-used tokens yield a clear,
 * non-enumerating error. The raw token is hashed for lookup and never logged.
 */
export class VerifyEmailConfirmation implements UseCaseInterface<VerifyEmailConfirmationResponse> {
  constructor(
    private tokenRepository: EmailConfirmationTokenRepositoryInterface,
    private userRepository: UserRepositoryInterface,
    private timer: TimerInterface,
    private logger: Logger,
  ) {}

  async execute(dto: VerifyEmailConfirmationDTO): Promise<Result<VerifyEmailConfirmationResponse>> {
    if (typeof dto.token !== 'string' || dto.token.trim().length === 0) {
      return Result.ok({ success: false, errorMessage: 'This confirmation link is invalid.' })
    }

    try {
      const hashedToken = hashEmailConfirmationToken(dto.token.trim())
      const token = await this.tokenRepository.findByHashedToken(hashedToken)

      if (token === null) {
        return Result.ok({ success: false, errorMessage: 'This confirmation link is invalid.' })
      }

      const now = this.timer.getUTCDate()

      const userUuidOrError = Uuid.create(token.props.userUuid)
      if (userUuidOrError.isFailed()) {
        return Result.ok({ success: false, errorMessage: 'This confirmation link is invalid.' })
      }
      const user = await this.userRepository.findOneByUuid(userUuidOrError.getValue())

      if (token.isConsumed()) {
        // A re-click after a successful confirmation is friendly, not an error.
        if (user !== null && user.isEmailConfirmed()) {
          return Result.ok({ success: true, alreadyConfirmed: true })
        }

        return Result.ok({ success: false, errorMessage: 'This confirmation link has already been used.' })
      }

      if (token.isExpired(now)) {
        return Result.ok({
          success: false,
          errorMessage: 'This confirmation link has expired. Please request a new one.',
        })
      }

      if (user === null) {
        return Result.ok({ success: false, errorMessage: 'This confirmation link is invalid.' })
      }

      // Idempotent success if already confirmed by another means.
      if (!user.isEmailConfirmed()) {
        user.emailConfirmed = true
        user.emailConfirmedAt = now
        await this.userRepository.save(user)
      }

      token.props.consumed = true
      await this.tokenRepository.save(token)

      return Result.ok({ success: true })
    } catch (error) {
      this.logger.error('[email-confirmation] Verification failed.', safeErrorLogMetadata(error))

      return Result.fail('Could not verify the confirmation link.')
    }
  }
}
