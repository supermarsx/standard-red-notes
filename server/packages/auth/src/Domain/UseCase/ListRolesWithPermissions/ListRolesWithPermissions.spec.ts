import 'reflect-metadata'

import { RoleName } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { Role } from '../../Role/Role'
import { Permission } from '../../Permission/Permission'

import { ListRolesWithPermissions } from './ListRolesWithPermissions'

describe('ListRolesWithPermissions', () => {
  let roleRepository: RoleRepositoryInterface
  let permissionRepository: PermissionRepositoryInterface

  const permission = (name: string): Permission => ({ name }) as Permission
  const role = (name: string, version = 1): Role =>
    ({ uuid: `${name}-uuid`, name, version, description: null, permissions: Promise.resolve([]) }) as unknown as Role

  const createUseCase = () => new ListRolesWithPermissions(roleRepository, permissionRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findAll = jest.fn().mockResolvedValue([
      role(RoleName.NAMES.CoreUser),
      role(RoleName.NAMES.ProUser),
      role(RoleName.NAMES.InternalTeamUser),
      role(RoleName.NAMES.VaultsUser),
      // Hidden from the admin surface:
      role(RoleName.NAMES.PlusUser),
      role('TRANSITION_USER'),
    ])

    permissionRepository = {} as jest.Mocked<PermissionRepositoryInterface>
    permissionRepository.findAll = jest.fn().mockResolvedValue([permission('SYNC_ITEMS')])
  })

  it('exposes exactly the canonical four roles, labelled and in display order', async () => {
    const result = await createUseCase().execute()

    expect(result.isFailed()).toBe(false)
    const { roles, builtInRoleNames } = result.getValue()

    expect(roles.map((r) => r.name)).toEqual([
      RoleName.NAMES.InternalTeamUser,
      RoleName.NAMES.ProUser,
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.VaultsUser,
    ])
    expect(roles.map((r) => r.label)).toEqual(['Admin user', 'Full user', 'Core user', 'Vaults user'])

    // PLUS_USER and legacy roles are hidden.
    expect(roles.some((r) => r.name === RoleName.NAMES.PlusUser)).toBe(false)
    expect(roles.some((r) => r.name === 'TRANSITION_USER')).toBe(false)

    expect(builtInRoleNames).toEqual([
      RoleName.NAMES.InternalTeamUser,
      RoleName.NAMES.ProUser,
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.VaultsUser,
    ])
  })
})
