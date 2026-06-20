import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { TrustedDevice } from '../../Domain/TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../Domain/TrustedDevice/TrustedDeviceRepositoryInterface'
import { TypeORMTrustedDevice } from './TypeORMTrustedDevice'

export class TypeORMTrustedDeviceRepository implements TrustedDeviceRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMTrustedDevice>,
    private mapper: MapperInterface<TrustedDevice, TypeORMTrustedDevice>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<TrustedDevice[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('trusted_device')
      .where('trusted_device.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('trusted_device.created_at', 'DESC')
      .getMany()

    return typeOrm.map((trustedDevice) => this.mapper.toDomain(trustedDevice))
  }

  async findById(id: UniqueEntityId): Promise<TrustedDevice | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('trusted_device')
      .where('trusted_device.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async save(trustedDevice: TrustedDevice): Promise<void> {
    const persistence = this.mapper.toProjection(trustedDevice)

    await this.ormRepository.save(persistence)
  }

  async remove(trustedDevice: TrustedDevice): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(trustedDevice))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }
}
