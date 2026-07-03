import 'reflect-metadata'

import { RoleRepositoryInterface } from '../../Role/RoleRepositoryInterface'
import { GroupRepositoryInterface } from '../../Group/GroupRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { Role } from '../../Role/Role'

import { GetRoleHolders } from './GetRoleHolders'

describe('GetRoleHolders', () => {
  let roleRepository: RoleRepositoryInterface
  let groupRepository: GroupRepositoryInterface
  let userRepository: UserRepositoryInterface

  const roleUuid = '00000000-0000-0000-0000-000000000001'

  const createUseCase = () => new GetRoleHolders(roleRepository, groupRepository, userRepository)

  beforeEach(() => {
    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findOneByUuid = jest
      .fn()
      .mockResolvedValue({ uuid: roleUuid, name: 'SUPPORT_AGENT' } as unknown as Role)

    groupRepository = {} as jest.Mocked<GroupRepositoryInterface>
    groupRepository.findAll = jest.fn().mockResolvedValue([
      { id: { toString: () => 'g1' }, props: { name: 'Support', roleNames: ['SUPPORT_AGENT'] } },
      { id: { toString: () => 'g2' }, props: { name: 'Other', roleNames: ['CORE_USER'] } },
    ])

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({ rows: [], total: 4 })
  })

  it('returns the direct holder count and the conferring groups', async () => {
    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(false)
    const view = result.getValue()
    expect(view.directUserCount).toEqual(4)
    expect(view.groups).toEqual([{ uuid: 'g1', name: 'Support' }])
    expect(userRepository.findUsersForAdmin).toHaveBeenCalledWith(expect.objectContaining({ role: 'SUPPORT_AGENT' }))
  })

  it('fails when the role does not exist', async () => {
    roleRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ roleUuid })

    expect(result.isFailed()).toBe(true)
  })
})
