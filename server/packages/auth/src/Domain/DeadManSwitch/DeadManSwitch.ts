import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitchProps } from './DeadManSwitchProps'

export class DeadManSwitch extends Entity<DeadManSwitchProps> {
  private constructor(props: DeadManSwitchProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: DeadManSwitchProps, id?: UniqueEntityId): Result<DeadManSwitch> {
    if (props.recipientEmail.length === 0) {
      return Result.fail<DeadManSwitch>('Dead man switch recipient email cannot be empty')
    }

    if (props.shareUrl.length === 0) {
      return Result.fail<DeadManSwitch>('Dead man switch share url cannot be empty')
    }

    if (props.intervalDays < 1) {
      return Result.fail<DeadManSwitch>('Dead man switch interval must be at least 1 day')
    }

    return Result.ok<DeadManSwitch>(new DeadManSwitch(props, id))
  }
}
