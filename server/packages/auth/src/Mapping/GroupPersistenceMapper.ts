import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { Group } from '../Domain/Group/Group'
import { TypeORMGroup } from '../Infra/TypeORM/TypeORMGroup'

/**
 * Standard Red Notes: maps between the Group domain entity and its persistence
 * row. The group's conferred role names live in a separate join table
 * (`rbac_group_roles`) and are NOT carried on TypeORMGroup; the repository is
 * responsible for hydrating `roleNames` before calling toDomain and for
 * persisting them after toProjection.
 */
export class GroupPersistenceMapper implements MapperInterface<Group, TypeORMGroup> {
  toDomain(projection: TypeORMGroup): Group {
    const groupOrError = Group.create(
      {
        name: projection.name,
        description: projection.description ?? null,
        createdAt: new Date(Number(projection.createdAt)),
        updatedAt: new Date(Number(projection.updatedAt)),
        // Hydrated by the repository after the row is mapped.
        roleNames: [],
      },
      new UniqueEntityId(projection.uuid),
    )
    if (groupOrError.isFailed()) {
      throw new Error(`Failed to create group from projection: ${groupOrError.getError()}`)
    }

    return groupOrError.getValue()
  }

  toProjection(domain: Group): TypeORMGroup {
    const typeorm = new TypeORMGroup()

    typeorm.uuid = domain.id.toString()
    typeorm.name = domain.props.name
    typeorm.description = domain.props.description
    typeorm.createdAt = domain.props.createdAt.getTime()
    typeorm.updatedAt = domain.props.updatedAt.getTime()

    return typeorm
  }
}
