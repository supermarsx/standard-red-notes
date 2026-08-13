import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { EmailDeliveryStatus, EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { createDeadManSwitchEmailDeliveryId } from '../../Email/EmailDeliveryId'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

import { TriggerDueDeadManSwitchesDTO } from './TriggerDueDeadManSwitchesDTO'

const EMAIL_SUBJECT = 'A Standard Red Notes message is waiting for you'
const TERMINAL_DELIVERY_STATUSES: ReadonlySet<EmailDeliveryStatus> = new Set([
  'dead',
  'quarantined',
  'discarded',
  'superseded',
])

// Delay applied AFTER each failed send attempt before the switch is retried.
// Indexed by (failed attempt number - 1). Once attempts exceed the list we keep
// retrying at the final interval (~6 months) — we never give up silently.
const RETRY_BACKOFF_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  4 * 24 * 60 * 60_000,
  8 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
  180 * 24 * 60 * 60_000,
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
    if (this.emailSender.acceptanceMode === 'provider' && !(await this.emailSender.isConfigured())) {
      this.logger.debug('SMTP is not configured. Skipping dead man switch scan.')

      return Result.ok(0)
    }

    const now = Date.now()
    const dueSwitches = await this.deadManSwitchRepository.findDue(now)

    let triggeredCount = 0

    for (const deadManSwitch of dueSwitches) {
      try {
        const deliveryId = createDeadManSwitchEmailDeliveryId(deadManSwitch.id.toString(), deadManSwitch.props.deadline)
        if (this.emailSender.acceptanceMode === 'durable-queue') {
          const status = await this.durableDeliveryStatus(deliveryId)
          if (status === 'provider-accepted') {
            if (await this.markTriggered(deadManSwitch, now)) {
              triggeredCount++
            }
            continue
          }
          if (status === 'pending') {
            continue
          }
          if (TERMINAL_DELIVERY_STATUSES.has(status)) {
            this.logger.error('Durable dead-man-switch email reached a terminal state.', {
              deadManSwitchId: deadManSwitch.id.toString(),
              deliveryStatus: status,
            })
            continue
          }
          if (status !== 'missing') {
            throw new Error('Durable email delivery status is unavailable.')
          }
        }

        const body = this.composeBody(deadManSwitch)

        const accepted = await this.emailSender.sendEmail(deadManSwitch.props.recipientEmail, EMAIL_SUBJECT, body, {
          deliverySource: 'account',
          deliveryId,
          retryMode: 'indefinite',
        })
        if (!accepted) {
          // Delivery failed (transient SMTP error). Record the failure and
          // schedule the next retry on the escalating backoff. Do not block the
          // rest of the batch.
          await this.recordFailure(deadManSwitch, 'Email sender reported the message was not sent.', now)

          continue
        }

        if (this.emailSender.acceptanceMode === 'durable-queue') {
          // Queue acceptance transfers retry ownership but is not proof that a
          // provider accepted the message. Reconcile on a later scan.
          continue
        }

        if (await this.markTriggered(deadManSwitch, now)) {
          triggeredCount++
        }
      } catch (error) {
        // A single failure must never block the rest of the batch. Record it and
        // schedule a retry like any other delivery failure.
        await this.recordFailure(deadManSwitch, (error as Error).message, now)
      }
    }

    return Result.ok(triggeredCount)
  }

  private async durableDeliveryStatus(deliveryId: string): Promise<EmailDeliveryStatus> {
    try {
      if (!this.emailSender.getDeliveryStatus) {
        throw new Error('Missing durable status adapter.')
      }
      return await this.emailSender.getDeliveryStatus(deliveryId)
    } catch {
      throw new Error('Durable email delivery status is unavailable.')
    }
  }

  private async markTriggered(deadManSwitch: DeadManSwitch, now: number): Promise<boolean> {
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
      this.logger.error('Could not mark a dead-man switch as triggered.', {
        deadManSwitchId: deadManSwitch.id.toString(),
      })

      return false
    }

    await this.deadManSwitchRepository.save(triggeredOrError.getValue())

    return true
  }

  // Persists a failed send: increments the attempt counter, stores the error and
  // schedules the next retry on the escalating backoff. After the last entry the
  // switch keeps retrying at the final interval (~6 months) — never giving up.
  private async recordFailure(deadManSwitch: DeadManSwitch, errorMessage: string, now: number): Promise<void> {
    try {
      const sendAttempts = deadManSwitch.props.sendAttempts + 1
      const backoffIndex = Math.min(sendAttempts - 1, RETRY_BACKOFF_MS.length - 1)
      const nextAttemptAt = now + RETRY_BACKOFF_MS[backoffIndex]

      this.logger.error('Failed to deliver a dead-man-switch email.', {
        deadManSwitchId: deadManSwitch.id.toString(),
        sendAttempt: sendAttempts,
        nextAttemptAt: new Date(nextAttemptAt).toISOString(),
        senderReportedNotSent: errorMessage === 'Email sender reported the message was not sent.',
      })

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
        this.logger.error('Could not record a dead-man-switch failure.', {
          deadManSwitchId: deadManSwitch.id.toString(),
        })

        return
      }

      await this.deadManSwitchRepository.save(updatedOrError.getValue())
    } catch (error) {
      this.logger.error('Error recording a dead-man-switch failure.', {
        deadManSwitchId: deadManSwitch.id.toString(),
        ...safeErrorLogMetadata(error),
      })
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
