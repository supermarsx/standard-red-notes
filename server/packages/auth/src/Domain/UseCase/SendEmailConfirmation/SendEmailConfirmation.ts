import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { v4 as uuidv4 } from 'uuid'
import { Logger } from 'winston'

import { EmailConfirmationToken } from '../../EmailConfirmation/EmailConfirmationToken'
import { EmailConfirmationTokenRepositoryInterface } from '../../EmailConfirmation/EmailConfirmationTokenRepositoryInterface'
import {
  generateRawEmailConfirmationToken,
  hashEmailConfirmationToken,
} from '../../EmailConfirmation/hashEmailConfirmationToken'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { buildConfirmationUrl, renderConfirmationEmailBody } from '../../Registration/RegistrationConfig'

import { SendEmailConfirmationDTO } from './SendEmailConfirmationDTO'

/**
 * Standard Red Notes: issues a single-use, expiring email-confirmation token for
 * a user and emails them the verification link. Only the token's SHA-256 hash is
 * persisted; the raw token lives solely in the emailed link and is never logged.
 *
 * Returns Result.ok(true) when an email was actually dispatched, Result.ok(false)
 * when the token was stored but SMTP is not configured (so callers can surface a
 * "check your email" message only when delivery is possible). A storage failure
 * returns Result.fail.
 */
export class SendEmailConfirmation implements UseCaseInterface<boolean> {
  static readonly EXPIRATION_HOURS = 24

  constructor(
    private tokenRepository: EmailConfirmationTokenRepositoryInterface,
    private emailSender: EmailSenderInterface,
    private logger: Logger,
  ) {}

  async execute(dto: SendEmailConfirmationDTO): Promise<Result<boolean>> {
    if (!dto.userUuid || !dto.email) {
      return Result.fail('Could not send email confirmation: missing user identifier.')
    }

    try {
      const rawToken = generateRawEmailConfirmationToken()
      const hashedToken = hashEmailConfirmationToken(rawToken)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + SendEmailConfirmation.EXPIRATION_HOURS * 60 * 60 * 1000)

      const token = EmailConfirmationToken.create(
        {
          userUuid: dto.userUuid,
          email: dto.email,
          hashedToken,
          expiresAt,
          consumed: false,
          createdAt: now,
        },
        new UniqueEntityId(uuidv4()),
      ).getValue()

      await this.tokenRepository.save(token)

      if (!this.emailSender.isConfigured()) {
        // Token is stored; without SMTP there is simply no way to deliver the link.
        this.logger.warn(
          `[email-confirmation] SMTP is not configured; confirmation email for user ${dto.userUuid} was not sent.`,
        )

        return Result.ok(false)
      }

      const url = buildConfirmationUrl(dto.registrationConfig.emailConfirmationBaseUrl, rawToken)
      const body = renderConfirmationEmailBody(dto.registrationConfig.emailConfirmationBody, url)
      const subject = dto.registrationConfig.emailConfirmationSubject

      const emailed = await this.emailSender.sendEmail(dto.email, subject, body)

      return Result.ok(emailed)
    } catch (error) {
      this.logger.error(`[email-confirmation] Failed to send confirmation for user ${dto.userUuid}: ${(error as Error).message}`)

      return Result.fail('Could not send email confirmation.')
    }
  }
}
