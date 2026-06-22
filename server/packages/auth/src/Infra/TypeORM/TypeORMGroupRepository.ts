import { MapperInterface, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { Group } from '../../Domain/Group/Group'
import { GroupRepositoryInterface } from '../../Domain/Group/GroupRepositoryInterface'
import { TypeORMGroup } from './TypeORMGroup'
import { TypeORMGroupRole } from './TypeORMGroupRole'
import { TypeORMUserGroup } from './TypeORMUserGroup'

export class TypeORMGroupRepository implements GroupRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMGroup>,
    private ormGroupRoleRepository: Repository<TypeORMGroupRole>,
    private ormUserGroupRepository: Repository<TypeORMUserGroup>,
    private mapper: MapperInterface<Group, TypeORMGroup>,
  ) {}

  async findAll(): Promise<Group[]> {
    const persistence = await this.ormRepository.createQueryBuilder('group').orderBy('group.name', 'ASC').getMany()

    return Promise.all(persistence.map((row) => this.hydrate(row)))
  }

  async findById(id: UniqueEntityId): Promise<Group | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('group')
      .where('group.uuid = :id', { id: id.toString() })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.hydrate(persistence)
  }

  async findByName(name: string): Promise<Group | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('group')
      .where('group.name = :name', { name })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.hydrate(persistence)
  }

  async findByUserUuid(userUuid: Uuid): Promise<Group[]> {
    const memberships = await this.ormUserGroupRepository
      .createQueryBuilder('userGroup')
      .where('userGroup.user_uuid = :userUuid', { userUuid: userUuid.value })
      .getMany()

    if (memberships.length === 0) {
      return []
    }

    const groupUuids = memberships.map((membership) => membership.groupUuid)

    const persistence = await this.ormRepository
      .createQueryBuilder('group')
      .where('group.uuid IN (:...groupUuids)', { groupUuids })
      .getMany()

    return Promise.all(persistence.map((row) => this.hydrate(row)))
  }

  async save(group: Group): Promise<void> {
    const persistence = this.mapper.toProjection(group)

    await this.ormRepository.save(persistence)

    // Re-write the group's conferred role names: clear existing rows then insert
    // the current set. Cheap and avoids diffing for the small cardinalities here.
    await this.ormGroupRoleRepository
      .createQueryBuilder()
      .delete()
      .where('group_uuid = :groupUuid', { groupUuid: group.id.toString() })
      .execute()

    const uniqueRoleNames = Array.from(new Set(group.props.roleNames))
    if (uniqueRoleNames.length > 0) {
      await this.ormGroupRoleRepository
        .createQueryBuilder()
        .insert()
        .values(
          uniqueRoleNames.map((roleName) => ({
            groupUuid: group.id.toString(),
            roleName,
          })),
        )
        .execute()
    }
  }

  async remove(group: Group): Promise<void> {
    await this.ormGroupRoleRepository
      .createQueryBuilder()
      .delete()
      .where('group_uuid = :groupUuid', { groupUuid: group.id.toString() })
      .execute()

    await this.ormUserGroupRepository
      .createQueryBuilder()
      .delete()
      .where('group_uuid = :groupUuid', { groupUuid: group.id.toString() })
      .execute()

    await this.ormRepository.remove(this.mapper.toProjection(group))
  }

  async addUser(groupId: UniqueEntityId, userUuid: Uuid): Promise<void> {
    const existing = await this.ormUserGroupRepository
      .createQueryBuilder('userGroup')
      .where('userGroup.group_uuid = :groupUuid AND userGroup.user_uuid = :userUuid', {
        groupUuid: groupId.toString(),
        userUuid: userUuid.value,
      })
      .getOne()

    if (existing !== null) {
      return
    }

    const membership = new TypeORMUserGroup()
    membership.groupUuid = groupId.toString()
    membership.userUuid = userUuid.value
    membership.createdAt = new Date().getTime()

    await this.ormUserGroupRepository.save(membership)
  }

  async removeUser(groupId: UniqueEntityId, userUuid: Uuid): Promise<void> {
    await this.ormUserGroupRepository
      .createQueryBuilder()
      .delete()
      .where('group_uuid = :groupUuid AND user_uuid = :userUuid', {
        groupUuid: groupId.toString(),
        userUuid: userUuid.value,
      })
      .execute()
  }

  async findMemberUuids(groupId: UniqueEntityId): Promise<string[]> {
    const memberships = await this.ormUserGroupRepository
      .createQueryBuilder('userGroup')
      .where('userGroup.group_uuid = :groupUuid', { groupUuid: groupId.toString() })
      .getMany()

    return memberships.map((membership) => membership.userUuid)
  }

  private async hydrate(row: TypeORMGroup): Promise<Group> {
    const group = this.mapper.toDomain(row)

    const roleRows = await this.ormGroupRoleRepository
      .createQueryBuilder('groupRole')
      .where('groupRole.group_uuid = :groupUuid', { groupUuid: row.uuid })
      .getMany()

    group.props.roleNames = roleRows.map((roleRow) => roleRow.roleName)

    return group
  }
}
