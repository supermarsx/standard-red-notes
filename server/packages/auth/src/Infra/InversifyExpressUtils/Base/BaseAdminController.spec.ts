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
import { RoleServiceInterface } from '../../../Domain/Role/RoleServiceInterface'
import { FixStorageQuotaForUser } from '../../../Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
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
      bannedUntil: null,
      isBanned: () => false,
      isShadowBanned: () => false,
      effectiveBanType: () => null,
    } as unknown as User)

    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>
    setUserBanStatus.execute = jest.fn().mockResolvedValue(
      Result.ok({
        uuid: '1-2-3',
        bannedAt: null,
        banReason: null,
        bannedUntil: null,
        isBanned: () => true,
        isShadowBanned: () => false,
        effectiveBanType: () => 'permanent',
      } as unknown as User),
    )

    request = {
      params: { userUuid: '1-2-3', email: 'test@test.com' },
      body: { banned: true },
    } as unknown as Request

    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.AdminUser }] },
    } as unknown as Response

    nonAdminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.CoreUser }] },
    } as unknown as Response
  })

  it('setUserBanStatusEndpoint should reject a non-admin requestor with 403 — NOT 401, which clients treat as an invalid session and answer with a password re-auth prompt', async () => {
    const result = await createController().setUserBanStatusEndpoint(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(result.statusCode).not.toEqual(401)
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

    expect(setUserBanStatus.execute).toHaveBeenCalledWith({
      userUuid: '1-2-3',
      banned: true,
      banReason: null,
      banType: 'permanent',
      bannedUntil: null,
    })
    expect(result.json).toMatchObject({ success: true, banned: true })
  })

  it('setUserBanStatusEndpoint should surface a use case failure as a 400', async () => {
    setUserBanStatus.execute = jest.fn().mockResolvedValue(Result.fail('User 1-2-3 not found.'))

    const result = await createController().setUserBanStatusEndpoint(request, adminResponse)

    expect(result.statusCode).toEqual(400)
  })

  it('getUserBanStatus should reject a non-admin requestor', async () => {
    const result = await createController().getUserBanStatus(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
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

    adminResponse = { locals: { roles: [{ name: RoleName.NAMES.AdminUser }] } } as unknown as Response
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

    expect(result.statusCode).toEqual(403)
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

    adminResponse = { locals: { roles: [{ name: RoleName.NAMES.AdminUser }] } } as unknown as Response
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

    expect(result.statusCode).toEqual(403)
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

describe('BaseAdminController workflows-enabled flag (admin-manageable)', () => {
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

    adminResponse = { locals: { roles: [{ name: RoleName.NAMES.AdminUser }] } } as unknown as Response
    nonAdminResponse = { locals: { roles: [{ name: RoleName.NAMES.CoreUser }] } } as unknown as Response
  })

  it('classifies WORKFLOWS_ENABLED as admin-manageable and persists a valid value', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.WorkflowsEnabled, 'true'),
      adminResponse,
    )

    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: SettingName.NAMES.WorkflowsEnabled,
      value: 'true',
      userUuid: '1-2-3',
      checkUserPermissions: false,
    })
    expect(result.json).toMatchObject({ success: true, name: SettingName.NAMES.WorkflowsEnabled, value: 'true' })
  })

  it('rejects a non-boolean WORKFLOWS_ENABLED value', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.WorkflowsEnabled, 'maybe'),
      adminResponse,
    )

    expect(result.statusCode).toEqual(400)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('rejects a non-admin requestor for the workflows flag', async () => {
    const result = await createController().setUserFeatureFlag(
      flagRequest(SettingName.NAMES.WorkflowsEnabled, 'true'),
      nonAdminResponse,
    )

    expect(result.statusCode).toEqual(403)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('includes WORKFLOWS_ENABLED in the admin-readable feature flags', async () => {
    const result = await createController().getUserFeatureFlags(flagRequest(), adminResponse)

    expect((result.json as { flags: Record<string, string | null> }).flags).toHaveProperty(
      SettingName.NAMES.WorkflowsEnabled,
    )
  })
})

