import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { Role } from '../../Role/Role'
import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { isCanonicalAdminRole } from '../../Role/CanonicalRoles'

import { PermissionCatalog, PermissionCatalogEntry } from './PermissionCatalogView'

/**
 * Standard Red Notes: read model for the admin PERMISSION CATALOG browser. Lists
 * every seeded permission with its derived category (prefix before the first
 * ':' , e.g. 'server' for 'server:files') and a "granted-by" view — the active
 * roles that currently confer it. Read-only, so no audit entry.
 */
export class GetPermissionCatalog implements UseCaseInterface<PermissionCatalog> {
  constructor(
    private roleRepository: RoleRepositoryInterface,
    private permissionRepository: PermissionRepositoryInterface,
  ) {}

  async execute(): Promise<Result<PermissionCatalog>> {
    const allRoles = await this.roleRepository.findAll()

    // Active (highest-version) role row per name.
    const activeByName = new Map<string, Role>()
    for (const role of allRoles) {
      const existing = activeByName.get(role.name)
      if (existing === undefined || role.version > existing.version) {
        activeByName.set(role.name, role)
      }
    }

    // permission name -> role names granting it. Restricted to the canonical
    // four-role taxonomy the admin surface exposes (PLUS_USER / legacy hidden).
    const grantedBy = new Map<string, Set<string>>()
    for (const role of activeByName.values()) {
      if (!isCanonicalAdminRole(role.name)) {
        continue
      }
      const permissions = await role.permissions
      for (const permission of permissions) {
        const set = grantedBy.get(permission.name) ?? new Set<string>()
        set.add(role.name)
        grantedBy.set(permission.name, set)
      }
    }

    const catalog = await this.permissionRepository.findAll()
    const categories = new Set<string>()
    const permissions: PermissionCatalogEntry[] = catalog
      .map((permission) => {
        const category = this.categoryOf(permission.name)
        categories.add(category)

        return {
          name: permission.name,
          category,
          grantedByRoleNames: Array.from(grantedBy.get(permission.name) ?? new Set<string>()).sort((a, b) =>
            a.localeCompare(b),
          ),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))

    return Result.ok({
      permissions,
      categories: Array.from(categories).sort((a, b) => a.localeCompare(b)),
    })
  }

  private categoryOf(permissionName: string): string {
    const separatorIndex = permissionName.indexOf(':')
    if (separatorIndex > 0) {
      return permissionName.slice(0, separatorIndex)
    }

    return 'general'
  }
}
