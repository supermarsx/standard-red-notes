import 'reflect-metadata'

import { RoleName, UniqueEntityId } from '@standardnotes/domain-core'

import { Group } from '../Group/Group'
import { GroupRepositoryInterface } from '../Group/GroupRepositoryInterface'
import { Permission } from '../Permission/Permission'
import { Role } from '../Role/Role'
import { RoleRepositoryInterface } from '../Role/RoleRepositoryInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { AddUserToGroup } from './AddUserToGroup/AddUserToGroup'
import { CreateGroup } from './CreateGroup/CreateGroup'
import { DeleteGroup } from './DeleteGroup/DeleteGroup'
import { GetUserEffectivePermissions } from './GetUserEffectivePermissions/GetUserEffectivePermissions'
import { ListGroupMembers } from './ListGroupMembers/ListGroupMembers'
import { ListGroups } from './ListGroups/ListGroups'
import { RemoveUserFromGroup } from './RemoveUserFromGroup/RemoveUserFromGroup'
import { SetGroupRoles } from './SetGroupRoles/SetGroupRoles'

const GROUP_UUID = '123e4567-e89b-42d3-a456-426614174000'
const USER_UUID = '123e4567-e89b-42d3-a456-426614174001'

const createGroup = (name = 'Operations', roleNames: string[] = []): Group =>
  Group.create(
    {
      name,
      description: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      roleNames,
    },
    new UniqueEntityId(GROUP_UUID),
  ).getValue()

const createGroupRepository = (): jest.Mocked<GroupRepositoryInterface> => {
  const repository = {} as jest.Mocked<GroupRepositoryInterface>
  repository.findAll = jest.fn().mockResolvedValue([])
  repository.findById = jest.fn().mockResolvedValue(null)
  repository.findByName = jest.fn().mockResolvedValue(null)
  repository.findByUserUuid = jest.fn().mockResolvedValue([])
  repository.save = jest.fn().mockResolvedValue(undefined)
  repository.remove = jest.fn().mockResolvedValue(undefined)
  repository.addUser = jest.fn().mockResolvedValue(undefined)
  repository.removeUser = jest.fn().mockResolvedValue(undefined)
  repository.findMemberUuids = jest.fn().mockResolvedValue([])

  return repository
}

const createRoleRepository = (): jest.Mocked<RoleRepositoryInterface> => {
  const repository = {} as jest.Mocked<RoleRepositoryInterface>
  repository.findOneByName = jest.fn().mockResolvedValue(null)
  repository.findAll = jest.fn().mockResolvedValue([])
  repository.findOneByUuid = jest.fn().mockResolvedValue(null)
  repository.save = jest.fn().mockResolvedValue(undefined)
  repository.remove = jest.fn().mockResolvedValue(undefined)

  return repository
}

const createUserRepository = (): jest.Mocked<UserRepositoryInterface> => {
  const repository = {} as jest.Mocked<UserRepositoryInterface>
  repository.findOneByUuid = jest.fn().mockResolvedValue(null)

  return repository
}

const createRole = (name: string, permissionNames: string[] = []): Role =>
  ({
    name,
    permissions: Promise.resolve(permissionNames.map((permissionName) => ({ name: permissionName }) as Permission)),
  }) as Role

describe('Group', () => {
  const props = {
    name: 'Operations',
    description: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    roleNames: [] as string[],
  }

  it('creates a valid group with the supplied identity', () => {
    const result = Group.create(props, new UniqueEntityId(GROUP_UUID))

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().id.toString()).toBe(GROUP_UUID)
  })

  it('rejects empty and overlong names and overlong descriptions', () => {
    expect(Group.create({ ...props, name: '' }).getError()).toBe('Group name cannot be empty')
    expect(Group.create({ ...props, name: 'x'.repeat(256) }).getError()).toContain('255')
    expect(Group.create({ ...props, description: 'x'.repeat(1025) }).getError()).toContain('1024')
  })
})

