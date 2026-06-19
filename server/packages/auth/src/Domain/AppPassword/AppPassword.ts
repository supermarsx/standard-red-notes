import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { AppPasswordProps } from './AppPasswordProps'

export class AppPassword extends Entity<AppPasswordProps> {
  private constructor(props: AppPasswordProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: AppPasswordProps, id?: UniqueEntityId): Result<AppPassword> {
    if (props.label.length === 0) {
      return Result.fail<AppPassword>('App password label cannot be empty')
    }

    if (props.label.length > 255) {
      return Result.fail<AppPassword>('App password label cannot be longer than 255 characters')
    }

    return Result.ok<AppPassword>(new AppPassword(props, id))
  }
}
