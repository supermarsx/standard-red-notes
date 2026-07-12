import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { SignupInviteUseProps } from './SignupInviteUseProps'

/**
 * Standard Red Notes: an append-only ATTRIBUTION row written once per consumed
 * invite slot. Serves the usage audit ("who signed up via link L") and referral
 * attribution ("who X invited", via referrerUserUuid) without scanning the audit
 * log.
 */
export class SignupInviteUse extends Entity<SignupInviteUseProps> {
  private constructor(props: SignupInviteUseProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: SignupInviteUseProps, id?: UniqueEntityId): Result<SignupInviteUse> {
    return Result.ok<SignupInviteUse>(new SignupInviteUse(props, id))
  }
}