describe('CreateGroup', () => {
  let groupRepository: jest.Mocked<GroupRepositoryInterface>
  let roleRepository: jest.Mocked<RoleRepositoryInterface>

  beforeEach(() => {
    groupRepository = createGroupRepository()
    roleRepository = createRoleRepository()
  })

  it('normalizes fields and accepts built-in and persisted custom roles without duplicates', async () => {
    roleRepository.findOneByName.mockImplementation(async (name) => {
      return name === 'SUPPORT_AGENT' ? createRole(name) : null
    })

    const result = await new CreateGroup(groupRepository, roleRepository).execute({
      name: '  Operations  ',
      description: '  Handles incidents  ',
      roleNames: [RoleName.NAMES.CoreUser, 'SUPPORT_AGENT', RoleName.NAMES.CoreUser],
    })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().props).toMatchObject({
      name: 'Operations',
      description: 'Handles incidents',
      roleNames: [RoleName.NAMES.CoreUser, 'SUPPORT_AGENT'],
    })
    expect(groupRepository.save).toHaveBeenCalledWith(result.getValue())
  })

  it('creates a group with empty roles and a null description when optional fields are absent or blank', async () => {
    const absent = await new CreateGroup(groupRepository).execute({ name: 'No roles' })
    const blank = await new CreateGroup(groupRepository).execute({
      name: 'Blank description',
      description: '   ',
      roleNames: null as unknown as string[],
    })

    expect(absent.getValue().props).toMatchObject({ description: null, roleNames: [] })
    expect(blank.getValue().props).toMatchObject({ description: null, roleNames: [] })
  })

  it('rejects missing, duplicate, and overlong group names', async () => {
    const useCase = new CreateGroup(groupRepository)

    const missing = await useCase.execute({ name: null as unknown as string })
    expect(missing.getError()).toContain('name is required')

    groupRepository.findByName.mockResolvedValueOnce(createGroup())
    const duplicate = await useCase.execute({ name: 'Operations' })
    expect(duplicate.getError()).toContain('already exists')

    const overlong = await useCase.execute({ name: 'x'.repeat(256) })
    expect(overlong.getError()).toContain('255')
  })

  it('rejects malformed, unknown, and unresolved custom role names', async () => {
    const malformed = await new CreateGroup(groupRepository).execute({
      name: 'Malformed roles',
      roleNames: 'CORE_USER' as unknown as string[],
    })
    const unknown = await new CreateGroup(groupRepository).execute({
      name: 'Unknown role',
      roleNames: ['NOT_A_ROLE'],
    })
    const unresolved = await new CreateGroup(groupRepository, roleRepository).execute({
      name: 'Unresolved custom role',
      roleNames: ['MISSING_CUSTOM_ROLE'],
    })

    expect(malformed.getError()).toContain('must be an array')
    expect(unknown.isFailed()).toBe(true)
    expect(unresolved.isFailed()).toBe(true)
    expect(groupRepository.save).not.toHaveBeenCalled()
  })
})

describe('SetGroupRoles', () => {
  let groupRepository: jest.Mocked<GroupRepositoryInterface>
  let roleRepository: jest.Mocked<RoleRepositoryInterface>

  beforeEach(() => {
    groupRepository = createGroupRepository()
    roleRepository = createRoleRepository()
  })

  it('replaces group roles with deduplicated built-in and custom roles', async () => {
    const group = createGroup()
    groupRepository.findById.mockResolvedValue(group)
    roleRepository.findOneByName.mockResolvedValue(createRole('SUPPORT_AGENT'))

    const result = await new SetGroupRoles(groupRepository, roleRepository).execute({
      groupUuid: GROUP_UUID,
      roleNames: [RoleName.NAMES.CoreUser, 'SUPPORT_AGENT', RoleName.NAMES.CoreUser],
    })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().props.roleNames).toEqual([RoleName.NAMES.CoreUser, 'SUPPORT_AGENT'])
    expect(result.getValue().props.updatedAt.getTime()).toBeGreaterThan(group.props.createdAt.getTime())
    expect(groupRepository.save).toHaveBeenCalledWith(group)
  })

  it('rejects invalid input, unknown roles, and missing groups', async () => {
    const useCase = new SetGroupRoles(groupRepository)

    expect((await useCase.execute({ groupUuid: 'bad', roleNames: [] })).getError()).toContain('valid uuid')
    expect(
      (await useCase.execute({ groupUuid: GROUP_UUID, roleNames: 'CORE_USER' as unknown as string[] })).getError(),
    ).toContain('must be an array')
    expect((await useCase.execute({ groupUuid: GROUP_UUID, roleNames: ['UNKNOWN'] })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID, roleNames: [] })).getError()).toContain('group not found')
    expect(groupRepository.save).not.toHaveBeenCalled()
  })
})

describe('GetUserEffectivePermissions', () => {
  let groupRepository: jest.Mocked<GroupRepositoryInterface>
  let roleRepository: jest.Mocked<RoleRepositoryInterface>
  let userRepository: jest.Mocked<UserRepositoryInterface>

  beforeEach(() => {
    groupRepository = createGroupRepository()
    roleRepository = createRoleRepository()
    userRepository = createUserRepository()
  })

  it('unions direct and group roles and resolves unique effective permissions', async () => {
    const directRole = createRole(RoleName.NAMES.CoreUser, ['SYNC_ITEMS', 'DUPLICATE_PERMISSION'])
    const customRole = createRole('SUPPORT_AGENT', ['READ_AUDIT_LOG', 'DUPLICATE_PERMISSION'])
    userRepository.findOneByUuid.mockResolvedValue({ roles: Promise.resolve([directRole]) } as User)
    groupRepository.findByUserUuid.mockResolvedValue([
      createGroup('Operations', [RoleName.NAMES.CoreUser, 'SUPPORT_AGENT']),
      createGroup('Incident response', ['SUPPORT_AGENT', 'MISSING_ROLE']),
    ])
    roleRepository.findOneByName.mockImplementation(async (name) => (name === 'SUPPORT_AGENT' ? customRole : null))

    const result = await new GetUserEffectivePermissions(userRepository, groupRepository, roleRepository).execute({
      userUuid: USER_UUID,
    })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual({
      userUuid: USER_UUID,
      directRoleNames: [RoleName.NAMES.CoreUser],
      groupRoleNames: [RoleName.NAMES.CoreUser, 'SUPPORT_AGENT', 'MISSING_ROLE'],
      effectiveRoleNames: [RoleName.NAMES.CoreUser, 'SUPPORT_AGENT', 'MISSING_ROLE'],
      effectivePermissionNames: ['SYNC_ITEMS', 'DUPLICATE_PERMISSION', 'READ_AUDIT_LOG'],
    })
    expect(roleRepository.findOneByName).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid user ids and missing users', async () => {
    const useCase = new GetUserEffectivePermissions(userRepository, groupRepository, roleRepository)

    expect((await useCase.execute({ userUuid: 'bad' })).getError()).toContain('valid uuid')
    expect((await useCase.execute({ userUuid: USER_UUID })).getError()).toContain('user not found')
    expect(groupRepository.findByUserUuid).not.toHaveBeenCalled()
  })
})

