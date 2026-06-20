import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { TriggerDueDeadManSwitchesDTO } from './TriggerDueDeadManSwitchesDTO'

const EMAIL_SUBJECT = 'A Standard Red Notes message is waiting for you'

// Delay applied AFTER each failed send attempt before the switch is retried.
// Indexed by (failed attempt number - 1). Once attempts exceed the list we keep
// retrying at the final interval (~6 months) — we never give up silently.
const RETRY_BACKOFF_MS = [
  5 * 60_000, // 5 min   (after attempt 1)
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 h
  6 * 60 * 60_000, // 6 h
  24 * 60 * 60_000, // 24 h
  4 * 24 * 60 * 60_000, // 4 days
  8 * 24 * 60 * 60_000, // 8 days
  30 * 24 * 60 * 60_000, // ~1 month
  180 * 24 * 60 * 60_000, // ~6 months
]

const MAX_ERROR_LENGTH = 255

export class TriggerDueDeadManSwitches implements UseCaseInterface<number> {
  constructor(
    private deadManSwitchRepository: DeadManSwitchRepositoryInterface,
    private emailSender: EmailSenderInterface,
    private logger: Logger,
  ) {}

  async execute(_dto: TriggerDueDeadManSwitchesDTO): Promise<Result<number>> {
    // If email delivery is not configured we cannot fulfil a switch. Skip the
    // whole scan WITHOUT marking anything triggered so it retries once SMTP is
    // configured.
    if (!this.emailSender.isConfigured()) {
      this.logger.debug('SMTP is not configured. Skipping dead man switch scan.')

      return Result.ok(0)
    }

    const now = Date.now()
    const dueSwitches = await this.deadManSwitchRepository.findDue(now)

    let triggeredCount = 0

    for (const deadManSwitch of dueSwitches) {
      try {
        const body = this.composeBody(deadManSwitch)

        const sent = await this.emailSender.sendEmail(deadManSwitch.props.recipientEmail, EMAIL_SUBJECT, body)
        if (!sent) {
          // Delivery failed (transient SMTP error). Record the failure and
          // schedule the next retry on the escalating backoff. Do not block the
          // rest of the batch.
          await this.recordFailure(deadManSwitch, 'Email sender reported the message was not sent.', now)

          continue
        }

        const triggeredOrError = DeadManSwitch.create(
          {
            ...deadManSwitch.props,
            triggered: true,
            lastAttemptAt: now,
            lastError: null,
          },
          new UniqueEntityId(deadManSwitch.id.toString()),
        )
        if (triggeredOrError.isFailed()) {
          this.logger.error(
            `Could not mark dead man switch ${deadManSwitch.id.toString()} triggered: ${triggeredOrError.getError()}`,
          )

          continue
        }

        await this.deadManSwitchRepository.save(triggeredOrError.getValue())

        triggeredCount++
      } catch (error) {
        // A single failure must never block the rest of the batch. Record it and
        // schedule a retry like any other delivery failure.
        await this.recordFailure(deadManSwitch, (error as Error).message, now)
      }
    }

    return Result.ok(triggeredCount)
  }

  // Persists a failed send: increments the attempt counter, stores the error and
  // schedules the next retry on the escalating backoff. After the last entry the
  // switch keeps retrying at the final interval (~6 months) — never giving up.
  private async recordFailure(deadManSwitch: DeadManSwitch, errorMessage: string, now: number): Promise<void> {
    try {
      const sendAttempts = deadManSwitch.props.sendAttempts + 1
      const backoffIndex = Math.min(sendAttempts - 1, RETRY_BACKOFF_MS.length - 1)
      const nextAttemptAt = now + RETRY_BACKOFF_MS[backoffIndex]

      this.logger.error(
        `Failed to deliver dead man switch ${deadManSwitch.id.toString()} email (attempt ${sendAttempts}): ` +
          `${errorMessage}. Next retry at ${new Date(nextAttemptAt).toISOString()}.`,
      )

      const updatedOrError = DeadManSwitch.create(
        {
          ...deadManSwitch.props,
          sendAttempts,
          nextAttemptAt,
          lastAttemptAt: now,
          lastError: errorMessage.slice(0, MAX_ERROR_LENGTH),
        },
        new UniqueEntityId(deadManSwitch.id.toString()),
      )
      if (updatedOrError.isFailed()) {
        this.logger.error(
          `Could not record dead man switch ${deadManSwitch.id.toString()} failure: ${updatedOrError.getError()}`,
        )

        return
      }

      await this.deadManSwitchRepository.save(updatedOrError.getValue())
    } catch (error) {
      this.logger.error(
        `Error recording dead man switch ${deadManSwitch.id.toString()} failure: ${(error as Error).message}`,
      )
    }
  }

  private composeBody(deadManSwitch: DeadManSwitch): string {
    const lines: string[] = []

    lines.push('Someone set up a Standard Red Notes survivor switch and named you as the recipient.')
    lines.push('')

    if (deadManSwitch.props.message !== null) {
      lines.push('They left you this message:')
      lines.push('')
      lines.push(deadManSwitch.props.message)
      lines.push('')
    }

    lines.push('You can open and decrypt the shared note here:')
    lines.push(deadManSwitch.props.shareUrl)

    return lines.join('\n')
  }
}
