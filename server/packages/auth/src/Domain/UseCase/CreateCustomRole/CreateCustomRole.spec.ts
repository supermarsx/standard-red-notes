import 'reflect-metadata'

import { RoleName } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { Permission } from '../../Permission/Permission'

import { CreateCustomRole } from './CreateCustomRole'

describe('CreateCustomRole', () => {
  let roleRepository: RoleRepositoryInterface
  let permissionRepository: PermissionRepositoryInterface

  const permission = (name: string): Permission => ({ name }) as Permission

  const createUseCase = () => new CreateCustomRole(roleRepository, permissionRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findOneByName = jest.fn().mockResolvedValue(null)
    roleRepository.save = jest.fn().mockResolvedValue(undefined)

    permissionRepository = {} as jest.Mocked<PermissionRepositoryInterface>
    permissionRepository.findByNames = jest
      .fn()
      .mockImplementation(async (names: string[]) => names.map((name) => permission(name)))
  })

  it('creates a custom role, normalizing the name and marking it custom', async () => {
    const result = await createUseCase().execute({
      name: 'Support Agent',
      description: 'Front-line support',
      permissionNames: ['SYNC_ITEMS', 'MANAGE_USERS'],
    })

    expect(result.isFailed()).toBe(false)
    expect(roleRepository.save).toHaveBeenCalledTimes(1)
    const view = result.getValue()
    expect(view.name).toEqual('SUPPORT_AGENT')
    expect(view.isBuiltIn).toBe(false)
    expect(view.isCustom).toBe(true)
    expect(view.description).toEqual('Front-line support')
    expect(view.permissionNames).toEqual(['MANAGE_USERS', 'SYNC_ITEMS'])
  })

  it('refuses to shadow a built-in role name', async () => {
    const result = await createUseCase().execute({ name: RoleName.NAMES.CoreUser })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('reserved built-in')
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects an empty / punctuation-only name', async () => {
    const result = await createUseCase().execute({ name: '   !!!  ' })

    expect(result.isFailed()).toBe(true)
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects a normalized name longer than the database column limit', async () => {
    const result = await createUseCase().execute({ name: 'a'.repeat(256) })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('max 255 characters')
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects a duplicate role name', async () => {
    roleRepository.findOneByName = jest.fn().mockResolvedValue({ name: 'SUPPORT_AGENT' })

    const result = await createUseCase().execute({ name: 'Support Agent' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('already exists')
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects permissions not in the catalog', async () => {
    permissionRepository.findByNames = jest.fn().mockResolvedValue([permission('SYNC_ITEMS')])

    const result = await createUseCase().execute({
      name: 'Support Agent',
      permissionNames: ['SYNC_ITEMS', 'MADE_UP'],
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('MADE_UP')
    expect(roleRepository.save).not.toHaveBeenCalled()
  })

  it('rejects a non-array permissionNames payload', async () => {
    const result = await createUseCase().execute({
      name: 'Support Agent',
      permissionNames: 'SYNC_ITEMS' as unknown as string[],
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('permissionNames must be an array')
    expect(permissionRepository.findByNames).not.toHaveBeenCalled()
    expect(roleRepository.save).not.toHaveBeenCalled()
  })
})
