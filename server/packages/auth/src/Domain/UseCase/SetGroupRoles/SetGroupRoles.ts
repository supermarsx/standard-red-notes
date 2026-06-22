import { Result, RoleName, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Group } from '../../Group/Group'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'

import { SetGroupRolesDTO } from './SetGroupRolesDTO'

/**
 * Standard Red Notes: replaces the full set of role names a group confers on its
 * members. Because the codebase already maps roles -> permissions (via the
 * `role_permissions` table), assigning roles to a group is how a group "sets
 * permissions" on its members. Each supplied role name is validated against the
 * known RoleName.NAMES.
 */
export class SetGroupRoles implements UseCaseInterface<Group> {
  constructor(private groupRepository: GroupRepositoryInterface) {}

  async execute(dto: SetGroupRolesDTO): Promise<Result<Group>> {
    const groupUuidOrError = Uuid.create(dto.groupUuid)
    if (groupUuidOrError.isFailed()) {
      return Result.fail(`Could not set group roles: ${groupUuidOrError.getError()}`)
    }

    if (!Array.isArray(dto.roleNames)) {
      return Result.fail('Could not set group roles: roleNames must be an array.')
    }

    const sanitized: string[] = []
    for (const roleName of dto.roleNames) {
      const roleNameOrError = RoleName.create(roleName)
      if (roleNameOrError.isFailed()) {
        return Result.fail(`Could not set group roles: ${roleNameOrError.getError()}`)
      }
      sanitized.push(roleNameOrError.getValue().value)
    }

    const group = await this.groupRepository.findById(new UniqueEntityId(dto.groupUuid))
    if (group === null) {
      return Result.fail('Could not set group roles: group not found.')
    }

    group.props.roleNames = Array.from(new Set(sanitized))
    group.props.updatedAt = new Date()

    await this.groupRepository.save(group)

    return Result.ok(group)
  }
}
