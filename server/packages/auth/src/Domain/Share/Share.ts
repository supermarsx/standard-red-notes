import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { ShareProps } from './ShareProps'

export class Share extends Entity<ShareProps> {
  private constructor(props: ShareProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: ShareProps, id?: UniqueEntityId): Result<Share> {
    if (props.type !== 'note' && props.type !== 'tag' && props.type !== 'account') {
      return Result.fail<Share>('Share type must be one of note, tag or account')
    }

    if (props.encryptedPayload.length === 0) {
      return Result.fail<Share>('Share encrypted payload cannot be empty')
    }

    if (props.nickname !== null && props.nickname.length > 255) {
      return Result.fail<Share>('Share nickname cannot be longer than 255 characters')
    }

    if (
      props.viewExpiresMinutes !== null &&
      (!Number.isInteger(props.viewExpiresMinutes) || props.viewExpiresMinutes <= 0)
    ) {
      return Result.fail<Share>('Share view expiry minutes must be a positive integer')
    }

    return Result.ok<Share>(new Share(props, id))
  }
}