describe('BaseAdminController admin-role / reset-MFA / fix-quota endpoints', () => {
  const targetUuid = '84c0f8e8-544a-4c7e-9adf-26209303bc1d'
  const actorUuid = '00000000-0000-4000-8000-000000000001'

  let doDeleteSetting: DeleteSetting
  let doGetSetting: GetSetting
  let userRepository: UserRepositoryInterface
  let createSubscriptionToken: CreateSubscriptionToken
  let createOfflineSubscriptionToken: CreateOfflineSubscriptionToken
  let setSettingValue: SetSettingValue
  let setUserBanStatus: SetUserBanStatus
  let auditLogWriter: AuditLogWriterInterface
  let roleService: RoleServiceInterface
  let doFixStorageQuota: FixStorageQuotaForUser
  let request: Request
  let adminResponse: Response
  let nonAdminResponse: Response

  const createController = (options: { withRoleService?: boolean; withFixQuota?: boolean } = {}) =>
    new BaseAdminController(
      doDeleteSetting,
      doGetSetting,
      userRepository,
      createSubscriptionToken,
      createOfflineSubscriptionToken,
      setSettingValue,
      setUserBanStatus,
      undefined,
      undefined,
      auditLogWriter,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options.withRoleService === false ? undefined : roleService,
      options.withFixQuota === false ? undefined : doFixStorageQuota,
    )

  beforeEach(() => {
    doGetSetting = {} as jest.Mocked<GetSetting>
    createSubscriptionToken = {} as jest.Mocked<CreateSubscriptionToken>
    createOfflineSubscriptionToken = {} as jest.Mocked<CreateOfflineSubscriptionToken>
    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>

    doDeleteSetting = {} as jest.Mocked<DeleteSetting>
    doDeleteSetting.execute = jest.fn().mockResolvedValue({ success: true })

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({
      uuid: targetUuid,
      email: 'target@test.com',
    } as unknown as User)

    auditLogWriter = {} as jest.Mocked<AuditLogWriterInterface>
    auditLogWriter.write = jest.fn().mockResolvedValue(undefined)

    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.addRoleToUser = jest.fn().mockResolvedValue(undefined)
    roleService.removeRoleFromUser = jest.fn().mockResolvedValue(undefined)

    doFixStorageQuota = {} as jest.Mocked<FixStorageQuotaForUser>
    doFixStorageQuota.execute = jest.fn().mockResolvedValue(Result.ok(undefined))

    request = {
      params: { userUuid: targetUuid },
      body: { granted: true },
      headers: {},
    } as unknown as Request

    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.AdminUser }], user: { uuid: actorUuid } },
    } as unknown as Response

    nonAdminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.CoreUser }], user: { uuid: actorUuid } },
    } as unknown as Response
  })

  it('setUserAdminRole should reject a non-admin requestor with 403', async () => {
    const result = await createController().setUserAdminRole(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(roleService.addRoleToUser).not.toHaveBeenCalled()
  })

  it('setUserAdminRole should require a boolean granted flag', async () => {
    request.body = {}

    const result = await createController().setUserAdminRole(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(roleService.addRoleToUser).not.toHaveBeenCalled()
  })

  it('setUserAdminRole should reject an invalid user uuid', async () => {
    request.params = { userUuid: 'not-a-uuid' } as unknown as Request['params']

    const result = await createController().setUserAdminRole(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(roleService.addRoleToUser).not.toHaveBeenCalled()
  })

  it('setUserAdminRole should reject an unknown user', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createController().setUserAdminRole(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(roleService.addRoleToUser).not.toHaveBeenCalled()
  })

  it('setUserAdminRole should refuse self-revocation', async () => {
    request.params = { userUuid: actorUuid } as unknown as Request['params']
    request.body = { granted: false }
    userRepository.findOneByUuid = jest
      .fn()
      .mockResolvedValue({ uuid: actorUuid, email: 'admin@test.com' } as unknown as User)

    const result = await createController().setUserAdminRole(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(roleService.removeRoleFromUser).not.toHaveBeenCalled()
  })

  it('setUserAdminRole should grant the admin role and write an audit entry', async () => {
    const result = await createController().setUserAdminRole(request, adminResponse)

    expect(roleService.addRoleToUser).toHaveBeenCalled()
    const [calledUuid, calledRole] = (roleService.addRoleToUser as jest.Mock).mock.calls[0]
    expect(calledUuid.value).toEqual(targetUuid)
    expect(calledRole.value).toEqual(RoleName.NAMES.AdminUser)
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid,
        action: AuditAction.RoleChanged,
        targetUuid,
        metadata: { role: RoleName.NAMES.AdminUser, granted: true },
      }),
    )
    expect(result.json).toMatchObject({ success: true, userUuid: targetUuid, granted: true })
  })

  it('setUserAdminRole should revoke the admin role from another user', async () => {
    request.body = { granted: false }

    const result = await createController().setUserAdminRole(request, adminResponse)

    expect(roleService.removeRoleFromUser).toHaveBeenCalled()
    expect(roleService.addRoleToUser).not.toHaveBeenCalled()
    expect(result.json).toMatchObject({ success: true, userUuid: targetUuid, granted: false })
  })

  it('setUserAdminRole should answer 500 when role management is not wired', async () => {
    const result = await createController({ withRoleService: false }).setUserAdminRole(request, adminResponse)

    expect(result.statusCode).toEqual(500)
  })

  it('resetUserMFA should reject a non-admin requestor with 403', async () => {
    const result = await createController().resetUserMFA(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doDeleteSetting.execute).not.toHaveBeenCalled()
  })

  it('resetUserMFA should soft-delete the MFA secret and write an audit entry', async () => {
    const result = await createController().resetUserMFA(request, adminResponse)

    expect(doDeleteSetting.execute).toHaveBeenCalledWith({
      userUuid: targetUuid,
      settingName: SettingName.NAMES.MfaSecret,
      softDelete: true,
    })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid,
        action: AuditAction.MfaReset,
        targetUuid,
        metadata: { name: SettingName.NAMES.MfaSecret },
      }),
    )
    expect(result.json).toMatchObject({ success: true, userUuid: targetUuid })
  })

  it('resetUserMFA should answer 400 when the user has no 2FA configured', async () => {
    doDeleteSetting.execute = jest.fn().mockResolvedValue({ success: false })

    const result = await createController().resetUserMFA(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('fixUserQuota should reject a non-admin requestor with 403', async () => {
    const result = await createController().fixUserQuota(request, nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(doFixStorageQuota.execute).not.toHaveBeenCalled()
  })

  it('fixUserQuota should answer 500 when quota recalculation is not wired', async () => {
    const result = await createController({ withFixQuota: false }).fixUserQuota(request, adminResponse)

    expect(result.statusCode).toEqual(500)
  })

  it('fixUserQuota should reject an unknown user', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createController().fixUserQuota(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(doFixStorageQuota.execute).not.toHaveBeenCalled()
  })

  it('fixUserQuota should recalculate by the resolved email and write an audit entry', async () => {
    const result = await createController().fixUserQuota(request, adminResponse)

    expect(doFixStorageQuota.execute).toHaveBeenCalledWith({ userEmail: 'target@test.com' })
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid,
        action: AuditAction.QuotaRecalculated,
        targetUuid,
      }),
    )
    expect(result.json).toMatchObject({ success: true, userUuid: targetUuid })
  })

  it('fixUserQuota should surface a use case failure as a 400', async () => {
    doFixStorageQuota.execute = jest.fn().mockResolvedValue(Result.fail('boom'))

    const result = await createController().fixUserQuota(request, adminResponse)

    expect(result.statusCode).toEqual(400)
    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })
})

