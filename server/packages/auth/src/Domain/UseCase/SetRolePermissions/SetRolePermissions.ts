import { Result, RoleName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { RolePermissionsView } from '../ListRolesWithPermissions/RolePermissionsView'

import { SetRolePermissionsDTO } from './SetRolePermissionsDTO'

/**
 * Standard Red Notes: replace the full set of PERMISSIONS a role grants
 * (role_permissions), from the seeded permission catalog.
 *
 * BUILT-IN GUARD (enforced server-side, never trusting the client): this use
 * case only ever mutates the role_permissions join table for an EXISTING role
 * addressed by uuid. It cannot create, rename or delete a role — role identity
 * is migration-managed. Every requested permission name must already exist in
 * the catalog, so an admin can never fabricate a permission type either.
 */
export class SetRolePermissions implements UseCaseInterface<RolePermissionsView> {
  constructor(
    private roleRepository: RoleRepositoryInterface,
    private permissionRepository: PermissionRepositoryInterface,
  ) {}

  async execute(dto: SetRolePermissionsDTO): Promise<Result<RolePermissionsView>> {
    const roleUuidOrError = Uuid.create(dto.roleUuid)
    if (roleUuidOrError.isFailed()) {
      return Result.fail(`Could not set role permissions: ${roleUuidOrError.getError()}`)
    }

    if (!Array.isArray(dto.permissionNames)) {
      return Result.fail('Could not set role permissions: permissionNames must be an array.')
    }

    const role = await this.roleRepository.findOneByUuid(roleUuidOrError.getValue().value)
    if (role === null) {
      return Result.fail('Could not set role permissions: role not found.')
    }

    const requestedNames = Array.from(new Set(dto.permissionNames))
    const permissions = await this.permissionRepository.findByNames(requestedNames)
    const resolvedNames = new Set(permissions.map((permission) => permission.name))
    const unknownNames = requestedNames.filter((name) => !resolvedNames.has(name))
    if (unknownNames.length > 0) {
      return Result.fail(
        `Could not set role permissions: unknown permission(s): ${unknownNames.join(', ')}. ` +
          'Only permissions from the existing catalog can be assigned.',
      )
    }

    role.permissions = Promise.resolve(permissions)
    await this.roleRepository.save(role)

    return Result.ok({
      uuid: role.uuid,
      name: role.name,
      version: role.version,
      isBuiltIn: Object.values(RoleName.NAMES).includes(role.name),
      permissionNames: Array.from(resolvedNames).sort((a, b) => a.localeCompare(b)),
    })
  }
}
