import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { cancelDurableEmailDelivery } from '../../Email/DurableEmailCancellation'
import { createDeadManSwitchEmailDeliveryId } from '../../Email/EmailDeliveryId'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { DeleteDeadManSwitchDTO } from './DeleteDeadManSwitchDTO'

export class DeleteDeadManSwitch implements UseCaseInterface<string> {
  constructor(
    private deadManSwitchRepository: DeadManSwitchRepositoryInterface,
    private emailSender: EmailSenderInterface,
  ) {}

  async execute(dto: DeleteDeadManSwitchDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not delete dead man switch: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const deadManSwitch = await this.deadManSwitchRepository.findById(new UniqueEntityId(dto.switchId))
    // Ownership check: never allow deleting another user's switch.
    if (!deadManSwitch || deadManSwitch.props.userUuid !== userUuid.value) {
      return Result.fail('Dead man switch not found')
    }

    try {
      const cancellation = await cancelDurableEmailDelivery(
        this.emailSender,
        createDeadManSwitchEmailDeliveryId(deadManSwitch.id.toString(), deadManSwitch.props.deadline),
      )
      if (cancellation === 'in-flight') {
        return Result.fail('Could not delete dead man switch: the current email delivery is already in flight.')
      }
    } catch {
      return Result.fail('Could not delete dead man switch: durable email delivery cancellation is unavailable.')
    }

    await this.deadManSwitchRepository.remove(deadManSwitch)

    return Result.ok('Dead man switch deleted')
  }
}
