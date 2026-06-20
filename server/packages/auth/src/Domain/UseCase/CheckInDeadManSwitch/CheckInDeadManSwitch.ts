import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'

import { CheckInDeadManSwitchDTO } from './CheckInDeadManSwitchDTO'

const MS_PER_DAY = 86_400_000

export class CheckInDeadManSwitch implements UseCaseInterface<number> {
  constructor(private deadManSwitchRepository: DeadManSwitchRepositoryInterface) {}

  async execute(dto: CheckInDeadManSwitchDTO): Promise<Result<number>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not check in: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const deadManSwitch = await this.deadManSwitchRepository.findById(new UniqueEntityId(dto.switchId))
    // Ownership check: never allow checking in on another user's switch.
    if (!deadManSwitch || deadManSwitch.props.userUuid !== userUuid.value) {
      return Result.fail('Dead man switch not found')
    }

    const now = Date.now()
    const deadline = now + deadManSwitch.props.intervalDays * MS_PER_DAY

    const updatedOrError = DeadManSwitch.create(
      {
        userUuid: deadManSwitch.props.userUuid,
        recipientEmail: deadManSwitch.props.recipientEmail,
        shareUrl: deadManSwitch.props.shareUrl,
        message: deadManSwitch.props.message,
        intervalDays: deadManSwitch.props.intervalDays,
        deadline,
        // Re-arm: a check-in clears any prior trigger so a recovered user keeps
        // the switch alive.
        triggered: false,
        lastCheckInAt: now,
        createdAt: deadManSwitch.props.createdAt,
      },
      new UniqueEntityId(deadManSwitch.id.toString()),
    )
    if (updatedOrError.isFailed()) {
      return Result.fail(`Could not check in: ${updatedOrError.getError()}`)
    }

    await this.deadManSwitchRepository.save(updatedOrError.getValue())

    return Result.ok(deadline)
  }
}
