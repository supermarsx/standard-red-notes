import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'

import { RemoveUserFromGroupDTO } from './RemoveUserFromGroupDTO'

export class RemoveUserFromGroup implements UseCaseInterface<string> {
  constructor(private groupRepository: GroupRepositoryInterface) {}

  async execute(dto: RemoveUserFromGroupDTO): Promise<Result<string>> {
    const groupUuidOrError = Uuid.create(dto.groupUuid)
    if (groupUuidOrError.isFailed()) {
      return Result.fail(`Could not remove user from group: ${groupUuidOrError.getError()}`)
    }

    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not remove user from group: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const group = await this.groupRepository.findById(new UniqueEntityId(dto.groupUuid))
    if (group === null) {
      return Result.fail('Could not remove user from group: group not found.')
    }

    await this.groupRepository.removeUser(group.id, userUuid)

    return Result.ok(dto.userUuid)
  }
}
