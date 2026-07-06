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
  const role = (name: string, version = 1, description: string | null = null): Role =>
    ({ uuid: `${name}-uuid`, name, version, description, permissions: Promise.resolve([]) }) as unknown as Role

  const createUseCase = () => new ListRolesWithPermissions(roleRepository, permissionRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findAll = jest.fn().mockResolvedValue([
      role(RoleName.NAMES.CoreUser),
      role(RoleName.NAMES.ProUser),
      role(RoleName.NAMES.AdminUser),
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
      RoleName.NAMES.AdminUser,
      RoleName.NAMES.ProUser,
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.VaultsUser,
    ])
    expect(roles.map((r) => r.label)).toEqual(['Admin user', 'Full user', 'Core user', 'Vaults user'])

    // PLUS_USER and legacy roles are hidden.
    expect(roles.some((r) => r.name === RoleName.NAMES.PlusUser)).toBe(false)
    expect(roles.some((r) => r.name === 'TRANSITION_USER')).toBe(false)

    expect(builtInRoleNames).toEqual([
      RoleName.NAMES.AdminUser,
      RoleName.NAMES.ProUser,
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.VaultsUser,
    ])
  })

  it('gives each canonical role a non-empty description (canonical default when DB is null)', async () => {
    const result = await createUseCase().execute()

    const { roles } = result.getValue()

    // The built-in four seed a null DB description, so each must fall back to a
    // non-empty canonical default.
    expect(roles).toHaveLength(4)
    for (const r of roles) {
      expect(typeof r.description).toBe('string')
      expect((r.description as string).length).toBeGreaterThan(0)
    }

    const byName = new Map(roles.map((r) => [r.name, r.description]))
    expect(byName.get(RoleName.NAMES.AdminUser)).toMatch(/administrative/i)
    expect(byName.get(RoleName.NAMES.CoreUser)).toMatch(/standard account/i)
  })

  it("lets a role's own DB description win over the canonical default", async () => {
    roleRepository.findAll = jest
      .fn()
      .mockResolvedValue([role(RoleName.NAMES.CoreUser, 1, 'A bespoke description for this deployment.')])

    const result = await createUseCase().execute()

    const core = result.getValue().roles.find((r) => r.name === RoleName.NAMES.CoreUser)
    expect(core?.description).toBe('A bespoke description for this deployment.')
  })

  it('falls back to the canonical default when the DB description is blank whitespace', async () => {
    roleRepository.findAll = jest.fn().mockResolvedValue([role(RoleName.NAMES.CoreUser, 1, '   ')])

    const result = await createUseCase().execute()

    const core = result.getValue().roles.find((r) => r.name === RoleName.NAMES.CoreUser)
    expect(core?.description).toMatch(/standard account/i)
  })
})
