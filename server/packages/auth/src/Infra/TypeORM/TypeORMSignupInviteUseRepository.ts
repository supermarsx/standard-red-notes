import { MapperInterface } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { SignupInviteUse } from '../../Domain/SignupInvite/SignupInviteUse'
import { SignupInviteUseRepositoryInterface } from '../../Domain/SignupInvite/SignupInviteUseRepositoryInterface'

import { TypeORMSignupInviteUse } from './TypeORMSignupInviteUse'

export class TypeORMSignupInviteUseRepository implements SignupInviteUseRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMSignupInviteUse>,
    private mapper: MapperInterface<SignupInviteUse, TypeORMSignupInviteUse>,
  ) {}

  async save(use: SignupInviteUse): Promise<void> {
    await this.ormRepository.save(this.mapper.toProjection(use))
  }

  async countByReferrer(referrerUserUuid: string): Promise<number> {
    return this.ormRepository
      .createQueryBuilder('signup_invite_use')
      .where('signup_invite_use.referrer_user_uuid = :referrerUserUuid', { referrerUserUuid })
      .getCount()
  }

  async countByLink(inviteLinkUuid: string): Promise<number> {
    return this.ormRepository
      .createQueryBuilder('signup_invite_use')
      .where('signup_invite_use.invite_link_uuid = :inviteLinkUuid', { inviteLinkUuid })
      .getCount()
  }
}
