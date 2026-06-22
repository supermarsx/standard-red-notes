import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { ListGroupMembersDTO } from './ListGroupMembersDTO'

export interface GroupMemberProjection {
  uuid: string
  email: string | null
}

export class ListGroupMembers implements UseCaseInterface<GroupMemberProjection[]> {
  constructor(
    private groupRepository: GroupRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: ListGroupMembersDTO): Promise<Result<GroupMemberProjection[]>> {
    const groupUuidOrError = Uuid.create(dto.groupUuid)
    if (groupUuidOrError.isFailed()) {
      return Result.fail(`Could not list group members: ${groupUuidOrError.getError()}`)
    }

    const group = await this.groupRepository.findById(new UniqueEntityId(dto.groupUuid))
    if (group === null) {
      return Result.fail('Could not list group members: group not found.')
    }

    const memberUuids = await this.groupRepository.findMemberUuids(group.id)

    const members: GroupMemberProjection[] = []
    for (const memberUuid of memberUuids) {
      const userUuidOrError = Uuid.create(memberUuid)
      if (userUuidOrError.isFailed()) {
        continue
      }

      const user = await this.userRepository.findOneByUuid(userUuidOrError.getValue())
      members.push({
        uuid: memberUuid,
        email: user?.email ?? null,
      })
    }

    return Result.ok(members)
  }
}
