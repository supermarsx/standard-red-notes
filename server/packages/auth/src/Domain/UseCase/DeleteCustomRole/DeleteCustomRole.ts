import { Result, RoleName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'

import { DeleteCustomRoleDTO } from './DeleteCustomRoleDTO'

/**
 * Standard Red Notes: delete an admin-created CUSTOM role.
 *
 * GUARDS (server-side):
 *   - the role must exist and be addressed by uuid;
 *   - a BUILT-IN (enum) role can NEVER be deleted — its identity is migration
 *     managed and other subsystems (subscription mapping, token minting) assume
 *     it exists;
 *   - the role must be UNUSED: no group may still confer it and no user may hold
 *     it directly, so deletion can never silently strip access.
 */
export class DeleteCustomRole implements UseCaseInterface<{ uuid: string; name: string }> {
  constructor(
    private roleRepository: RoleRepositoryInterface,
    private groupRepository: GroupRepositoryInterface,
  ) {}

  async execute(dto: DeleteCustomRoleDTO): Promise<Result<{ uuid: string; name: string }>> {
    const roleUuidOrError = Uuid.create(dto.roleUuid)
    if (roleUuidOrError.isFailed()) {
      return Result.fail(`Could not delete custom role: ${roleUuidOrError.getError()}`)
    }

    const role = await this.roleRepository.findOneByUuid(roleUuidOrError.getValue().value)
    if (role === null) {
      return Result.fail('Could not delete custom role: role not found.')
    }

    if (Object.values(RoleName.NAMES).includes(role.name)) {
      return Result.fail(`Could not delete custom role: '${role.name}' is a built-in role and cannot be deleted.`)
    }

    const groups = await this.groupRepository.findAll()
    const conferringGroups = groups.filter((group) => group.props.roleNames.includes(role.name))
    if (conferringGroups.length > 0) {
      const names = conferringGroups.map((group) => group.props.name).join(', ')
      return Result.fail(
        `Could not delete custom role: it is still conferred by ${conferringGroups.length} group(s) (${names}). ` +
          'Remove it from those groups first.',
      )
    }

    const holders = await role.users
    if (holders.length > 0) {
      return Result.fail(
        `Could not delete custom role: ${holders.length} user(s) still hold it directly. ` +
          'Remove it from those users first.',
      )
    }

    const name = role.name
    await this.roleRepository.remove(role)

    return Result.ok({ uuid: dto.roleUuid, name })
  }
}
