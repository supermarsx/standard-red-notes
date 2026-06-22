import { Result, RoleName, UseCaseInterface } from '@standardnotes/domain-core'

import { Group } from '../../Group/Group'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'

import { CreateGroupDTO } from './CreateGroupDTO'

export class CreateGroup implements UseCaseInterface<Group> {
  constructor(private groupRepository: GroupRepositoryInterface) {}

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

    const roleNames = this.sanitizeRoleNames(dto.roleNames)
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

  private sanitizeRoleNames(roleNames?: string[]): Result<string[]> {
    if (roleNames === undefined || roleNames === null) {
      return Result.ok([])
    }

    if (!Array.isArray(roleNames)) {
      return Result.fail('roleNames must be an array of role names.')
    }

    const sanitized: string[] = []
    for (const roleName of roleNames) {
      const roleNameOrError = RoleName.create(roleName)
      if (roleNameOrError.isFailed()) {
        return Result.fail(roleNameOrError.getError())
      }
      sanitized.push(roleNameOrError.getValue().value)
    }

    return Result.ok(Array.from(new Set(sanitized)))
  }
}
