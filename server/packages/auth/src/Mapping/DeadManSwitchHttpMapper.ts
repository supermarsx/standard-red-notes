import { MapperInterface } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../Domain/DeadManSwitch/DeadManSwitch'
import { DeadManSwitchHttpProjection } from '../Infra/Http/Projection/DeadManSwitchHttpProjection'

export class DeadManSwitchHttpMapper implements MapperInterface<DeadManSwitch, DeadManSwitchHttpProjection> {
  toDomain(_projection: DeadManSwitchHttpProjection): DeadManSwitch {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: DeadManSwitch): DeadManSwitchHttpProjection {
    // Metadata only. NEVER include the shareUrl (it embeds the decryption key);
    // it is delivered exclusively to the recipient by email when the switch fires.
    return {
      uuid: domain.id.toString(),
      recipientEmail: domain.props.recipientEmail,
      message: domain.props.message,
      intervalDays: domain.props.intervalDays,
      deadline: domain.props.deadline,
      triggered: domain.props.triggered,
      lastCheckInAt: domain.props.lastCheckInAt,
      createdAt: domain.props.createdAt,
      // Retry/backoff state so the client can surface "retrying — next attempt at X".
      // lastError is deliberately omitted: it may contain sensitive SMTP detail.
      sendAttempts: domain.props.sendAttempts,
      nextAttemptAt: domain.props.nextAttemptAt,
      lastAttemptAt: domain.props.lastAttemptAt,
    }
  }
}
