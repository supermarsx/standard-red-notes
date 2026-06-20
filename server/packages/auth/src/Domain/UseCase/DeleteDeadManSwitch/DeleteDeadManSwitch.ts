import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'

import { DeleteDeadManSwitchDTO } from './DeleteDeadManSwitchDTO'

export class DeleteDeadManSwitch implements UseCaseInterface<string> {
  constructor(private deadManSwitchRepository: DeadManSwitchRepositoryInterface) {}

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

    await this.deadManSwitchRepository.remove(deadManSwitch)

    return Result.ok('Dead man switch deleted')
  }
}