describe('BaseAdminController registration flag env read-out', () => {
  let doDeleteSetting: DeleteSetting
  let doGetSetting: GetSetting
  let userRepository: UserRepositoryInterface
  let createSubscriptionToken: CreateSubscriptionToken
  let createOfflineSubscriptionToken: CreateOfflineSubscriptionToken
  let setSettingValue: SetSettingValue
  let setUserBanStatus: SetUserBanStatus
  let request: Request
  let adminResponse: Response

  const createController = (envFlags?: { registrationDisabledByEnv: boolean; nextcloudBackupsEnabledByEnv: boolean }) =>
    new BaseAdminController(
      doDeleteSetting,
      doGetSetting,
      userRepository,
      createSubscriptionToken,
      createOfflineSubscriptionToken,
      setSettingValue,
      setUserBanStatus,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      envFlags?.registrationDisabledByEnv,
      envFlags?.nextcloudBackupsEnabledByEnv,
    )

  beforeEach(() => {
    doDeleteSetting = {} as jest.Mocked<DeleteSetting>
    createSubscriptionToken = {} as jest.Mocked<CreateSubscriptionToken>
    createOfflineSubscriptionToken = {} as jest.Mocked<CreateOfflineSubscriptionToken>
    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>
    userRepository = {} as jest.Mocked<UserRepositoryInterface>

    doGetSetting = {} as jest.Mocked<GetSetting>
    doGetSetting.execute = jest.fn().mockResolvedValue(Result.ok({ decryptedValue: 'true' }))

    request = { params: {}, body: {}, headers: {} } as unknown as Request
    adminResponse = {
      locals: {
        roles: [{ name: RoleName.NAMES.AdminUser }],
        user: { uuid: '00000000-0000-4000-8000-000000000001' },
      },
    } as unknown as Response
  })

  it('surfaces the wired env master switches alongside the persisted flag', async () => {
    const result = await createController({
      registrationDisabledByEnv: true,
      nextcloudBackupsEnabledByEnv: false,
    }).getRegistrationFlag(request, adminResponse)

    expect(result.json).toMatchObject({
      registrationDisabled: true,
      env: { registrationDisabled: true, nextcloudBackupsEnabled: false },
    })
  })

  it('reports null (unknown) env switches when they are not wired', async () => {
    const result = await createController().getRegistrationFlag(request, adminResponse)

    expect(result.json).toMatchObject({
      env: { registrationDisabled: null, nextcloudBackupsEnabled: null },
    })
  })
})

