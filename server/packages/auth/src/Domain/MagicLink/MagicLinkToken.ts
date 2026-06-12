import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { MagicLinkTokenProps } from './MagicLinkTokenProps'

export class MagicLinkToken extends Entity<MagicLinkTokenProps> {
  private constructor(props: MagicLinkTokenProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: MagicLinkTokenProps, id?: UniqueEntityId): Result<MagicLinkToken> {
    return Result.ok<MagicLinkToken>(new MagicLinkToken(props, id))
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime()
  }
}
