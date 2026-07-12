import { MapperInterface } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { SignupInviteLink } from '../../Domain/SignupInvite/SignupInviteLink'
import { SignupInviteLinkRepositoryInterface } from '../../Domain/SignupInvite/SignupInviteLinkRepositoryInterface'

import { TypeORMSignupInviteLink } from './TypeORMSignupInviteLink'

export class TypeORMSignupInviteLinkRepository implements SignupInviteLinkRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMSignupInviteLink>,
    private mapper: MapperInterface<SignupInviteLink, TypeORMSignupInviteLink>,
  ) {}

  async save(link: SignupInviteLink): Promise<void> {
    const persistence = this.mapper.toProjection(link)

    await this.ormRepository.save(persistence)
  }

  async findByHashedToken(hashedToken: string): Promise<SignupInviteLink | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('signup_invite_link')
      .where('signup_invite_link.hashed_token = :hashedToken', { hashedToken })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async findByUuid(uuid: string): Promise<SignupInviteLink | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('signup_invite_link')
      .where('signup_invite_link.uuid = :uuid', { uuid })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  /**
   * ATOMIC slot consume. A single conditional UPDATE increments used_count ONLY
   * while every validity condition holds; the WHERE re-checks them under the row
   * lock the UPDATE takes, so concurrent callers serialize on the row and two
   * consumes on a 1-slot link cannot both affect a row. `result.affected === 1`
   * means the slot was consumed; 0 means invalid/exhausted/expired/revoked.
   */
  async consumeSlot(hashedToken: string, now: Date): Promise<boolean> {
    const result = await this.ormRepository
      .createQueryBuilder()
      .update(TypeORMSignupInviteLink)
      .set({
        usedCount: () => 'used_count + 1',
        updatedAt: now,
      })
      .where('hashed_token = :hashedToken', { hashedToken })
      .andWhere('revoked = :revoked', { revoked: false })
      .andWhere('used_count < max_uses')
      .andWhere('(expires_at IS NULL OR expires_at > :now)', { now })
      .execute()

    return result.affected === 1
  }

  async listAll(): Promise<SignupInviteLink[]> {
    const rows = await this.ormRepository
      .createQueryBuilder('signup_invite_link')
      .orderBy('signup_invite_link.created_at', 'DESC')
      .addOrderBy('signup_invite_link.uuid', 'ASC')
      .getMany()

    return rows.map((row) => this.mapper.toDomain(row))
  }

  async listByCreatorUser(userUuid: string): Promise<SignupInviteLink[]> {
    const rows = await this.ormRepository
      .createQueryBuilder('signup_invite_link')
      .where('signup_invite_link.created_by_user_uuid = :userUuid', { userUuid })
      .orderBy('signup_invite_link.created_at', 'DESC')
      .addOrderBy('signup_invite_link.uuid', 'ASC')
      .getMany()

    return rows.map((row) => this.mapper.toDomain(row))
  }

  async countActiveByCreatorUser(userUuid: string, now: Date): Promise<number> {
    return this.ormRepository
      .createQueryBuilder('signup_invite_link')
      .where('signup_invite_link.created_by_user_uuid = :userUuid', { userUuid })
      .andWhere('signup_invite_link.revoked = :revoked', { revoked: false })
      .andWhere('signup_invite_link.used_count < signup_invite_link.max_uses')
      .andWhere('(signup_invite_link.expires_at IS NULL OR signup_invite_link.expires_at > :now)', { now })
      .getCount()
  }

  async revokeByUuid(uuid: string): Promise<boolean> {
    const result = await this.ormRepository
      .createQueryBuilder()
      .update(TypeORMSignupInviteLink)
      .set({ revoked: true, updatedAt: new Date() })
      .where('uuid = :uuid', { uuid })
      .andWhere('revoked = :revoked', { revoked: false })
      .execute()

    return result.affected === 1
  }
}
