import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { GroupProps } from './GroupProps'

export class Group extends Entity<GroupProps> {
  private constructor(props: GroupProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: GroupProps, id?: UniqueEntityId): Result<Group> {
    if (props.name.length === 0) {
      return Result.fail<Group>('Group name cannot be empty')
    }

    if (props.name.length > 255) {
      return Result.fail<Group>('Group name cannot be longer than 255 characters')
    }

    if (props.description !== null && props.description.length > 1024) {
      return Result.fail<Group>('Group description cannot be longer than 1024 characters')
    }

    return Result.ok<Group>(new Group(props, id))
  }
}
