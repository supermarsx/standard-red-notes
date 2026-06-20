import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'

import { ListDeadManSwitchesDTO } from './ListDeadManSwitchesDTO'

export class ListDeadManSwitches implements UseCaseInterface<DeadManSwitch[]> {
  constructor(private deadManSwitchRepository: DeadManSwitchRepositoryInterface) {}

  async execute(dto: ListDeadManSwitchesDTO): Promise<Result<DeadManSwitch[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list dead man switches: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    // Repository scopes by user uuid, so other users' switches never leak.
    const switches = await this.deadManSwitchRepository.findByUserUuid(userUuid)

    return Result.ok(switches)
  }
}