describe('group membership use cases', () => {
  let group: Group
  let groupRepository: jest.Mocked<GroupRepositoryInterface>
  let userRepository: jest.Mocked<UserRepositoryInterface>

  beforeEach(() => {
    group = createGroup()
    groupRepository = createGroupRepository()
    userRepository = createUserRepository()
  })

  it('adds an existing user to an existing group', async () => {
    groupRepository.findById.mockResolvedValue(group)
    userRepository.findOneByUuid.mockResolvedValue({ uuid: USER_UUID } as User)

    const result = await new AddUserToGroup(groupRepository, userRepository).execute({
      groupUuid: GROUP_UUID,
      userUuid: USER_UUID,
    })

    expect(result.getValue()).toBe(USER_UUID)
    expect(groupRepository.addUser).toHaveBeenCalledWith(group.id, expect.objectContaining({ value: USER_UUID }))
  })

  it('rejects invalid identifiers and missing group or user records when adding', async () => {
    const useCase = new AddUserToGroup(groupRepository, userRepository)

    expect((await useCase.execute({ groupUuid: 'bad', userUuid: USER_UUID })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID, userUuid: 'bad' })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID, userUuid: USER_UUID })).getError()).toContain(
      'group not found',
    )

    groupRepository.findById.mockResolvedValue(group)
    expect((await useCase.execute({ groupUuid: GROUP_UUID, userUuid: USER_UUID })).getError()).toContain(
      'user not found',
    )
  })

  it('lists valid members while preserving missing-user rows as an email-less projection', async () => {
    const missingUserUuid = '123e4567-e89b-42d3-a456-426614174002'
    groupRepository.findById.mockResolvedValue(group)
    groupRepository.findMemberUuids.mockResolvedValue([USER_UUID, 'invalid', missingUserUuid])
    userRepository.findOneByUuid.mockImplementation(async (uuid) => {
      return uuid.value === USER_UUID ? ({ email: 'member@example.com' } as User) : null
    })

    const result = await new ListGroupMembers(groupRepository, userRepository).execute({ groupUuid: GROUP_UUID })

    expect(result.getValue()).toEqual([
      { uuid: USER_UUID, email: 'member@example.com' },
      { uuid: missingUserUuid, email: null },
    ])
  })

  it('rejects invalid or missing groups before listing members', async () => {
    const useCase = new ListGroupMembers(groupRepository, userRepository)

    expect((await useCase.execute({ groupUuid: 'bad' })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID })).getError()).toContain('group not found')
    expect(groupRepository.findMemberUuids).not.toHaveBeenCalled()
  })

  it('removes a user from an existing group', async () => {
    groupRepository.findById.mockResolvedValue(group)

    const result = await new RemoveUserFromGroup(groupRepository).execute({
      groupUuid: GROUP_UUID,
      userUuid: USER_UUID,
    })

    expect(result.getValue()).toBe(USER_UUID)
    expect(groupRepository.removeUser).toHaveBeenCalledWith(group.id, expect.objectContaining({ value: USER_UUID }))
  })

  it('rejects invalid identifiers and missing groups when removing a member', async () => {
    const useCase = new RemoveUserFromGroup(groupRepository)

    expect((await useCase.execute({ groupUuid: 'bad', userUuid: USER_UUID })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID, userUuid: 'bad' })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID, userUuid: USER_UUID })).getError()).toContain(
      'group not found',
    )
  })

  it('deletes an existing group and rejects invalid or missing groups', async () => {
    const useCase = new DeleteGroup(groupRepository)

    expect((await useCase.execute({ groupUuid: 'bad' })).isFailed()).toBe(true)
    expect((await useCase.execute({ groupUuid: GROUP_UUID })).getError()).toContain('group not found')

    groupRepository.findById.mockResolvedValue(group)
    expect((await useCase.execute({ groupUuid: GROUP_UUID })).getValue()).toBe(GROUP_UUID)
    expect(groupRepository.remove).toHaveBeenCalledWith(group)
  })

  it('returns every group from the repository', async () => {
    groupRepository.findAll.mockResolvedValue([group])

    const result = await new ListGroups(groupRepository).execute()

    expect(result.getValue()).toEqual([group])
  })
})
