import 'reflect-metadata'

import { Request, Response } from 'express'
import { Result, RoleName, SettingName } from '@standardnotes/domain-core'

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

describe('BaseAdminController OCR server-allowed flag (admin-manageable)', () => {
  let doDeleteSetting: DeleteSetting
  let doGetSetting: GetSetting
  let userRepository: UserRepositoryInterface
  let createSubscriptionToken: CreateSubscriptionToken
  let createOfflineSubscriptionToken: CreateOfflineSubscriptionToken
  let setSettingValue: SetSettingValue
  let setUserBanStatus: SetUserBanStatus
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

  const flagRequest = (name?: string, value?: string | null) =>
    ({ params: { userUuid: '1-2-3' }, body: { name, value } }) as unknown as Request

  beforeEach(() => {
    doDeleteSetting = {} as jest.Mocked<DeleteSetting>
    createSubscriptionToken = {} as jest.Mocked<CreateSubscriptionToken>
    createOfflineSubscriptionToken = {} as jest.Mocked<CreateOfflineSubscriptionToken>
    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>
    userRepository = {} as jest.Mocked<UserRepositoryInterface>

    doGetSetting = {} as jest.Mocked<GetSetting>
    doGetSetting.execute = jest.fn().mockResolvedValue(Result.ok({ decryptedValue: 'true' }))

    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.ok({}))

    adminResponse = { locals: { roles: [{ name: RoleName.NAMES.InternalTeamUser }] } } as unknown as Response
    nonAdminResponse = { locals: { roles: [{ name: RoleName.NAMES.CoreUser }] } } as unknown as Response
  })

  it('classifies OCR_SERVER_ALLOWED as admin-manageable and persists a valid value', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.OcrServerAllowed, 'true'),
      adminResponse,
    )

    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: SettingName.NAMES.OcrServerAllowed,
      value: 'true',
      userUuid: '1-2-3',
      checkUserPermissions: false,
    })
    expect(result.json).toMatchObject({ success: true, name: SettingName.NAMES.OcrServerAllowed, value: 'true' })
  })

  it('rejects a non-boolean OCR_SERVER_ALLOWED value', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.OcrServerAllowed, 'maybe'),
      adminResponse,
    )

    expect(result.statusCode).toEqual(400)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('rejects a setting that is NOT admin-manageable', async () => {
    const result = await createController().setUserFeatureFlag(flagRequest(SettingName.NAMES.MfaSecret, 'x'), adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('rejects a non-admin requestor for the OCR flag', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.OcrServerAllowed, 'true'),
      nonAdminResponse,
    )

    expect(result.statusCode).toEqual(401)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('includes OCR_SERVER_ALLOWED in the admin-readable feature flags', async () => {
    const result = await createController().getUserFeatureFlags(flagRequest(), adminResponse)

    expect((result.json as { flags: Record<string, string | null> }).flags).toHaveProperty(
      SettingName.NAMES.OcrServerAllowed,
    )
  })
})

describe('BaseAdminController Nextcloud backup-allowed flag (admin-manageable)', () => {
  let doDeleteSetting: DeleteSetting
  let doGetSetting: GetSetting
  let userRepository: UserRepositoryInterface
  let createSubscriptionToken: CreateSubscriptionToken
  let createOfflineSubscriptionToken: CreateOfflineSubscriptionToken
  let setSettingValue: SetSettingValue
  let setUserBanStatus: SetUserBanStatus
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

  const flagRequest = (name?: string, value?: string | null) =>
    ({ params: { userUuid: '1-2-3' }, body: { name, value } }) as unknown as Request

  beforeEach(() => {
    doDeleteSetting = {} as jest.Mocked<DeleteSetting>
    createSubscriptionToken = {} as jest.Mocked<CreateSubscriptionToken>
    createOfflineSubscriptionToken = {} as jest.Mocked<CreateOfflineSubscriptionToken>
    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>
    userRepository = {} as jest.Mocked<UserRepositoryInterface>

    doGetSetting = {} as jest.Mocked<GetSetting>
    doGetSetting.execute = jest.fn().mockResolvedValue(Result.ok({ decryptedValue: 'true' }))

    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setSettingValue.execute = jest.fn().mockResolvedValue(Result.ok({}))

    adminResponse = { locals: { roles: [{ name: RoleName.NAMES.InternalTeamUser }] } } as unknown as Response
    nonAdminResponse = { locals: { roles: [{ name: RoleName.NAMES.CoreUser }] } } as unknown as Response
  })

  it('classifies NEXTCLOUD_BACKUP_ALLOWED as admin-manageable and persists a valid value', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.NextcloudBackupAllowed, 'true'),
      adminResponse,
    )

    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: SettingName.NAMES.NextcloudBackupAllowed,
      value: 'true',
      userUuid: '1-2-3',
      checkUserPermissions: false,
    })
    expect(result.json).toMatchObject({
      success: true,
      name: SettingName.NAMES.NextcloudBackupAllowed,
      value: 'true',
    })
  })

  it('rejects a non-boolean NEXTCLOUD_BACKUP_ALLOWED value', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.NextcloudBackupAllowed, 'maybe'),
      adminResponse,
    )

    expect(result.statusCode).toEqual(400)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('rejects a non-admin requestor for the Nextcloud flag', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.NextcloudBackupAllowed, 'true'),
      nonAdminResponse,
    )

    expect(result.statusCode).toEqual(401)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('includes NEXTCLOUD_BACKUP_ALLOWED and the read-only frequency in the admin-readable feature flags', async () => {
    const result = await createController().getUserFeatureFlags(flagRequest(), adminResponse)

    const flags = (result.json as { flags: Record<string, string | null> }).flags
    expect(flags).toHaveProperty(SettingName.NAMES.NextcloudBackupAllowed)
    expect(flags).toHaveProperty(SettingName.NAMES.NextcloudBackupFrequency)
  })

  it('exposes a read-only "app password configured?" status WITHOUT decrypting the password', async () => {
    // Probe must be made allowing sensitive retrieval but with decrypted:false, so
    // the value is never returned; only existence (configured) is surfaced.
    const result = await createController().getUserFeatureFlags(flagRequest(), adminResponse)

    expect(doGetSetting.execute).toHaveBeenCalledWith({
      userUuid: '1-2-3',
      settingName: SettingName.NAMES.NextcloudBackupAppPassword,
      allowSensitiveRetrieval: true,
      decrypted: false,
    })
    expect((result.json as { nextcloudAppPasswordConfigured: boolean }).nextcloudAppPasswordConfigured).toBe(true)
  })

  it('reports the app password as NOT configured when the setting is absent, withholding the value either way', async () => {
    doGetSetting.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    const result = await createController().getUserFeatureFlags(flagRequest(), adminResponse)

    const json = result.json as {
      flags: Record<string, string | null>
      nextcloudAppPasswordConfigured: boolean
    }
    expect(json.nextcloudAppPasswordConfigured).toBe(false)
    // The app password is never surfaced as a flag value.
    expect(json.flags).not.toHaveProperty(SettingName.NAMES.NextcloudBackupAppPassword)
  })
})
