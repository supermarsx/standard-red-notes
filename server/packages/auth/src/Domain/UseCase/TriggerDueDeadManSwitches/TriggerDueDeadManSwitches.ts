import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { TriggerDueDeadManSwitchesDTO } from './TriggerDueDeadManSwitchesDTO'

const EMAIL_SUBJECT = 'A Standard Red Notes message is waiting for you'

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
          // Delivery failed (transient SMTP error / not configured). Leave the
          // switch armed so it retries on the next scan. Do not block the rest.
          this.logger.error(
            `Failed to deliver dead man switch ${deadManSwitch.id.toString()} email. Leaving it armed for retry.`,
          )

          continue
        }

        const triggeredOrError = DeadManSwitch.create(
          {
            ...deadManSwitch.props,
            triggered: true,
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
        // A single failure must never block the rest of the batch.
        this.logger.error(
          `Error triggering dead man switch ${deadManSwitch.id.toString()}: ${(error as Error).message}`,
        )
      }
    }

    return Result.ok(triggeredCount)
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
