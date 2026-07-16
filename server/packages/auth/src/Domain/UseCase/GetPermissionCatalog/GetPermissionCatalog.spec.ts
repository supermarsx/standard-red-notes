import 'reflect-metadata'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../../Permission/PermissionRepositoryInterface'
import { Role } from '../../Role/Role'
import { Permission } from '../../Permission/Permission'

import { GetPermissionCatalog } from './GetPermissionCatalog'

describe('GetPermissionCatalog', () => {
  let roleRepository: RoleRepositoryInterface
  let permissionRepository: PermissionRepositoryInterface

  const permission = (name: string): Permission => ({ name }) as Permission
  const role = (name: string, version: number, permissions: string[]): Role =>
    ({ name, version, permissions: Promise.resolve(permissions.map((p) => permission(p))) }) as unknown as Role

  const createUseCase = () => new GetPermissionCatalog(roleRepository, permissionRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findAll = jest
      .fn()
      .mockResolvedValue([
        role('CORE_USER', 1, ['sync:items', 'server:files']),
        role('PRO_USER', 1, ['server:files']),
        role('PLUS_USER', 1, ['server:files']),
      ])

    permissionRepository = {} as jest.Mocked<PermissionRepositoryInterface>
    permissionRepository.findAll = jest
      .fn()
      .mockResolvedValue([permission('server:files'), permission('sync:items'), permission('standalone')])
  })

  it('derives categories and the granting roles per permission', async () => {
    const result = await createUseCase().execute()

    expect(result.isFailed()).toBe(false)
    const catalog = result.getValue()

    const serverFiles = catalog.permissions.find((p) => p.name === 'server:files')
    expect(serverFiles?.category).toEqual('server')
    expect(serverFiles?.grantedByRoleNames).toEqual(['CORE_USER', 'PRO_USER'])

    const standalone = catalog.permissions.find((p) => p.name === 'standalone')
    expect(standalone?.category).toEqual('general')
    expect(standalone?.grantedByRoleNames).toEqual([])

    expect(catalog.categories).toContain('server')
    expect(catalog.categories).toContain('general')
  })
})
