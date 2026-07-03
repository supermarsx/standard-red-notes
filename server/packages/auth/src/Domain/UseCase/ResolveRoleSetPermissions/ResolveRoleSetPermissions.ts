import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'

import { ResolveRoleSetPermissionsDTO } from './ResolveRoleSetPermissionsDTO'
import { RoleSetPermissionsView } from './RoleSetPermissionsView'

/**
 * Standard Red Notes: resolve a SET of role names to the union of the
 * permissions they grant — the admin effective-permissions SIMULATOR. Reuses the
 * same role -> permission (role_permissions) resolution the runtime uses; role
 * names are matched by the active (highest-version) row via findOneByName, so it
 * honours both built-in and custom roles. Read-only, so no audit entry.
 */
export class ResolveRoleSetPermissions implements UseCaseInterface<RoleSetPermissionsView> {
  constructor(private roleRepository: RoleRepositoryInterface) {}

  async execute(dto: ResolveRoleSetPermissionsDTO): Promise<Result<RoleSetPermissionsView>> {
    if (!Array.isArray(dto.roleNames)) {
      return Result.fail('Could not resolve role-set permissions: roleNames must be an array.')
    }

    const requested = Array.from(new Set(dto.roleNames.filter((name) => typeof name === 'string' && name.length > 0)))

    const resolvedRoleNames: string[] = []
    const unknownRoleNames: string[] = []
    const perRole: Array<{ name: string; permissionNames: string[] }> = []
    const unionPermissions = new Set<string>()

    for (const roleName of requested) {
      const role = await this.roleRepository.findOneByName(roleName)
      if (role === null) {
        unknownRoleNames.push(roleName)
        continue
      }

      resolvedRoleNames.push(role.name)
      const permissions = await role.permissions
      const permissionNames = permissions.map((permission) => permission.name).sort((a, b) => a.localeCompare(b))
      for (const permissionName of permissionNames) {
        unionPermissions.add(permissionName)
      }
      perRole.push({ name: role.name, permissionNames })
    }

    return Result.ok({
      roleNames: resolvedRoleNames,
      unknownRoleNames,
      effectivePermissionNames: Array.from(unionPermissions).sort((a, b) => a.localeCompare(b)),
      perRole: perRole.sort((a, b) => a.name.localeCompare(b.name)),
    })
  }
}
