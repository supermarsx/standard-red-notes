import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { createEmailDeliveryId } from '../../Email/EmailDeliveryId'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

/**
 * Standard Red Notes: emails an approved user that their account is now active and
 * they can sign in. Reuses the same EmailSender/SMTP infra as the email-confirmation
 * flow. BEST-EFFORT: a send failure never fails the approval, and it is skipped
 * cleanly (Result.ok(false)) when SMTP is not configured. Nothing sensitive is
 * logged.
 *
 * Returns Result.ok(true) when an email was dispatched, Result.ok(false) when SMTP
 * is unconfigured (or the send returned false), and Result.fail only on an
 * unexpected error (which the caller ignores).
 */
export class SendApprovalNotification implements UseCaseInterface<boolean> {
  static readonly DEFAULT_SUBJECT = 'Your account has been approved'

  constructor(
    private emailSender: EmailSenderInterface,
    private logger: Logger,
  ) {}

  async execute(dto: { userUuid: string; email: string; signInUrl?: string }): Promise<Result<boolean>> {
    if (!dto.userUuid || !dto.email) {
      return Result.fail('Could not send approval notification: missing email.')
    }

    try {
      if (!(await this.emailSender.isConfigured())) {
        return Result.ok(false)
      }

      const base = (dto.signInUrl ?? '').trim().replace(/\/+$/, '')
      const link = base.length > 0 ? `\n\nSign in here: ${base}` : ''
      const body =
        'Good news — an administrator has approved your account. You can now sign in and start using it.' + link

      const emailed = await this.emailSender.sendEmail(dto.email, SendApprovalNotification.DEFAULT_SUBJECT, body, {
        deliverySource: 'account',
        deliveryId: createEmailDeliveryId('account-approval', dto.userUuid),
      })

      return Result.ok(emailed)
    } catch (error) {
      this.logger.error('[approval] Failed to send an approval notification.', safeErrorLogMetadata(error))

      return Result.fail('Could not send approval notification.')
    }
  }
}
