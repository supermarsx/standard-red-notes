import 'reflect-metadata'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { Role } from '../../Role/Role'
import { Permission } from '../../Permission/Permission'

import { SetRolePermissions } from './SetRolePermissions'

describe('SetRolePermissions', () => {
  let roleRepository: RoleRepositoryInterface
  let permissionRepository: PermissionRepositoryInterface

  const roleUuid = '00000000-0000-0000-0000-000000000001'

  const permission = (name: string): Permission => ({ name }) as Permission

  const createUseCase = () => new SetRolePermissions(roleRepository, permissionRepository)

  let role: Role

  beforeEach(() => {
    role = {
      uuid: roleUuid,
      name: 'CORE_USER',
      version: 1,
      permissions: Promise.resolve([]),
    } as unknown as Role

    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findOneByUuid = jest.fn().mockResolvedValue(role)
    roleRepository.save = jest.fn().mockResolvedValue(undefined)

    permissionRepository = {} as jest.Mocked<PermissionRepositoryInterface>
    permissionRepository.findByNames = jest
      .fn()
      .mockImplementation(async (names: string[]) => names.map((name) => permission(name)))
  })

  it('replaces the role permissions and returns the built-in role view', async () => {
    const result = await createUseCase().execute({
      roleUuid,
      permissionNames: ['SYNC_ITEMS', 'MANAGE_USERS', 'SYNC_ITEMS'],
    })

    expect(result.isFailed()).toBe(false)
    expect(roleRepository.save).toHaveBeenCalledTimes(1)
    const view = result.getValue()
    expect(view.name).toEqual('CORE_USER')
    expect(view.isBuiltIn).toBe(true)
    // Deduplicated + sorted.
    expect(view.permissionNames).toEqual(['MANAGE_USERS', 'SYNC_ITEMS'])
  })

  it('fails with an invalid role uuid', async () => {
    const result = await createUseCase().execute({ roleUuid: 'not-a-uuid', permissionNames: [] })

    expect(result.isFailed()).toBe(true)
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('fails when the role does not exist', async () => {
    roleRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ roleUuid, permissionNames: ['SYNC_ITEMS'] })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('role not found')
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects permission names that are not in the catalog', async () => {
    permissionRepository.findByNames = jest.fn().mockResolvedValue([permission('SYNC_ITEMS')])

    const result = await createUseCase().execute({ roleUuid, permissionNames: ['SYNC_ITEMS', 'MADE_UP_PERMISSION'] })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('MADE_UP_PERMISSION')
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects a non-array permissionNames payload', async () => {
    const result = await createUseCase().execute({
      roleUuid,
      permissionNames: 'SYNC_ITEMS' as unknown as string[],
    })

    expect(result.isFailed()).toBe(true)
    expect(roleRepository.save).not.toHaveBeenCalled()
  })
})