describe('BaseAdminController user list', () => {
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

  const requestWith = (query: Record<string, string>) => ({ query, params: {}, body: {} }) as unknown as Request

  beforeEach(() => {
    doDeleteSetting = {} as jest.Mocked<DeleteSetting>
    doGetSetting = {} as jest.Mocked<GetSetting>
    createSubscriptionToken = {} as jest.Mocked<CreateSubscriptionToken>
    createOfflineSubscriptionToken = {} as jest.Mocked<CreateOfflineSubscriptionToken>
    setSettingValue = {} as jest.Mocked<SetSettingValue>
    setUserBanStatus = {} as jest.Mocked<SetUserBanStatus>

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findUsersForAdmin = jest.fn().mockResolvedValue({
      rows: [
        {
          uuid: '1-2-3',
          email: 'a@test.com',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          roles: ['CORE_USER'],
          subscription: { plan: 'PRO_PLAN', active: true },
          banned: false,
          mfaEnabled: true,
          storageUsedBytes: 10,
          storageLimitBytes: -1,
        },
      ],
      total: 1,
    })

    adminResponse = { locals: { roles: [{ name: RoleName.NAMES.AdminUser }] } } as unknown as Response
    nonAdminResponse = { locals: { roles: [{ name: RoleName.NAMES.CoreUser }] } } as unknown as Response
  })

  it('rejects a non-admin requestor with 403 and never queries the repository', async () => {
    const result = await createController().getUsers(requestWith({}), nonAdminResponse)

    expect(result.statusCode).toEqual(403)
    expect(userRepository.findUsersForAdmin).not.toHaveBeenCalled()
  })

  it('applies defaults (limit 100, offset 0, createdAt sort) when no query params are given', async () => {
    await createController().getUsers(requestWith({}), adminResponse)

    expect(userRepository.findUsersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, offset: 0, sort: 'createdAt' }),
    )
  })

  it('clamps the limit to the 1500 max and parses the filters', async () => {
    await createController().getUsers(
      requestWith({
        limit: '99999',
        offset: '20',
        sort: 'email',
        email: '  Foo  ',
        createdAfter: '1000',
        createdBefore: '2000',
        role: 'ADMIN_USER',
        banned: 'true',
        subscription: 'active',
      }),
      adminResponse,
    )

    expect(userRepository.findUsersForAdmin).toHaveBeenCalledWith({
      limit: 1500,
      offset: 20,
      sort: 'email',
      email: 'Foo',
      createdAfter: 1000,
      createdBefore: 2000,
      role: 'ADMIN_USER',
      banned: true,
      subscription: 'active',
    })
  })

  it('ignores an unknown sort/subscription value and an empty email, falling back to defaults', async () => {
    await createController().getUsers(
      requestWith({ sort: 'bogus', subscription: 'weird', email: '   ', banned: 'nope' }),
      adminResponse,
    )

    expect(userRepository.findUsersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'createdAt', subscription: undefined, email: undefined, banned: undefined }),
    )
  })

  it('shapes the response as { users, total, limit, offset }', async () => {
    const result = await createController().getUsers(requestWith({ limit: '50', offset: '5' }), adminResponse)

    expect(result.json).toMatchObject({
      total: 1,
      limit: 50,
      offset: 5,
      users: [
        expect.objectContaining({
          uuid: '1-2-3',
          email: 'a@test.com',
          roles: ['CORE_USER'],
          subscription: { plan: 'PRO_PLAN', active: true },
          mfaEnabled: true,
          storageLimitBytes: -1,
        }),
      ],
    })
  })
})
