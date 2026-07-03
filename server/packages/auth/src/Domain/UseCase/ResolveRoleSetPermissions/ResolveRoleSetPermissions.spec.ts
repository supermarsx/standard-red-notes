import 'reflect-metadata'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { Role } from '../../Role/Role'
import { Permission } from '../../Permission/Permission'

import { ResolveRoleSetPermissions } from './ResolveRoleSetPermissions'

describe('ResolveRoleSetPermissions', () => {
  let roleRepository: RoleRepositoryInterface

  const permission = (name: string): Permission => ({ name }) as Permission
  const role = (name: string, permissions: string[]): Role =>
    ({ name, permissions: Promise.resolve(permissions.map((p) => permission(p))) }) as unknown as Role

  const createUseCase = () => new ResolveRoleSetPermissions(roleRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findOneByName = jest.fn().mockImplementation(async (name: string) => {
      if (name === 'CORE_USER') {
        return role('CORE_USER', ['a', 'b'])
      }
      if (name === 'SUPPORT_AGENT') {
        return role('SUPPORT_AGENT', ['b', 'c'])
      }
      return null
    })
  })

  it('unions the permissions across the resolved roles and reports unknowns', async () => {
    const result = await createUseCase().execute({ roleNames: ['CORE_USER', 'SUPPORT_AGENT', 'MISSING'] })

    expect(result.isFailed()).toBe(false)
    const view = result.getValue()
    expect(view.effectivePermissionNames).toEqual(['a', 'b', 'c'])
    expect(view.roleNames.sort()).toEqual(['CORE_USER', 'SUPPORT_AGENT'])
    expect(view.unknownRoleNames).toEqual(['MISSING'])
    expect(view.perRole).toHaveLength(2)
  })

  it('rejects a non-array payload', async () => {
    const result = await createUseCase().execute({ roleNames: 'CORE_USER' as unknown as string[] })

    expect(result.isFailed()).toBe(true)
  })
})
