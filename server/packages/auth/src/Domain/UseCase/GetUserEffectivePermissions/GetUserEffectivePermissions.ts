import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { EffectivePermissions } from './EffectivePermissions'
import { GetUserEffectivePermissionsDTO } from './GetUserEffectivePermissionsDTO'

/**
 * Standard Red Notes: computes a user's EFFECTIVE access as the union of:
 *   - their directly-assigned roles (the existing `user_roles` mapping), and
 *   - the roles conferred by every RBAC group they belong to.
 *
 * Permissions are then derived from those effective roles using the existing
 * role -> permission mapping (`role_permissions`). Groups therefore layer on top
 * of the existing role model without altering it: a user in no groups resolves
 * to exactly their direct roles/permissions, identical to today's behaviour.
 */
export class GetUserEffectivePermissions implements UseCaseInterface<EffectivePermissions> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private groupRepository: GroupRepositoryInterface,
    private roleRepository: RoleRepositoryInterface,
  ) {}

  async execute(dto: GetUserEffectivePermissionsDTO): Promise<Result<EffectivePermissions>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not compute effective permissions: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not compute effective permissions: user not found.')
    }

    const directRoles = await user.roles
    const directRoleNames = directRoles.map((role) => role.name)

    const groups = await this.groupRepository.findByUserUuid(userUuid)
    const groupRoleNameSet = new Set<string>()
    for (const group of groups) {
      for (const roleName of group.props.roleNames) {
        groupRoleNameSet.add(roleName)
      }
    }
    const groupRoleNames = Array.from(groupRoleNameSet)

    const effectiveRoleNameSet = new Set<string>([...directRoleNames, ...groupRoleNames])
    const effectiveRoleNames = Array.from(effectiveRoleNameSet)

    // Resolve each effective role to its permission names through the existing
    // role -> permission mapping. Direct roles are already hydrated on the user;
    // group-conferred roles are looked up by name.
    const permissionNameSet = new Set<string>()
    const resolvedRoleNames = new Set<string>()

    for (const role of directRoles) {
      resolvedRoleNames.add(role.name)
      const permissions = await role.permissions
      for (const permission of permissions) {
        permissionNameSet.add(permission.name)
      }
    }

    for (const roleName of groupRoleNames) {
      if (resolvedRoleNames.has(roleName)) {
        continue
      }
      const role = await this.roleRepository.findOneByName(roleName)
      if (role === null) {
        continue
      }
      resolvedRoleNames.add(roleName)
      const permissions = await role.permissions
      for (const permission of permissions) {
        permissionNameSet.add(permission.name)
      }
    }

    return Result.ok({
      userUuid: userUuid.value,
      directRoleNames,
      groupRoleNames,
      effectiveRoleNames,
      effectivePermissionNames: Array.from(permissionNameSet),
    })
  }
}
