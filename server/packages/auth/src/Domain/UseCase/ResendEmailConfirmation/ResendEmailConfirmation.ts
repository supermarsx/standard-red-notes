import { Result, UseCaseInterface, Username } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { RegistrationConfigResolverInterface } from '../../Registration/RegistrationConfigResolverInterface'
import { SendEmailConfirmation } from '../SendEmailConfirmation/SendEmailConfirmation'

import { ResendEmailConfirmationDTO } from './ResendEmailConfirmationDTO'

/**
 * Standard Red Notes: re-sends the confirmation email for an unconfirmed account.
 *
 * ALWAYS resolves to success regardless of whether the address exists / is
 * already confirmed / the feature is on, so it never becomes an account-existence
 * oracle. The actual work only happens when confirmation is enabled and the user
 * exists and is not yet confirmed. Rate limiting is applied at the gateway (the
 * shared "auth-sensitive" tier), same as the register / magic-link surfaces.
 */
export class ResendEmailConfirmation implements UseCaseInterface<boolean> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private registrationConfigResolver: RegistrationConfigResolverInterface,
    private sendEmailConfirmation: SendEmailConfirmation,
    private logger: Logger,
  ) {}

  async execute(dto: ResendEmailConfirmationDTO): Promise<Result<boolean>> {
    // Uniform response — do not disclose whether the address exists.
    const uniformSuccess = Result.ok(true)

    if (typeof dto.email !== 'string' || dto.email.trim().length === 0) {
      return uniformSuccess
    }

    try {
      const config = await this.registrationConfigResolver.resolve()
      if (!config.emailConfirmationEnabled) {
        return uniformSuccess
      }

      const usernameOrError = Username.create(dto.email, { skipValidation: true })
      if (usernameOrError.isFailed()) {
        return uniformSuccess
      }

      const user = await this.userRepository.findOneByUsernameOrEmail(usernameOrError.getValue())
      if (user === null || user.isEmailConfirmed()) {
        return uniformSuccess
      }

      await this.sendEmailConfirmation.execute({
        userUuid: user.uuid,
        email: user.email,
        registrationConfig: config,
      })
    } catch (error) {
      // Never surface internal failures to the caller (no enumeration, no 500).
      this.logger.error(`[email-confirmation] Resend failed: ${(error as Error).message}`)
    }

    return uniformSuccess
  }
}
