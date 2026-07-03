import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { GetRoleHoldersDTO } from './GetRoleHoldersDTO'
import { RoleHoldersView } from './RoleHoldersView'

/**
 * Standard Red Notes: "who has this role" for the admin role inspector. Reuses
 * the admin user finder (a bounded COUNT — limit 1 — never a full scan) for the
 * DIRECT holder count, and the RBAC groups list for the groups that confer the
 * role. Read-only, so no audit entry.
 */
export class GetRoleHolders implements UseCaseInterface<RoleHoldersView> {
  constructor(
    private roleRepository: RoleRepositoryInterface,
    private groupRepository: GroupRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: GetRoleHoldersDTO): Promise<Result<RoleHoldersView>> {
    const roleUuidOrError = Uuid.create(dto.roleUuid)
    if (roleUuidOrError.isFailed()) {
      return Result.fail(`Could not resolve role holders: ${roleUuidOrError.getError()}`)
    }

    const role = await this.roleRepository.findOneByUuid(roleUuidOrError.getValue().value)
    if (role === null) {
      return Result.fail('Could not resolve role holders: role not found.')
    }

    const directResult = await this.userRepository.findUsersForAdmin({
      limit: 1,
      offset: 0,
      sort: 'createdAt',
      role: role.name,
    })

    const groups = await this.groupRepository.findAll()
    const conferringGroups = groups
      .filter((group) => group.props.roleNames.includes(role.name))
      .map((group) => ({ uuid: group.id.toString(), name: group.props.name }))

    return Result.ok({
      uuid: role.uuid,
      name: role.name,
      directUserCount: directResult.total,
      groups: conferringGroups,
    })
  }
}
