import 'reflect-metadata'
import { TimerInterface } from '@standardnotes/time'

import { CrypterInterface } from '../Encryption/CrypterInterface'
import { Role } from '../Role/Role'
import { RoleRepositoryInterface } from '../Role/RoleRepositoryInterface'
import { User } from '../User/User'

import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { Register } from './Register'
import { AuthResponseFactory20200115 } from '../Auth/AuthResponseFactory20200115'
import { Session } from '../Session/Session'
import { Result, RoleName } from '@standardnotes/domain-core'
import { ApplyDefaultSettings } from './ApplyDefaultSettings/ApplyDefaultSettings'
import { ActivatePremiumFeatures } from './ActivatePremiumFeatures/ActivatePremiumFeatures'
import { SettingRepositoryInterface } from '../Setting/SettingRepositoryInterface'

describe('Register', () => {
  let userRepository: UserRepositoryInterface
  let roleRepository: RoleRepositoryInterface
  let authResponseFactory: AuthResponseFactory20200115
  let applyDefaultSettings: ApplyDefaultSettings
  let user: User
  let crypter: CrypterInterface
  let timer: TimerInterface
  let session: Session
  let activatePremiumFeatures: ActivatePremiumFeatures

  const createUseCase = () =>
    new Register(userRepository, roleRepository, authResponseFactory, crypter, false, timer, applyDefaultSettings)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.save = jest.fn().mockImplementation((user: User) => {
      user.uuid = 'test'
      user.createdAt = new Date(1)
      user.updatedAt = new Date(1)

      return user
    })
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(null)
    userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(null)

    roleRepository = {} as jest.Mocked<RoleRepositoryInterface>
    roleRepository.findOneByName = jest.fn().mockReturnValue(null)

    session = {} as jest.Mocked<Session>
    authResponseFactory = {} as jest.Mocked<AuthResponseFactory20200115>
    authResponseFactory.createResponse = jest.fn().mockReturnValue({ response: { foo: 'bar' }, session })

    crypter = {} as jest.Mocked<CrypterInterface>
    crypter.generateEncryptedUserServerKey = jest.fn().mockReturnValue('test')

    user = {} as jest.Mocked<User>

    applyDefaultSettings = {} as jest.Mocked<ApplyDefaultSettings>
    applyDefaultSettings.execute = jest.fn().mockReturnValue(Result.ok())

    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(1))
    timer.getUTCDateNDaysAhead = jest.fn().mockReturnValue(new Date(2))

    activatePremiumFeatures = {} as jest.Mocked<ActivatePremiumFeatures>
    activatePremiumFeatures.execute = jest.fn().mockReturnValue(Result.ok('Premium features activated.'))
  })

  it('should register a new user', async () => {
    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({ success: true, result: { response: { foo: 'bar' }, session } })

    expect(userRepository.save).toHaveBeenCalledWith({
      email: 'test@test.te',
      encryptedPassword: expect.any(String),
      encryptedServerKey: 'test',
      serverEncryptionVersion: 1,
      pwCost: 11,
      pwNonce: undefined,
      pwSalt: 'qweqwe',
      updatedWithUserAgent: 'Mozilla',
      uuid: expect.any(String),
      version: '004',
      roles: Promise.resolve([]),
      createdAt: new Date(1),
      updatedAt: new Date(1),
    })

    expect(applyDefaultSettings.execute).toHaveBeenCalled()
  })

  it('should register a new user with default set of roles', async () => {
    const role = new Role()
    role.name = RoleName.NAMES.CoreUser

    roleRepository.findOneByName = jest.fn().mockReturnValueOnce(role)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({ success: true, result: { response: { foo: 'bar' }, session } })

    expect(userRepository.save).toHaveBeenCalledWith({
      email: 'test@test.te',
      encryptedPassword: expect.any(String),
      encryptedServerKey: 'test',
      serverEncryptionVersion: 1,
      pwCost: 11,
      pwNonce: undefined,
      pwSalt: 'qweqwe',
      updatedWithUserAgent: 'Mozilla',
      uuid: expect.any(String),
      version: '004',
      createdAt: new Date(1),
      updatedAt: new Date(1),
      roles: Promise.resolve([role]),
    })
  })

  it('should activate Standard Red full features only in explicit provisioned-full mode', async () => {
    expect(
      await new Register(
        userRepository,
        roleRepository,
        authResponseFactory,
        crypter,
        false,
        timer,
        applyDefaultSettings,
        'provisioned-full',
        activatePremiumFeatures,
      ).execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({ success: true, result: { response: { foo: 'bar' }, session } })

    expect(activatePremiumFeatures.execute).toHaveBeenCalledWith({
      username: 'test@test.te',
      subscriptionId: expect.any(Number),
      subscriptionPlanName: 'PRO_PLAN',
      uploadBytesLimit: -1,
      endsAt: new Date(2),
      cancelPreviousSubscription: true,
    })
  })

  it('should not activate Standard Red full features in included mode', async () => {
    await new Register(
      userRepository,
      roleRepository,
      authResponseFactory,
      crypter,
      false,
      timer,
      applyDefaultSettings,
      'included',
      activatePremiumFeatures,
    ).execute({
      email: 'test@test.te',
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
      pwCost: 11,
      pwSalt: 'qweqwe',
      pwNonce: undefined,
    })

    expect(activatePremiumFeatures.execute).not.toHaveBeenCalled()
  })

  it('should not activate Standard Red full features in subscription entitlement mode', async () => {
    await new Register(
      userRepository,
      roleRepository,
      authResponseFactory,
      crypter,
      false,
      timer,
      applyDefaultSettings,
      'subscription',
      activatePremiumFeatures,
    ).execute({
      email: 'test@test.te',
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
      pwCost: 11,
      pwSalt: 'qweqwe',
      pwNonce: undefined,
    })

    expect(activatePremiumFeatures.execute).not.toHaveBeenCalled()
  })

  it('should fail to register if applying default settings fails', async () => {
    applyDefaultSettings.execute = jest.fn().mockReturnValue(Result.fail('error'))

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({
      success: false,
      errorMessage: 'error',
    })
  })

  it('should fail to register if username is invalid', async () => {
    expect(
      await createUseCase().execute({
        email: '      ',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Username cannot be empty',
    })

    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should fail to register if a user already exists', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({
      success: false,
      errorMessage: 'This email is already registered.',
    })

    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should fail to register for legacy api versions', async () => {
    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20190520',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Unsupported api version: 20190520',
    })

    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('should fail to register if a registration is disabled', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    expect(
      await new Register(
        userRepository,
        roleRepository,
        authResponseFactory,
        crypter,
        true,
        timer,
        applyDefaultSettings,
      ).execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        version: '004',
        ephemeralSession: false,
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({
      success: false,
      errorMessage: 'User registration is currently not allowed.',
    })

    expect(userRepository.save).not.toHaveBeenCalled()
  })

  describe('Standard Red Notes: admin-panel persisted REGISTRATION_DISABLED flag', () => {
    const createUseCaseWithSettingRepository = (settingRepository: SettingRepositoryInterface) =>
      new Register(
        userRepository,
        roleRepository,
        authResponseFactory,
        crypter,
        // env override is OFF; only the persisted flag should govern here.
        false,
        timer,
        applyDefaultSettings,
        'subscription',
        undefined,
        36500,
        -1,
        false,
        settingRepository,
      )

    const dto = {
      email: 'test@test.te',
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
      pwCost: 11,
      pwSalt: 'qweqwe',
      pwNonce: undefined,
    }

    it('blocks registration when the persisted flag is set even though the env override is OFF', async () => {
      const settingRepository = {
        countAllByNameAndValue: jest.fn().mockResolvedValue(1),
      } as unknown as SettingRepositoryInterface

      const result = await createUseCaseWithSettingRepository(settingRepository).execute(dto)

      expect(result).toEqual({
        success: false,
        errorMessage: 'User registration is currently not allowed.',
      })
      expect(settingRepository.countAllByNameAndValue).toHaveBeenCalledWith({
        name: expect.objectContaining({ props: { value: 'REGISTRATION_DISABLED' } }),
        value: 'true',
      })
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it('allows registration when the persisted flag is NOT set', async () => {
      const settingRepository = {
        countAllByNameAndValue: jest.fn().mockResolvedValue(0),
      } as unknown as SettingRepositoryInterface

      const result = await createUseCaseWithSettingRepository(settingRepository).execute(dto)

      expect(result.success).toBe(true)
      expect(userRepository.save).toHaveBeenCalled()
    })

    it('keeps the env override as a hard block regardless of the persisted flag', async () => {
      const settingRepository = {
        countAllByNameAndValue: jest.fn().mockResolvedValue(0),
      } as unknown as SettingRepositoryInterface

      const result = await new Register(
        userRepository,
        roleRepository,
        authResponseFactory,
        crypter,
        // env override ON.
        true,
        timer,
        applyDefaultSettings,
        'subscription',
        undefined,
        36500,
        -1,
        false,
        settingRepository,
      ).execute(dto)

      expect(result).toEqual({
        success: false,
        errorMessage: 'User registration is currently not allowed.',
      })
      // Env short-circuits before the setting store is consulted.
      expect(settingRepository.countAllByNameAndValue).not.toHaveBeenCalled()
      expect(userRepository.save).not.toHaveBeenCalled()
    })
  })

  it('should fail to register if api version is invalid', async () => {
    expect(
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '',
        ephemeralSession: false,
        version: '004',
        pwCost: 11,
        pwSalt: 'qweqwe',
        pwNonce: undefined,
      }),
    ).toEqual({
      success: false,
      errorMessage: 'Invalid api version: ',
    })

    expect(userRepository.save).not.toHaveBeenCalled()
  })

  describe('Standard Red Notes: workspaces per email (WORKSPACES_PER_EMAIL_ENABLED)', () => {
    const workspacesPerEmailEnabled = true

    const createUseCaseWithWorkspaces = () =>
      new Register(
        userRepository,
        roleRepository,
        authResponseFactory,
        crypter,
        false,
        timer,
        applyDefaultSettings,
        'subscription',
        undefined,
        36500,
        -1,
        workspacesPerEmailEnabled,
      )

    it('flag OFF: does NOT set workspaceIdentifier on the saved entity and uses the email-only duplicate check', async () => {
      await createUseCase().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        workspaceIdentifier: 'ignored-when-off',
      })

      expect(userRepository.findOneByUsernameOrEmail).toHaveBeenCalled()
      expect(userRepository.findOneByEmailAndWorkspaceIdentifier).not.toHaveBeenCalled()
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0]
      // No-op guarantee: the workspace property is never stamped when OFF.
      expect(savedUser.workspaceIdentifier).toBeUndefined()
    })

    it('flag ON: allows the same email under a different workspace and stamps the workspace identifier', async () => {
      // No account exists for (email, 'team-a').
      userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(null)

      const result = await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        workspaceIdentifier: 'team-a',
      })

      expect(result.success).toBe(true)
      expect(userRepository.findOneByEmailAndWorkspaceIdentifier).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'test@test.te' }),
        'team-a',
      )
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0]
      expect(savedUser.workspaceIdentifier).toBe('team-a')
    })

    it('flag ON: rejects a duplicate (email, workspace) pair', async () => {
      userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(user)

      const result = await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
        workspaceIdentifier: 'team-a',
      })

      expect(result).toEqual({
        success: false,
        errorMessage: 'This email is already registered for this workspace.',
      })
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it("flag ON: an absent workspace name resolves to the 'default' workspace", async () => {
      userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(null)

      const result = await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
      })

      expect(result.success).toBe(true)
      expect(userRepository.findOneByEmailAndWorkspaceIdentifier).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'test@test.te' }),
        'default',
      )
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0]
      expect(savedUser.workspaceIdentifier).toBe('default')
    })

    it("flag ON: rejecting a duplicate default workspace keeps the legacy error message", async () => {
      userRepository.findOneByEmailAndWorkspaceIdentifier = jest.fn().mockReturnValue(user)

      const result = await createUseCaseWithWorkspaces().execute({
        email: 'test@test.te',
        password: 'asdzxc',
        updatedWithUserAgent: 'Mozilla',
        apiVersion: '20200115',
        ephemeralSession: false,
        version: '004',
      })

      expect(result).toEqual({
        success: false,
        errorMessage: 'This email is already registered.',
      })
    })
  })
})
