import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { DeadManSwitch } from '../../Domain/DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../Domain/DeadManSwitch/DeadManSwitchRepositoryInterface'
import { TypeORMDeadManSwitch } from './TypeORMDeadManSwitch'

export class TypeORMDeadManSwitchRepository implements DeadManSwitchRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMDeadManSwitch>,
    private mapper: MapperInterface<DeadManSwitch, TypeORMDeadManSwitch>,
  ) {}

  async findByUserUuid(userUuid: Uuid): Promise<DeadManSwitch[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('dead_man_switch')
      .where('dead_man_switch.user_uuid = :userUuid', {
        userUuid: userUuid.value,
      })
      .orderBy('dead_man_switch.created_at', 'DESC')
      .getMany()

    return typeOrm.map((deadManSwitch) => this.mapper.toDomain(deadManSwitch))
  }

  async findById(id: UniqueEntityId): Promise<DeadManSwitch | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('dead_man_switch')
      .where('dead_man_switch.uuid = :id', {
        id: id.toString(),
      })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async findDue(now: number): Promise<DeadManSwitch[]> {
    const typeOrm = await this.ormRepository
      .createQueryBuilder('dead_man_switch')
      .where('dead_man_switch.triggered = :triggered', { triggered: false })
      .andWhere('dead_man_switch.deadline <= :now', { now })
      .getMany()

    return typeOrm.map((deadManSwitch) => this.mapper.toDomain(deadManSwitch))
  }

  async save(deadManSwitch: DeadManSwitch): Promise<void> {
    const persistence = this.mapper.toProjection(deadManSwitch)

    await this.ormRepository.save(persistence)
  }

  async remove(deadManSwitch: DeadManSwitch): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(deadManSwitch))
  }

  async removeByUserUuid(userUuid: Uuid): Promise<void> {
    await this.ormRepository
      .createQueryBuilder()
      .delete()
      .where('user_uuid = :userUuid', { userUuid: userUuid.value })
      .execute()
  }
}
