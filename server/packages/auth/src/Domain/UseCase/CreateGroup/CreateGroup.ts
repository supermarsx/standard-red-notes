import { Result, RoleName, UseCaseInterface } from '@standardnotes/domain-core'

import { Group } from '../../Group/Group'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'

import { CreateGroupDTO } from './CreateGroupDTO'

export class CreateGroup implements UseCaseInterface<Group> {
  constructor(
    private groupRepository: GroupRepositoryInterface,
    // Standard Red Notes: optional role repository enabling groups to confer
    // admin-created CUSTOM roles too. When present, a role name that is not a
    // built-in (enum) role is accepted as long as a role row of that name exists
    // in the database. When absent, validation falls back to the built-in enum
    // only (previous behaviour), so existing constructions keep working.
    private roleRepository?: RoleRepositoryInterface,
  ) {}

  async execute(dto: CreateGroupDTO): Promise<Result<Group>> {
    const name = typeof dto.name === 'string' ? dto.name.trim() : ''
    if (name.length === 0) {
      return Result.fail('Could not create group: name is required.')
    }

    const existing = await this.groupRepository.findByName(name)
    if (existing !== null) {
      return Result.fail(`Could not create group: a group named '${name}' already exists.`)
    }

    const description =
      dto.description !== undefined && dto.description !== null && dto.description.trim().length > 0
        ? dto.description.trim()
        : null

    const roleNames = await this.sanitizeRoleNames(dto.roleNames)
    if (roleNames.isFailed()) {
      return Result.fail(`Could not create group: ${roleNames.getError()}`)
    }

    const now = new Date()

    const groupOrError = Group.create({
      name,
      description,
      createdAt: now,
      updatedAt: now,
      roleNames: roleNames.getValue(),
    })
    if (groupOrError.isFailed()) {
      return Result.fail(`Could not create group: ${groupOrError.getError()}`)
    }
    const group = groupOrError.getValue()

    await this.groupRepository.save(group)

    return Result.ok(group)
  }

  private async sanitizeRoleNames(roleNames?: string[]): Promise<Result<string[]>> {
    if (roleNames === undefined || roleNames === null) {
      return Result.ok([])
    }

    if (!Array.isArray(roleNames)) {
      return Result.fail('roleNames must be an array of role names.')
    }

    const sanitized: string[] = []
    for (const roleName of roleNames) {
      const resolved = await resolveConferrableRoleName(roleName, this.roleRepository)
      if (resolved.isFailed()) {
        return Result.fail(resolved.getError())
      }
      sanitized.push(resolved.getValue())
    }

    return Result.ok(Array.from(new Set(sanitized)))
  }
}

/**
 * Standard Red Notes: validate a role name a GROUP may confer. A built-in (enum)
 * role validates exactly as before. Otherwise, when a role repository is
 * available, an admin-created CUSTOM role is accepted iff a role row of that
 * name exists — so a group can only ever confer a role that really resolves to
 * permissions. Shared by CreateGroup and SetGroupRoles.
 */
export const resolveConferrableRoleName = async (
  roleName: string,
  roleRepository?: RoleRepositoryInterface,
): Promise<Result<string>> => {
  const builtInOrError = RoleName.create(roleName)
  if (!builtInOrError.isFailed()) {
    return Result.ok(builtInOrError.getValue().value)
  }

  if (roleRepository !== undefined && typeof roleName === 'string' && roleName.length > 0) {
    const role = await roleRepository.findOneByName(roleName)
    if (role !== null) {
      return Result.ok(role.name)
    }
  }

  return Result.fail(builtInOrError.getError())
}
