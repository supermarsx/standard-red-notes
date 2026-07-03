import 'reflect-metadata'

import { RoleName } from '@standardnotes/domain-core'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { Role } from '../../Role/Role'

import { DeleteCustomRole } from './DeleteCustomRole'

describe('DeleteCustomRole', () => {
  let roleRepository: RoleRepositoryInterface
  let groupRepository: GroupRepositoryInterface

  const roleUuid = '00000000-0000-0000-0000-000000000001'

  const customRole = (): Role =>
    ({ uuid: roleUuid, name: 'SUPPORT_AGENT', users: Promise.resolve([]) }) as unknown as Role

  const createUseCase = () => new DeleteCustomRole(roleRepository, groupRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findOneByUuid = jest.fn().mockResolvedValue(customRole())
    roleRepository.remove = jest.fn().mockResolvedValue(undefined)

    groupRepository = {} as jest.Mocked<GroupRepositoryInterface>
    groupRepository.findAll = jest.fn().mockResolvedValue([])
  })

  it('deletes an unused custom role', async () => {
    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().name).toEqual('SUPPORT_AGENT')
    expect(roleRepository.remove).toHaveBeenCalledTimes(1)
  })

  it('refuses to delete a built-in role', async () => {
    roleRepository.findOneByUuid = jest
      .fn()
      .mockResolvedValue({ uuid: roleUuid, name: RoleName.NAMES.CoreUser, users: Promise.resolve([]) })

    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('built-in role')
    expect(roleRepository.remove).not.toHaveBeenCalled()
  })

  it('refuses to delete a role still conferred by a group', async () => {
    groupRepository.findAll = jest
      .fn()
      .mockResolvedValue([{ props: { name: 'Admins', roleNames: ['SUPPORT_AGENT'] } }])

    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('conferred by')
    expect(roleRepository.remove).not.toHaveBeenCalled()
  })

  it('refuses to delete a role a user still holds directly', async () => {
    roleRepository.findOneByUuid = jest
      .fn()
      .mockResolvedValue({ uuid: roleUuid, name: 'SUPPORT_AGENT', users: Promise.resolve([{ uuid: 'u1' }]) })

    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('hold it directly')
    expect(roleRepository.remove).not.toHaveBeenCalled()
  })

  it('fails when the role does not exist', async () => {
    roleRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('not found')
  })
})
