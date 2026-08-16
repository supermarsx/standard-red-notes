import 'reflect-metadata'

import { TokenEncoderInterface, CrossServiceTokenData } from '@standardnotes/security'
import { ProjectorInterface } from '../../../Projection/ProjectorInterface'
import { Session } from '../../Session/Session'
import { User } from '../../User/User'
import { Role } from '../../Role/Role'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateCrossServiceToken } from './CreateCrossServiceToken'
import {
  Result,
  RoleName,
  SettingName,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  Uuid,
} from '@standardnotes/domain-core'
import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { GetSubscriptionSetting } from '../GetSubscriptionSetting/GetSubscriptionSetting'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { UserSubscription } from '../../Subscription/UserSubscription'
import { SubscriptionSetting } from '../../Setting/SubscriptionSetting'
import { EncryptionVersion } from '../../Encryption/EncryptionVersion'
import { GetActiveSessionsForUser } from '../GetActiveSessionsForUser'
import { Permission } from '../../Permission/Permission'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'

describe('CreateCrossServiceToken', () => {
  let userProjector: ProjectorInterface<User>
  let sessionProjector: ProjectorInterface<Session>
  let roleProjector: ProjectorInterface<Role>
  let tokenEncoder: TokenEncoderInterface<CrossServiceTokenData>
  let userRepository: UserRepositoryInterface
  let getRegularSubscription: GetRegularSubscriptionForUser
  let getSubscriptionSetting: GetSubscriptionSetting
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface
  let getActiveSessionsForUser: GetActiveSessionsForUser
  let settingRepository: SettingRepositoryInterface
  let getSetting: GetSetting
  const jwtTTL = 60

  let session: Session
  let user: User
  let role: Role
  let permission: Permission

  const createUseCase = (
    applicationVersionThresholdForTokenVersion2?: string,
    applicationVersionThresholdForTokenVersion3?: string,
  ) =>
    new CreateCrossServiceToken(
      userProjector,
      sessionProjector,
      roleProjector,
      tokenEncoder,
      userRepository,
      jwtTTL,
      getRegularSubscription,
      getSubscriptionSetting,
      sharedVaultUserRepository,
      getActiveSessionsForUser,
      applicationVersionThresholdForTokenVersion2,
      applicationVersionThresholdForTokenVersion3,
      getSetting,
    )

  beforeEach(() => {
    permission = {
      name: 'server:content-limit',
    } as jest.Mocked<Permission>

    session = {} as jest.Mocked<Session>

    getActiveSessionsForUser = {} as jest.Mocked<GetActiveSessionsForUser>

    settingRepository = {} as jest.Mocked<SettingRepositoryInterface>
    settingRepository.findLastByNameAndUserUuid = jest.fn().mockResolvedValue(null)
    getSetting = {} as jest.Mocked<GetSetting>
    getSetting.execute = jest.fn().mockImplementation(async ({ settingName, userUuid }) => {
      const found = await settingRepository.findLastByNameAndUserUuid(settingName, userUuid)
      if (found === null) {
        return Result.fail('not found')
      }
      return Result.ok({ setting: found, decryptedValue: found.props.value })
    })
    getActiveSessionsForUser.execute = jest.fn().mockReturnValue({ sessions: [session] })

    role = {
      name: 'test',
    } as jest.Mocked<Role>
    role.permissions = Promise.resolve([])

    user = {
      uuid: '00000000-0000-0000-0000-000000000000',
      email: 'test@test.te',
      isShadowBanned: () => false,
    } as unknown as jest.Mocked<User>
    user.roles = Promise.resolve([role])

    userProjector = {} as jest.Mocked<ProjectorInterface<User>>
    userProjector.projectSimple = jest
      .fn()
      .mockReturnValue({ uuid: '00000000-0000-0000-0000-000000000000', email: 'test@test.te' })

    roleProjector = {} as jest.Mocked<ProjectorInterface<Role>>
    roleProjector.projectSimple = jest.fn().mockReturnValue({ name: 'role1', uuid: '1-3-4' })

    sessionProjector = {} as jest.Mocked<ProjectorInterface<Session>>
    sessionProjector.projectCustom = jest.fn().mockReturnValue({ foo: 'bar' })
    sessionProjector.projectSimple = jest.fn().mockReturnValue({ test: 'test' })

    tokenEncoder = {} as jest.Mocked<TokenEncoderInterface<CrossServiceTokenData>>
    tokenEncoder.encodeExpirableToken = jest.fn().mockReturnValue('foobar')

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockReturnValue(user)

    getSubscriptionSetting = {} as jest.Mocked<GetSubscriptionSetting>
    getSubscriptionSetting.execute = jest.fn().mockReturnValue(
      Result.ok({
        setting: SubscriptionSetting.create({
          sensitive: false,
          name: SettingName.NAMES.FileUploadBytesLimit,
          value: '100',
          timestamps: Timestamps.create(123456789, 123456789).getValue(),
          serverEncryptionVersion: EncryptionVersion.Unencrypted,
          userSubscriptionUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
        }).getValue(),
      }),
    )

    getRegularSubscription = {} as jest.Mocked<GetRegularSubscriptionForUser>
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('not found'))

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuid = jest.fn().mockReturnValue([
      SharedVaultUser.create({
        permission: SharedVaultUserPermission.create('read').getValue(),
        sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
        timestamps: Timestamps.create(123456789, 123456789).getValue(),
        userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
        isDesignatedSurvivor: false,
      }).getValue(),
    ])
  })

  it('should create a cross service token for user', async () => {
    await createUseCase().execute({
      user,
      session,
    })

    expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
      {
        roles: [
          {
            name: 'role1',
            uuid: '1-3-4',
          },
          {
            name: 'PRO_USER',
            uuid: 'singletier-PRO_USER',
          },
        ],
        shared_vault_owner_context: undefined,
        belongs_to_shared_vaults: [
          {
            shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
            permission: 'read',
          },
        ],
        session: {
          test: 'test',
        },
        user: {
          email: 'test@test.te',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
        hasContentLimit: false,
        collaboration_enabled: true,
        live_sync_enabled: true,
        ai_enabled: true,
        ai_request_limit: undefined,
        version: 1,
      },
      60,
    )
  })

  it('projects configured feature gates, independent request/token limits, and MCP tag scope into the token', async () => {
    const settingValues: Record<string, string> = {
      [SettingName.NAMES.CollaborationEnabled]: 'false',
      [SettingName.NAMES.LiveSyncEnabled]: 'false',
      [SettingName.NAMES.AiEnabled]: 'false',
      [SettingName.NAMES.AiRequestLimit]: '25',
      [SettingName.NAMES.AiFiveHourTokenLimit]: '2500',
      [SettingName.NAMES.AiWeeklyTokenLimit]: '12500',
      [SettingName.NAMES.WorkflowsEnabled]: 'true',
    }
    settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
      const value = settingValues[settingName]
      return Promise.resolve(value === undefined ? null : { props: { value } })
    })
    session.readonlyAccess = true
    session.mcpScopeTagUuids = JSON.stringify(['tag-b', 'tag-a'])

    await createUseCase().execute({ user, session })

    const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
    expect(payload).toEqual(
      expect.objectContaining({
        collaboration_enabled: false,
        live_sync_enabled: false,
        ai_enabled: false,
        ai_request_limit: 25,
        ai_five_hour_token_limit: 2500,
        ai_weekly_token_limit: 12500,
        workflows_enabled: true,
        mcp_scope: { access: 'read', tagUuids: ['tag-b', 'tag-a'] },
      }),
    )
  })

  it('projects the canonical decrypted value from a legacy encrypted AI row', async () => {
    getSetting.execute = jest.fn().mockImplementation(({ settingName }) => {
      if (settingName === SettingName.NAMES.AiEnabled) {
        return Promise.resolve(Result.ok({ setting: {} as never, decryptedValue: 'false' }))
      }
      return Promise.resolve(Result.fail('not found'))
    })

    await createUseCase().execute({ user, session })

    const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
    expect(payload.ai_enabled).toBe(false)
    expect(getSetting.execute).toHaveBeenCalledWith({
      userUuid: user.uuid,
      settingName: SettingName.NAMES.AiEnabled,
      allowSensitiveRetrieval: true,
      decrypted: true,
    })
  })

  it('fails the AI gate closed when a stored value cannot be decrypted', async () => {
    getSetting.execute = jest.fn().mockImplementation(({ settingName }) => {
      if (settingName === SettingName.NAMES.AiEnabled) {
        return Promise.reject(new Error('corrupt ciphertext'))
      }
      return Promise.resolve(Result.fail('not found'))
    })

    await createUseCase().execute({ user, session })

    const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
    expect(payload.ai_enabled).toBe(false)
  })

  it.each(['not-a-number', '25junk', '0', '9007199254740992'])(
    'omits invalid AI request limit %s and malformed MCP tag scope',
    async (value) => {
      settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
        if (settingName === SettingName.NAMES.AiRequestLimit) {
          return Promise.resolve({ props: { value } })
        }
        return Promise.resolve(null)
      })
      session.readonlyAccess = false
      session.mcpScopeTagUuids = '{invalid-json'

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.ai_request_limit).toBeUndefined()
      expect(payload.mcp_scope).toBeUndefined()
    },
  )

  it('omits invalid or zero per-user token limit overrides so the gateway inherits its global windows', async () => {
    const settingValues: Record<string, string> = {
      [SettingName.NAMES.AiFiveHourTokenLimit]: '0',
      [SettingName.NAMES.AiWeeklyTokenLimit]: 'not-a-number',
    }
    settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
      const value = settingValues[settingName]
      return Promise.resolve(value === undefined ? null : { props: { value } })
    })

    await createUseCase().execute({ user, session })

    const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
    expect(payload.ai_five_hour_token_limit).toBeUndefined()
    expect(payload.ai_weekly_token_limit).toBeUndefined()
  })

  it('does not derive the admin role from a normalized ADMIN_EMAILS match', async () => {
    const previousAdminEmails = process.env.ADMIN_EMAILS
    process.env.ADMIN_EMAILS = 'other@example.com, TEST@TEST.TE '

    try {
      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.roles.some((projectedRole) => projectedRole.name === RoleName.NAMES.AdminUser)).toBe(false)
    } finally {
      if (previousAdminEmails === undefined) {
        delete process.env.ADMIN_EMAILS
      } else {
        process.env.ADMIN_EMAILS = previousAdminEmails
      }
    }
  })

  it('includes a persisted admin role in the issued token regardless of ADMIN_EMAILS', async () => {
    const previousAdminEmails = process.env.ADMIN_EMAILS
    process.env.ADMIN_EMAILS = 'other@example.com'
    const adminRole = { name: RoleName.NAMES.AdminUser } as Role
    user.roles = Promise.resolve([adminRole])
    roleProjector.projectSimple = jest.fn().mockReturnValue({
      uuid: 'persisted-admin-role-uuid',
      name: RoleName.NAMES.AdminUser,
    })

    try {
      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.roles.filter((projectedRole) => projectedRole.name === RoleName.NAMES.AdminUser)).toEqual([
        { uuid: 'persisted-admin-role-uuid', name: RoleName.NAMES.AdminUser },
      ])
    } finally {
      if (previousAdminEmails === undefined) {
        delete process.env.ADMIN_EMAILS
      } else {
        process.env.ADMIN_EMAILS = previousAdminEmails
      }
    }
  })

  it('should create a cross service token for user with content limitation', async () => {
    role.name = RoleName.NAMES.CoreUser
    role.permissions = Promise.resolve([permission])

    user.roles = Promise.resolve([role])

    userRepository.findOneByUuid = jest.fn().mockReturnValue(user)

    await createUseCase().execute({
      user,
      session,
    })

    expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
      {
        roles: [
          {
            name: 'role1',
            uuid: '1-3-4',
          },
          {
            name: 'PRO_USER',
            uuid: 'singletier-PRO_USER',
          },
        ],
        shared_vault_owner_context: undefined,
        belongs_to_shared_vaults: [
          {
            shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
            permission: 'read',
          },
        ],
        session: {
          test: 'test',
        },
        user: {
          email: 'test@test.te',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
        hasContentLimit: false,
        collaboration_enabled: true,
        live_sync_enabled: true,
        ai_enabled: true,
        ai_request_limit: undefined,
        version: 1,
      },
      60,
    )
  })

  it('should create a cross service token for user without a session', async () => {
    await createUseCase().execute({
      user,
    })

    expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
      {
        roles: [
          {
            name: 'role1',
            uuid: '1-3-4',
          },
          {
            name: 'PRO_USER',
            uuid: 'singletier-PRO_USER',
          },
        ],
        shared_vault_owner_context: undefined,
        belongs_to_shared_vaults: [
          {
            shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
            permission: 'read',
          },
        ],
        user: {
          email: 'test@test.te',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
        hasContentLimit: false,
        collaboration_enabled: true,
        live_sync_enabled: true,
        ai_enabled: true,
        ai_request_limit: undefined,
        version: 1,
      },
      60,
    )
  })

  it('should create a cross service token for user by user uuid', async () => {
    await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
      {
        roles: [
          {
            name: 'role1',
            uuid: '1-3-4',
          },
          {
            name: 'PRO_USER',
            uuid: 'singletier-PRO_USER',
          },
        ],
        shared_vault_owner_context: undefined,
        belongs_to_shared_vaults: [
          {
            shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
            permission: 'read',
          },
        ],
        user: {
          email: 'test@test.te',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
        hasContentLimit: false,
        collaboration_enabled: true,
        live_sync_enabled: true,
        ai_enabled: true,
        ai_request_limit: undefined,
        version: 1,
      },
      60,
    )
  })

  it('should create a cross service token for a user and a specific session', async () => {
    await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sessionUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
      {
        roles: [
          {
            name: 'role1',
            uuid: '1-3-4',
          },
          {
            name: 'PRO_USER',
            uuid: 'singletier-PRO_USER',
          },
        ],
        shared_vault_owner_context: undefined,
        belongs_to_shared_vaults: [
          {
            shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
            permission: 'read',
          },
        ],
        session: {
          test: 'test',
        },
        user: {
          email: 'test@test.te',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
        hasContentLimit: false,
        collaboration_enabled: true,
        live_sync_enabled: true,
        ai_enabled: true,
        ai_request_limit: undefined,
        version: 1,
      },
      60,
    )
  })

  it('should create a cross service token for a user and specific session if the session is missing', async () => {
    getActiveSessionsForUser.execute = jest.fn().mockReturnValue({ sessions: [] })

    await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      sessionUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
      {
        roles: [
          {
            name: 'role1',
            uuid: '1-3-4',
          },
          {
            name: 'PRO_USER',
            uuid: 'singletier-PRO_USER',
          },
        ],
        shared_vault_owner_context: undefined,
        belongs_to_shared_vaults: [
          {
            shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
            permission: 'read',
          },
        ],
        user: {
          email: 'test@test.te',
          uuid: '00000000-0000-0000-0000-000000000000',
        },
        hasContentLimit: false,
        collaboration_enabled: true,
        live_sync_enabled: true,
        ai_enabled: true,
        ai_request_limit: undefined,
        version: 1,
      },
      60,
    )
  })

  describe('RBAC group-conferred roles', () => {
    it('should union roles conferred by the user groups into the token roles', async () => {
      const groupRepository = {
        findByUserUuid: jest.fn().mockResolvedValue([
          { props: { roleNames: ['ADMIN_USER'] } },
          // A duplicate of a direct role must not be added twice.
          { props: { roleNames: ['role1'] } },
        ]),
      }

      const useCase = new CreateCrossServiceToken(
        userProjector,
        sessionProjector,
        roleProjector,
        tokenEncoder,
        userRepository,
        jwtTTL,
        getRegularSubscription,
        getSubscriptionSetting,
        sharedVaultUserRepository,
        getActiveSessionsForUser,
        undefined,
        undefined,
        getSetting,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        groupRepository as any,
      )

      await useCase.execute({
        user,
        session,
      })

      const encoded = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(encoded.roles).toEqual([
        { name: 'role1', uuid: '1-3-4' },
        { name: 'PRO_USER', uuid: 'singletier-PRO_USER' },
        { name: 'ADMIN_USER', uuid: 'group-ADMIN_USER' },
      ])
    })

    it('should mint a token with direct roles only if the group lookup fails', async () => {
      const groupRepository = {
        findByUserUuid: jest.fn().mockRejectedValue(new Error('boom')),
      }

      const useCase = new CreateCrossServiceToken(
        userProjector,
        sessionProjector,
        roleProjector,
        tokenEncoder,
        userRepository,
        jwtTTL,
        getRegularSubscription,
        getSubscriptionSetting,
        sharedVaultUserRepository,
        getActiveSessionsForUser,
        undefined,
        undefined,
        getSetting,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        groupRepository as any,
      )

      const result = await useCase.execute({
        user,
        session,
      })

      expect(result.isFailed()).toBeFalsy()
      const encoded = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(encoded.roles).toEqual([
        { name: 'role1', uuid: '1-3-4' },
        { name: 'PRO_USER', uuid: 'singletier-PRO_USER' },
      ])
    })
  })

  it('should throw an error if user does not exist', async () => {
    userRepository.findOneByUuid = jest.fn().mockReturnValue(null)

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should throw an error if user uuid is invalid', async () => {
    const result = await createUseCase().execute({
      userUuid: 'invalid',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  describe('shared vault context', () => {
    it('should add shared vault context if shared vault owner uuid is provided', async () => {
      const regularSubscription = {} as jest.Mocked<UserSubscription>
      getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(regularSubscription))

      await createUseCase().execute({
        user,
        session,
        sharedVaultOwnerContext: '00000000-0000-0000-0000-000000000000',
      })

      expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalledWith(
        {
          roles: [
            {
              name: 'role1',
              uuid: '1-3-4',
            },
            {
              name: 'PRO_USER',
              uuid: 'singletier-PRO_USER',
            },
          ],
          belongs_to_shared_vaults: [
            {
              shared_vault_uuid: '00000000-0000-0000-0000-000000000000',
              permission: 'read',
            },
          ],
          session: {
            test: 'test',
          },
          shared_vault_owner_context: {
            upload_bytes_limit: 100,
          },
          user: {
            email: 'test@test.te',
            uuid: '00000000-0000-0000-0000-000000000000',
          },
          hasContentLimit: false,
          collaboration_enabled: true,
          live_sync_enabled: true,
          ai_enabled: true,
          ai_request_limit: undefined,
          version: 1,
        },
        60,
      )
    })

    it('should return an error if it fails to retrieve shared vault owner subscription', async () => {
      const result = await createUseCase().execute({
        user,
        session,
        sharedVaultOwnerContext: '00000000-0000-0000-0000-000000000000',
      })

      expect(result.isFailed()).toBeTruthy()
    })

    it('should return an error if it fails to retrieve shared vault owner setting', async () => {
      const regularSubscription = {} as jest.Mocked<UserSubscription>
      getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(regularSubscription))

      getSubscriptionSetting.execute = jest.fn().mockReturnValue(Result.fail('error'))

      const result = await createUseCase().execute({
        user,
        session,
        sharedVaultOwnerContext: '00000000-0000-0000-0000-000000000000',
      })

      expect(result.isFailed()).toBeTruthy()
    })
  })

  describe('CalDAV gating (caldav_enabled)', () => {
    it('does NOT embed caldav_enabled when the setting is unset (fail-closed)', async () => {
      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.caldav_enabled).toBeUndefined()
    })

    it('does NOT embed caldav_enabled when the setting is literally "false"', async () => {
      settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
        if (settingName === SettingName.NAMES.CaldavEnabled) {
          return Promise.resolve({ props: { value: 'false' } })
        }
        return Promise.resolve(null)
      })

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.caldav_enabled).toBeUndefined()
    })

    it('embeds caldav_enabled === true ONLY when the setting is literally "true"', async () => {
      settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
        if (settingName === SettingName.NAMES.CaldavEnabled) {
          return Promise.resolve({ props: { value: 'true' } })
        }
        return Promise.resolve(null)
      })

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.caldav_enabled).toBe(true)
    })
  })

  describe('server-side OCR gating (ocr_server_allowed)', () => {
    it('does NOT embed ocr_server_allowed when the setting is unset (fail-closed)', async () => {
      // Default mock: findLastByNameAndUserUuid resolves to null for every setting.
      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.ocr_server_allowed).toBeUndefined()
    })

    it('does NOT embed ocr_server_allowed when the setting is literally "false"', async () => {
      settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
        if (settingName === SettingName.NAMES.OcrServerAllowed) {
          return Promise.resolve({ props: { value: 'false' } })
        }
        return Promise.resolve(null)
      })

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.ocr_server_allowed).toBeUndefined()
    })

    it('embeds ocr_server_allowed === true ONLY when the setting is literally "true"', async () => {
      settingRepository.findLastByNameAndUserUuid = jest.fn().mockImplementation((settingName: string) => {
        if (settingName === SettingName.NAMES.OcrServerAllowed) {
          return Promise.resolve({ props: { value: 'true' } })
        }
        return Promise.resolve(null)
      })

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.ocr_server_allowed).toBe(true)
    })
  })

  describe('shadow-ban projection (shadow_banned)', () => {
    it('does NOT embed shadow_banned for a user who is not shadow-banned', async () => {
      user.isShadowBanned = () => false

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.shadow_banned).toBeUndefined()
    })

    it('embeds shadow_banned === true when the user is actively shadow-banned', async () => {
      user.isShadowBanned = () => true

      await createUseCase().execute({ user, session })

      const payload = (tokenEncoder.encodeExpirableToken as jest.Mock).mock.calls[0][0] as CrossServiceTokenData
      expect(payload.shadow_banned).toBe(true)
    })
  })

  describe('version determination', () => {
    describe('when no threshold is configured', () => {
      it('should set version to 1 when no application version is provided', async () => {
        const useCase = createUseCase(undefined)
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should set version to 1 when application version is provided but no threshold is configured', async () => {
        const useCase = createUseCase(undefined)
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-4.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })
    })

    describe('when threshold is configured', () => {
      it('should set version to 1 when application version is equal to threshold', async () => {
        const useCase = createUseCase('2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-2.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should set version to 1 when application version is lower than threshold', async () => {
        const useCase = createUseCase('2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-1.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should set version to 2 when application version is higher than threshold', async () => {
        const useCase = createUseCase('2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(2)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-3.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should work with different client prefixes', async () => {
        const useCase = createUseCase('1.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(2)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'mobile-2.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })
    })

    describe('edge cases', () => {
      it('should set version to 1 when application version format is invalid', async () => {
        const useCase = createUseCase('2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'invalid-version',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should handle version without client prefix', async () => {
        const useCase = createUseCase('2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(2)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: '3.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should handle prerelease versions correctly', async () => {
        const useCase = createUseCase('2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(2)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-3.0.0-beta.1',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })
    })

    describe('when both thresholds are configured', () => {
      it('issues a v3 token to a current web client with the secure stock defaults', async () => {
        const useCase = createUseCase('0.0.0', '0.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(3)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-3.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should set version to 1 when application version is below both thresholds', async () => {
        const useCase = createUseCase('2.0.0', '3.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-1.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should set version to 2 when application version is above version 2 threshold but below version 3 threshold', async () => {
        const useCase = createUseCase('2.0.0', '3.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(2)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-2.1.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should set version to 3 when application version is above both thresholds', async () => {
        const useCase = createUseCase('2.0.0', '3.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(3)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-4.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should return highest applicable version when application version exceeds multiple thresholds', async () => {
        const useCase = createUseCase('1.0.0', '2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(3)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'mobile-3.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should handle equal thresholds by selecting highest version', async () => {
        const useCase = createUseCase('2.0.0', '2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(3)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-2.1.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('should work when only version 3 threshold is set', async () => {
        const useCase = createUseCase(undefined, '2.0.0')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(3)
          return 'mocked-token'
        })

        await useCase.execute({
          user,
          applicationVersion: 'web-3.0.0',
        })

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })

      it('does not throw or upgrade a token for malformed thresholds passed by an embedding caller', async () => {
        const useCase = createUseCase('not-semver', 'also-invalid')
        tokenEncoder.encodeExpirableToken = jest.fn().mockImplementation((data: CrossServiceTokenData) => {
          expect(data.version).toBe(1)
          return 'mocked-token'
        })

        await expect(
          useCase.execute({
            user,
            applicationVersion: 'web-3.0.0',
          }),
        ).resolves.toBeDefined()

        expect(tokenEncoder.encodeExpirableToken).toHaveBeenCalled()
      })
    })
  })
})
