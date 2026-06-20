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
}
