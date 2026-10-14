import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { Share } from '../../Domain/Share/Share'
import { ShareRepositoryInterface } from '../../Domain/Share/ShareRepositoryInterface'
import { TypeORMShare } from './TypeORMShare'

export class TypeORMShareRepository implements ShareRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMShare>,
    private mapper: MapperInterface<Share, TypeORMShare>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<Share[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('share')
      .where('share.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('share.created_at', 'DESC')
      .getMany()

    return typeOrm.map((share) => this.mapper.toDomain(share))
  }

  async findById(id: UniqueEntityId): Promise<Share | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('share')
      .where('share.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async save(share: Share): Promise<void> {
    const persistence = this.mapper.toProjection(share)

    await this.ormRepository.save(persistence)
  }

  async remove(share: Share): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(share))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }

  async markFirstOpenedAtomically(id: UniqueEntityId, openedAt: Date): Promise<boolean> {
    // Conditional UPDATE: only stamp first_opened_at when it is still NULL. The DB
    // serializes concurrent writers, so exactly one near-simultaneous opener gets
    // affected === 1 (the winner); the rest get 0. This is the atomic "first wins"
    // guard for burn-after-reading consumption.
    const result = await this.ormRepository
      .createQueryBuilder()
      .update()
      .set({ firstOpenedAt: openedAt.getTime() })
      .where('uuid = :id', { id: id.toString() })
      .andWhere('first_opened_at IS NULL')
      .andWhere('revoked = :revoked', { revoked: false })
      .execute()

    return (result.affected ?? 0) > 0
  }

  async markRevoked(id: UniqueEntityId): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .update()
      .set({ revoked: true, encryptedPayload: '' })
      .where('uuid = :id', { id: id.toString() })
      .execute()
  }

  async revokeExpiredAndErasePayloads(now: Date, userUuid?: Uuid): Promise<void> {
    const query = this.ormRepository
      .createQueryBuilder()
      .update()
      .set({ revoked: true, encryptedPayload: '' })
      .where(
        '((revoked = :revoked AND encrypted_payload <> :empty) OR ' +
          '(revoked = :active AND first_opened_at IS NOT NULL AND (' +
          '(view_expires_minutes IS NOT NULL AND first_opened_at + view_expires_minutes * 60000 <= :now) OR ' +
          '(one_time_view = :oneTime AND view_expires_minutes IS NULL))))',
        { revoked: true, active: false, empty: '', now: now.getTime(), oneTime: true },
      )
    if (userUuid) {
      // Parentheses keep the requesting user's scope over both branches.
      query.andWhere('user_uuid = :userUuid', { userUuid: userUuid.value })
    }
    await query.execute()
  }
}
