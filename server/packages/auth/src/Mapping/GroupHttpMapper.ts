import { MapperInterface } from '@standardnotes/domain-core'

import { Group } from '../Domain/Group/Group'
import { GroupHttpProjection } from '../Infra/Http/Projection/GroupHttpProjection'

export class GroupHttpMapper implements MapperInterface<Group, GroupHttpProjection> {
  toDomain(_projection: GroupHttpProjection): Group {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: Group): GroupHttpProjection {
    return {
      uuid: domain.id.toString(),
      name: domain.props.name,
      description: domain.props.description,
      roleNames: domain.props.roleNames,
      createdAt: domain.props.createdAt.toISOString(),
      updatedAt: domain.props.updatedAt.toISOString(),
    }
  }
}
