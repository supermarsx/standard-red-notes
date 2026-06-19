import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { AppPassword } from '../../Domain/AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../Domain/AppPassword/AppPasswordRepositoryInterface'
import { TypeORMAppPassword } from './TypeORMAppPassword'

export class TypeORMAppPasswordRepository implements AppPasswordRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMAppPassword>,
    private mapper: MapperInterface<AppPassword, TypeORMAppPassword>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<AppPassword[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('app_password')
      .where('app_password.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('app_password.created_at', 'DESC')
      .getMany()

    return typeOrm.map((appPassword) => this.mapper.toDomain(appPassword))
  }

  async findById(id: UniqueEntityId): Promise<AppPassword | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('app_password')
      .where('app_password.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async save(appPassword: AppPassword): Promise<void> {
    const persistence = this.mapper.toProjection(appPassword)

    await this.ormRepository.save(persistence)
  }

  async updateLastUsedAt(id: UniqueEntityId, lastUsedAt: Date): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .update()
      .set({
        lastUsedAt,
      })
      .where('uuid = :uuid', {
        uuid: id.toString(),
      })
      .execute()
  }

  async remove(appPassword: AppPassword): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(appPassword))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }
}
