import { Result, SettingName, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'

import { TriggerDueEmailRemindersDTO } from './TriggerDueEmailRemindersDTO'

const EMAIL_SUBJECT_PREFIX = 'Reminder: '

/**
 * Scheduled job: emails due, unsent email reminders to the user's account email.
 *
 * ## E2E note
 * The reminder time + message in `email_reminders` are PLAINTEXT. They are only
 * there because the user EXPLICITLY opted that reminder into emailing on the client,
 * which knowingly sends that reminder out of end-to-end encryption for this feature.
 * No other note content is involved.
 *
 * ## Gating (all must hold before anything is sent)
 *  1. Operator switch EMAIL_REMINDERS_ENABLED is on (`emailRemindersEnabled`).
 *  2. Email delivery (SMTP) is configured (`emailSender.isConfigured()`).
 *  3. The specific user opted in (per-user EMAIL_REMINDERS_ENABLED setting == 'true').
 *
 * ## "No records" mode (EMAIL_REMINDER_NO_RECORDS)
 * When `noRecords` is true, after a SUCCESSFUL send the reminder row is DELETED
 * (no `sent=true` history is kept) and the recipient/message are NOT written to the
 * log. LIMIT: the email itself still transits SMTP and the mail provider; only the
 * SERVER-SIDE database record and application log are suppressed. The row still
 * exists between creation and the send pass (the cron must be able to find it).
 */
export class TriggerDueEmailReminders implements UseCaseInterface<number> {
  constructor(
    private emailReminderRepository: EmailReminderRepositoryInterface,
    private userRepository: UserRepositoryInterface,
    private getSetting: GetSetting,
    private emailSender: EmailSenderInterface,
    private logger: Logger,
    // Operator switch (EMAIL_REMINDERS_ENABLED env). Default off.
    private emailRemindersEnabled: boolean,
    // EMAIL_REMINDER_NO_RECORDS env. When true, delete-on-send + suppress logging.
    private noRecords: boolean,
  ) {}

  async execute(_dto: TriggerDueEmailRemindersDTO): Promise<Result<number>> {
    if (!this.emailRemindersEnabled) {
      this.logger.debug('Email reminders are disabled by the operator (EMAIL_REMINDERS_ENABLED). Skipping.')

      return Result.ok(0)
    }

    if (!this.emailSender.isConfigured()) {
      this.logger.debug('SMTP is not configured. Skipping email reminder scan.')

      return Result.ok(0)
    }

    const now = Date.now()
    const dueReminders = await this.emailReminderRepository.findDueUnsent(now)

    let sentCount = 0

    for (const reminder of dueReminders) {
      try {
        const handled = await this.processReminder(reminder)
        if (handled) {
          sentCount++
        }
      } catch (error) {
        // A single failure must never block the rest of the batch. Leave the row
        // unsent so it retries on the next scan. Avoid logging message content even
        // outside no-records mode here; the reminder id is enough to diagnose.
        this.logger.error(`Error processing email reminder ${reminder.id.toString()}: ${(error as Error).message}`)
      }
    }

    return Result.ok(sentCount)
  }

  private async processReminder(reminder: EmailReminder): Promise<boolean> {
    if (!(await this.userOptedIn(reminder.props.userUuid))) {
      // User has not opted in (or opted back out). Do not send. Leave the row so it
      // sends later if they opt in before it is cleaned up / deleted by the client.
      return false
    }

    const email = await this.resolveAccountEmail(reminder.props.userUuid)
    if (email === null) {
      // No deliverable account email (e.g. a private-username account). Skip without
      // marking sent; nothing to deliver to.
      return false
    }

    // Defense-in-depth: strip CR/LF from the user-controlled message before using
    // it in the email subject (a header) so it can never inject extra headers or
    // split the message, even if a malformed message slipped past creation.
    const sanitizedSubjectMessage = reminder.props.message.replace(/[\r\n]+/g, ' ')
    const subject = EMAIL_SUBJECT_PREFIX + sanitizedSubjectMessage
    const body = this.composeBody(reminder)

    const sent = await this.emailSender.sendEmail(email, subject, body)
    if (!sent) {
      // Transient delivery failure. Leave unsent for the next scan.
      this.logger.error(`Email sender reported the reminder ${reminder.id.toString()} was not sent.`)

      return false
    }

    if (this.noRecords) {
      // No-records mode: remove the record entirely instead of keeping sent history,
      // and deliberately do NOT log the recipient or message.
      await this.emailReminderRepository.remove(reminder)

      return true
    }

    const sentOrError = EmailReminder.create(
      {
        ...reminder.props,
        sent: true,
      },
      new UniqueEntityId(reminder.id.toString()),
    )
    if (sentOrError.isFailed()) {
      this.logger.error(`Could not mark email reminder ${reminder.id.toString()} sent: ${sentOrError.getError()}`)

      return false
    }

    await this.emailReminderRepository.save(sentOrError.getValue())

    return true
  }

  private async userOptedIn(userUuid: string): Promise<boolean> {
    const result = await this.getSetting.execute({
      userUuid,
      settingName: SettingName.NAMES.EmailRemindersEnabled,
      allowSensitiveRetrieval: false,
      decrypted: true,
    })

    if (result.isFailed()) {
      return false
    }

    return result.getValue().decryptedValue === 'true'
  }

  private async resolveAccountEmail(userUuid: string): Promise<string | null> {
    const userUuidOrError = Uuid.create(userUuid)
    if (userUuidOrError.isFailed()) {
      return null
    }

    const user = await this.userRepository.findOneByUuid(userUuidOrError.getValue())
    if (user === null) {
      return null
    }

    const email = user.email
    // Private-username accounts store a 64-char hex with no '@' instead of a real
    // email; there is nothing to deliver to for those.
    if (typeof email !== 'string' || !email.includes('@')) {
      return null
    }

    return email
  }

  private composeBody(reminder: EmailReminder): string {
    const lines: string[] = []

    lines.push(reminder.props.message)
    lines.push('')
    lines.push(`This reminder was due ${new Date(reminder.props.dueAt).toUTCString()}.`)
    lines.push('')
    lines.push(
      'You are receiving this because you opted this reminder into email delivery in Standard Red Notes. ' +
        'You can manage or cancel email reminders in Preferences.',
    )

    return lines.join('\n')
  }
}
