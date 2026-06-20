import 'reflect-metadata'

import { Request, Response } from 'express'
import { Result, RoleName } from '@standardnotes/domain-core'

import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { User } from '../../../Domain/User/User'
import { BaseAdminController } from './BaseAdminController'

describe('BaseAdminController ban endpoints', () => {
  let doDeleteSetting: DeleteSetting
  let doGetSetting: GetSetting
  let userRepository: UserRepositoryInterface
  let createSubscriptionToken: CreateSubscriptionToken
  let createOfflineSubscriptionToken: CreateOfflineSubscriptionToken
  let setSettingValue: SetSettingValue
  let setUserBanStatus: SetUserBanStatus
  let request: Request
  let adminResponse: Response
  let nonAdminResponse: Response

  const createController = () =>
    new BaseAdminController(
      doDeleteSetting,
      doGetSetting,
      userRepository,
      createSubscriptionToken,
      createOfflineSubscriptionToken,
      setSettingValue,
      setUserBanStatus,
    )

  beforeEach(() => {
    doDeleteSetting = {} as jest.Mocked<DeleteSetting>
    doGetSetting = {} as jest.Mocked<GetSetting>
    createSubscriptionToken = {} as jest.Mocked<CreateSubscriptionToken>
    createOfflineSubscriptionToken = {} as jest.Mocked<CreateOfflineSubscriptionToken>
    setSettingValue = {} as jest.Mocked<SetSettingValue>

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue({
      uuid: '1-2-3',
      email: 'test@test.com',
      banReason: null,
      bannedAt: null,
      isBanned: () => false,
    } as unknown as User)

    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>
    setUserBanStatus.execute = jest.fn().mockResolvedValue(
      Result.ok({
        uuid: '1-2-3',
        bannedAt: null,
        banReason: null,
        isBanned: () => true,
      } as unknown as User),
    )

    request = {
      params: { userUuid: '1-2-3', email: 'test@test.com' },
      body: { banned: true },
    } as unknown as Request

    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.InternalTeamUser }] },
    } as unknown as Response

    nonAdminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.CoreUser }] },
    } as unknown as Response
  })

  it('setUserBanStatusEndpoint should reject a non-admin requestor', async () => {
    const result = await createController().setUserBanStatusEndpoint(request, nonAdminResponse)

    expect(result.statusCode).toEqual(401)
    expect(setUserBanStatus.execute).not.toHaveBeenCalled()
  })

  it('setUserBanStatusEndpoint should require a boolean banned flag', async () => {
    request.body = {}

    const result = await createController().setUserBanStatusEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(setUserBanStatus.execute).not.toHaveBeenCalled()
  })

  it('setUserBanStatusEndpoint should ban a user for an admin requestor', async () => {
    const result = await createController().setUserBanStatusEndpoint(request, adminResponse)

    expect(setUserBanStatus.execute).toHaveBeenCalledWith({ userUuid: '1-2-3', banned: true, banReason: null })
    expect(result.json).toMatchObject({ success: true, banned: true })
  })

  it('setUserBanStatusEndpoint should surface a use case failure as a 400', async () => {
    setUserBanStatus.execute = jest.fn().mockResolvedValue(Result.fail('User 1-2-3 not found.'))

    const result = await createController().setUserBanStatusEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(400)
  })

  it('getUserBanStatus should reject a non-admin requestor', async () => {
    const result = await createController().getUserBanStatus(request, nonAdminResponse)

    expect(result.statusCode).toEqual(401)
  })

  it('getUserBanStatus should return the ban status for an admin requestor', async () => {
    const result = await createController().getUserBanStatus(request, adminResponse)

    expect(result.json).toMatchObject({ uuid: '1-2-3', banned: false })
  })
})
