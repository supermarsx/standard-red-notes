import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { Group } from '../../Group/Group'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'

export class ListGroups implements UseCaseInterface<Group[]> {
  constructor(private groupRepository: GroupRepositoryInterface) {}

  async execute(): Promise<Result<Group[]>> {
    const groups = await this.groupRepository.findAll()

    return Result.ok(groups)
  }
}
