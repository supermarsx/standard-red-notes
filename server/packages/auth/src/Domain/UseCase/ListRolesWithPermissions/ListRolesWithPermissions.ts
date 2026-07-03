import { Result, RoleName, UseCaseInterface } from '@standardnotes/domain-core'

import { Role } from '../../Role/Role'
import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'

import { RolePermissionsView, RolesWithPermissions } from './RolePermissionsView'

/**
 * Standard Red Notes: read model for the admin Roles panel.
 *
 * Roles are enum + migration bound in this codebase (RoleName validates every
 * name against a fixed set, and the seed rows carry a version). New role TYPES
 * therefore cannot be created safely at runtime — a custom role could never be
 * assigned to a user or conferred by a group. What IS safe, and what this view
 * enables, is READING every role with its permissions and EDITING which seeded
 * permissions each role grants (the role_permissions join table).
 *
 * This use case returns, per role NAME, the active (highest-version) row — the
 * one findOneByName resolves — with its permissions, plus the full permission
 * catalog for the editor to draw from.
 */
export class ListRolesWithPermissions implements UseCaseInterface<RolesWithPermissions> {
  constructor(
    private roleRepository: RoleRepositoryInterface,
    private permissionRepository: PermissionRepositoryInterface,
  ) {}

  async execute(): Promise<Result<RolesWithPermissions>> {
    const builtInRoleNames = Object.values(RoleName.NAMES)

    const allRoles = await this.roleRepository.findAll()

    // Collapse to the active (highest-version) row per name.
    const activeByName = new Map<string, Role>()
    for (const role of allRoles) {
      const existing = activeByName.get(role.name)
      if (existing === undefined || role.version > existing.version) {
        activeByName.set(role.name, role)
      }
    }

    const roles: RolePermissionsView[] = []
    for (const role of activeByName.values()) {
      const permissions = await role.permissions
      roles.push({
        uuid: role.uuid,
        name: role.name,
        version: role.version,
        isBuiltIn: builtInRoleNames.includes(role.name),
        permissionNames: permissions.map((permission) => permission.name).sort((a, b) => a.localeCompare(b)),
      })
    }
    roles.sort((a, b) => a.name.localeCompare(b.name))

    const catalog = await this.permissionRepository.findAll()
    const permissions = catalog.map((permission) => permission.name).sort((a, b) => a.localeCompare(b))

    return Result.ok({ roles, permissions, builtInRoleNames })
  }
}
