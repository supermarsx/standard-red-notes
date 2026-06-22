import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'

import { DeleteGroupDTO } from './DeleteGroupDTO'

export class DeleteGroup implements UseCaseInterface<string> {
  constructor(private groupRepository: GroupRepositoryInterface) {}

  async execute(dto: DeleteGroupDTO): Promise<Result<string>> {
    const groupUuidOrError = Uuid.create(dto.groupUuid)
    if (groupUuidOrError.isFailed()) {
      return Result.fail(`Could not delete group: ${groupUuidOrError.getError()}`)
    }

    const group = await this.groupRepository.findById(new UniqueEntityId(dto.groupUuid))
    if (group === null) {
      return Result.fail('Could not delete group: group not found.')
    }

    await this.groupRepository.remove(group)

    return Result.ok(dto.groupUuid)
  }
}
