import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { AddUserToGroupDTO } from './AddUserToGroupDTO'

export class AddUserToGroup implements UseCaseInterface<string> {
  constructor(
    private groupRepository: GroupRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: AddUserToGroupDTO): Promise<Result<string>> {
    const groupUuidOrError = Uuid.create(dto.groupUuid)
    if (groupUuidOrError.isFailed()) {
      return Result.fail(`Could not add user to group: ${groupUuidOrError.getError()}`)
    }

    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not add user to group: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const group = await this.groupRepository.findById(new UniqueEntityId(dto.groupUuid))
    if (group === null) {
      return Result.fail('Could not add user to group: group not found.')
    }

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not add user to group: user not found.')
    }

    await this.groupRepository.addUser(group.id, userUuid)

    return Result.ok(dto.userUuid)
  }
}
