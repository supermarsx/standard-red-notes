import { Result, RoleName, UseCaseInterface } from '@standardnotes/domain-core'

import { Role } from '../../Role/Role'
import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { RolePermissionsView } from '../ListRolesWithPermissions/RolePermissionsView'
import { normalizeCustomRoleName } from '../../Role/CustomRoleName'

import { CreateCustomRoleDTO } from './CreateCustomRoleDTO'

/**
 * Standard Red Notes: create an admin-defined CUSTOM role.
 *
 * FEASIBILITY: this is the SAFE subset of "custom roles". A custom role is a
 * plain row in the `roles` table (name + optional description + version 1) whose
 * granted permissions are drawn from the seeded catalog. It is NOT a member of
 * the canonical RoleName enum, so it is deliberately conferrable ONLY through
 * GROUPS — the group -> effective-permissions -> cross-service-token pipeline
 * resolves role NAMES as strings against the DB (role_permissions join), never
 * through the fixed enum. Direct user assignment and subscription conferral of
 * custom roles are intentionally out of scope (they run through the RoleName
 * value object, which is enum-bound across the entitlement core).
 *
 * GUARDS (server-side, never trusting the client):
 *   - the name is normalized to a SCREAMING_SNAKE identifier and must be
 *     non-empty and <= 255 chars;
 *   - it can never shadow a built-in (enum) role name;
 *   - it must not collide with an existing role row;
 *   - every requested permission must already exist in the catalog.
 */
export class CreateCustomRole implements UseCaseInterface<RolePermissionsView> {
  constructor(
    private roleRepository: RoleRepositoryInterface,
    private permissionRepository: PermissionRepositoryInterface,
  ) {}

  async execute(dto: CreateCustomRoleDTO): Promise<Result<RolePermissionsView>> {
    const normalizedName = normalizeCustomRoleName(dto.name)
    if (normalizedName === null) {
      return Result.fail(
        'Could not create custom role: name must contain at least one letter or digit ' +
          '(letters, digits and underscores only).',
      )
    }
    if (normalizedName.length > 255) {
      return Result.fail('Could not create custom role: name is too long (max 255 characters).')
    }

    if (Object.values(RoleName.NAMES).includes(normalizedName)) {
      return Result.fail(`Could not create custom role: '${normalizedName}' is a reserved built-in role name.`)
    }

    const existing = await this.roleRepository.findOneByName(normalizedName)
    if (existing !== null) {
      return Result.fail(`Could not create custom role: a role named '${normalizedName}' already exists.`)
    }

    if (dto.permissionNames !== undefined && !Array.isArray(dto.permissionNames)) {
      return Result.fail('Could not create custom role: permissionNames must be an array.')
    }

    const requestedNames = Array.from(new Set(dto.permissionNames ?? []))
    const permissions = await this.permissionRepository.findByNames(requestedNames)
    const resolvedNames = new Set(permissions.map((permission) => permission.name))
    const unknownNames = requestedNames.filter((name) => !resolvedNames.has(name))
    if (unknownNames.length > 0) {
      return Result.fail(
        `Could not create custom role: unknown permission(s): ${unknownNames.join(', ')}. ` +
          'Only permissions from the existing catalog can be assigned.',
      )
    }

    const description =
      dto.description !== undefined && dto.description !== null && dto.description.trim().length > 0
        ? dto.description.trim().slice(0, 512)
        : null

    const now = new Date()
    const role = new Role()
    role.name = normalizedName
    role.version = 1
    role.description = description
    role.createdAt = now
    role.updatedAt = now
    role.permissions = Promise.resolve(permissions)

    await this.roleRepository.save(role)

    return Result.ok({
      uuid: role.uuid,
      name: role.name,
      label: role.name,
      version: role.version,
      isBuiltIn: false,
      isCustom: true,
      description: role.description,
      permissionNames: Array.from(resolvedNames).sort((a, b) => a.localeCompare(b)),
    })
  }
}
