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
import { RegistrationConfigResolverInterface } from '../Registration/RegistrationConfigResolverInterface'
import { RegistrationConfig } from '../Registration/RegistrationConfig'
import { SignupLimitsConfig } from '../Registration/SignupLimitsConfig'
import { SignupLimitsConfigResolverInterface } from '../Registration/SignupLimitsConfigResolverInterface'
import { SignupRateLimiterInterface } from '../Registration/SignupRateLimiterInterface'
import { UniqueEntityId } from '@standardnotes/domain-core'
import { ConsumeSignupInvite } from './ConsumeSignupInvite/ConsumeSignupInvite'
import { SignupInviteLink } from '../SignupInvite/SignupInviteLink'
import { SignupInviteLinkRepositoryInterface } from '../SignupInvite/SignupInviteLinkRepositoryInterface'
import { SignupInviteLinkProps } from '../SignupInvite/SignupInviteLinkProps'
import { hashSignupInviteToken } from '../SignupInvite/hashSignupInviteToken'

/**
 * Standard Red Notes: an in-memory invite-link repository whose consumeSlot
 * emulates the DB's atomic conditional UPDATE — the check-and-increment is
 * SYNCHRONOUS (no await between reading used_count and incrementing it), which is
 * exactly the serialization the DB row lock provides. This lets the concurrency
 * test assert that two concurrent consumes on a 1-slot link cannot both succeed
 * at the use-case layer; the SQL UPDATE is the authority in production.
 */
const makeFakeInviteRepo = (
  seed: Partial<SignupInviteLinkProps> & { token: string; maxUses: number },
): { repo: SignupInviteLinkRepositoryInterface; state: { usedCount: number } } => {
  const hashedToken = hashSignupInviteToken(seed.token)
  const state = {
    usedCount: seed.usedCount ?? 0,
    revoked: seed.revoked ?? false,
    expiresAt: seed.expiresAt ?? null,
  }
  const buildLink = (): SignupInviteLink =>
    SignupInviteLink.create(
      {
        hashedToken,
        label: seed.label ?? null,
        maxUses: seed.maxUses,
        usedCount: state.usedCount,
        expiresAt: state.expiresAt,
        revoked: state.revoked,
        defaultRole: seed.defaultRole ?? null,
        allowedDomain: seed.allowedDomain ?? null,
        createdBy: seed.createdBy ?? null,
        createdByUserUuid: seed.createdByUserUuid ?? null,
        createdByKind: seed.createdByKind ?? 'admin',
        autoApprove: seed.autoApprove ?? true,
        createdAt: new Date(1),
        updatedAt: new Date(1),
      },
      new UniqueEntityId('invite-link-uuid'),
    ).getValue()

  const repo = {
    save: jest.fn(),
    findByUuid: jest.fn(),
    listAll: jest.fn(),
    listByCreatorUser: jest.fn(),
    countActiveByCreatorUser: jest.fn(),
    revokeByUuid: jest.fn(),
    findByHashedToken: jest.fn(async (hash: string) => (hash === hashedToken ? buildLink() : null)),
    // Synchronous check-and-increment inside the promise executor — models the
    // atomic UPDATE ... WHERE used_count < max_uses under the row lock.
    consumeSlot: jest.fn(
      (hash: string, now: Date) =>
        new Promise<boolean>((resolve) => {
          if (hash !== hashedToken) {
            resolve(false)
            return
          }
          const valid =
            !state.revoked &&
            state.usedCount < seed.maxUses &&
            (state.expiresAt === null || state.expiresAt.getTime() > now.getTime())
          if (!valid) {
            resolve(false)
            return
          }
          state.usedCount += 1
          resolve(true)
        }),
    ),
  } as unknown as SignupInviteLinkRepositoryInterface

  return { repo, state }
}

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

    it('blocks registration when an admin-owned persisted flag is set even though the env override is OFF', async () => {
      const settingRepository = {
        countAllByNameAndValueOwnedByRole: jest.fn().mockResolvedValue(1),
      } as unknown as SettingRepositoryInterface

      const result = await createUseCaseWithSettingRepository(settingRepository).execute(dto)

      expect(result).toEqual({
        success: false,
        errorMessage: 'User registration is currently not allowed.',
      })
      // The count is scoped to rows OWNED BY AN ADMIN so a non-admin can never
      // disable registration by persisting the flag on their own record.
      expect(settingRepository.countAllByNameAndValueOwnedByRole).toHaveBeenCalledWith({
        name: expect.objectContaining({ props: { value: 'REGISTRATION_DISABLED' } }),
        value: 'true',
        roleName: RoleName.NAMES.AdminUser,
      })
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it('allows registration when no admin-owned persisted flag is set (e.g. only a stale non-admin row exists)', async () => {
      // The repository counts only admin-owned rows, so a leftover non-admin
      // REGISTRATION_DISABLED='true' row resolves to a count of 0 here.
      const settingRepository = {
        countAllByNameAndValueOwnedByRole: jest.fn().mockResolvedValue(0),
      } as unknown as SettingRepositoryInterface

      const result = await createUseCaseWithSettingRepository(settingRepository).execute(dto)

      expect(result.success).toBe(true)
      expect(userRepository.save).toHaveBeenCalled()
    })

    it('keeps the env override as a hard block regardless of the persisted flag', async () => {
      const settingRepository = {
        countAllByNameAndValueOwnedByRole: jest.fn().mockResolvedValue(0),
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
      expect(settingRepository.countAllByNameAndValueOwnedByRole).not.toHaveBeenCalled()
      expect(userRepository.save).not.toHaveBeenCalled()
    })
  })

  describe('Standard Red Notes: configurable default role + email-domain policy', () => {
    const makeResolver = (config: Partial<RegistrationConfig>): RegistrationConfigResolverInterface => ({
      resolve: jest.fn().mockResolvedValue({
        defaultRole: RoleName.NAMES.CoreUser,
        domainMode: 'off',
        domainList: [],
        ...config,
      } as RegistrationConfig),
    })

    const createUseCaseWithResolver = (resolver: RegistrationConfigResolverInterface) =>
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
        false,
        undefined,
        resolver,
      )

    const dtoFor = (email: string) => ({
      email,
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
      pwCost: 11,
      pwSalt: 'qweqwe',
      pwNonce: undefined,
    })

    it('assigns the admin-configured default role to a new user', async () => {
      const proRole = { name: RoleName.NAMES.ProUser } as unknown as Role
      roleRepository.findOneByName = jest.fn().mockResolvedValue(proRole)

      const result = await createUseCaseWithResolver(
        makeResolver({ defaultRole: RoleName.NAMES.ProUser }),
      ).execute(dtoFor('person@example.com'))

      expect(result.success).toBe(true)
      expect(roleRepository.findOneByName).toHaveBeenCalledWith(RoleName.NAMES.ProUser)
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0] as User
      await expect(savedUser.roles).resolves.toEqual([proRole])
    })

    it('defaults to CORE_USER when no resolver is wired (legacy behavior)', async () => {
      roleRepository.findOneByName = jest.fn().mockResolvedValue(null)

      await createUseCase().execute(dtoFor('person@example.com'))

      expect(roleRepository.findOneByName).toHaveBeenCalledWith(RoleName.NAMES.CoreUser)
    })

    it('falls back to CORE_USER when the configured role is not seeded in the database', async () => {
      const coreRole = { name: RoleName.NAMES.CoreUser } as unknown as Role
      roleRepository.findOneByName = jest.fn().mockImplementation((name: string) =>
        Promise.resolve(name === RoleName.NAMES.CoreUser ? coreRole : null),
      )

      const result = await createUseCaseWithResolver(
        makeResolver({ defaultRole: RoleName.NAMES.VaultsUser }),
      ).execute(dtoFor('person@example.com'))

      expect(result.success).toBe(true)
      expect(roleRepository.findOneByName).toHaveBeenCalledWith(RoleName.NAMES.VaultsUser)
      expect(roleRepository.findOneByName).toHaveBeenCalledWith(RoleName.NAMES.CoreUser)
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0] as User
      await expect(savedUser.roles).resolves.toEqual([coreRole])
    })

    it('allowlist: refuses an email whose domain is NOT in the list', async () => {
      const result = await createUseCaseWithResolver(
        makeResolver({ domainMode: 'allowlist', domainList: ['company.com'] }),
      ).execute(dtoFor('person@example.com'))

      expect(result).toEqual({
        success: false,
        errorMessage: 'Registration is not allowed for this email domain.',
      })
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it('allowlist: allows an email whose domain (or subdomain) is in the list', async () => {
      const result = await createUseCaseWithResolver(
        makeResolver({ domainMode: 'allowlist', domainList: ['company.com'] }),
      ).execute(dtoFor('person@eu.company.com'))

      expect(result.success).toBe(true)
      expect(userRepository.save).toHaveBeenCalled()
    })

    it('blocklist: refuses an email whose domain is in the list', async () => {
      const result = await createUseCaseWithResolver(
        makeResolver({ domainMode: 'blocklist', domainList: ['spam.com'] }),
      ).execute(dtoFor('person@spam.com'))

      expect(result).toEqual({
        success: false,
        errorMessage: 'Registration is not allowed for this email domain.',
      })
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it('blocklist: allows an email whose domain is NOT in the list', async () => {
      const result = await createUseCaseWithResolver(
        makeResolver({ domainMode: 'blocklist', domainList: ['spam.com'] }),
      ).execute(dtoFor('person@example.com'))

      expect(result.success).toBe(true)
      expect(userRepository.save).toHaveBeenCalled()
    })

    it('off: allows any email domain', async () => {
      const result = await createUseCaseWithResolver(
        makeResolver({ domainMode: 'off', domainList: ['company.com'] }),
      ).execute(dtoFor('person@anywhere.example'))

      expect(result.success).toBe(true)
      expect(userRepository.save).toHaveBeenCalled()
    })
  })

  describe('Standard Red Notes: configurable signup caps (per-week / per-IP / per-device)', () => {
    const GENERIC_REFUSAL = 'User registration is currently not allowed.'

    const makeLimitsResolver = (config: Partial<SignupLimitsConfig>): SignupLimitsConfigResolverInterface => ({
      resolve: jest.fn().mockResolvedValue({
        perIpMax: 0,
        perIpWindowHours: 24,
        perWeekMax: 0,
        perDeviceMax: 0,
        perDeviceWindowHours: 24,
        ...config,
      } as SignupLimitsConfig),
    })

    const createUseCaseWithLimits = (
      resolver: SignupLimitsConfigResolverInterface,
      rateLimiter?: SignupRateLimiterInterface,
    ) =>
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
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        rateLimiter,
        resolver,
      )

    const dtoFor = (overrides: { ipAddress?: string | null; deviceId?: string } = {}) => ({
      email: 'person@example.com',
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
      ipAddress: overrides.ipAddress,
      deviceId: overrides.deviceId,
    })

    describe('per-week global cap', () => {
      it('refuses once the rolling-7-day count has reached the cap', async () => {
        userRepository.countAllCreatedBetween = jest.fn().mockResolvedValue(5)

        const result = await createUseCaseWithLimits(makeLimitsResolver({ perWeekMax: 5 })).execute(dtoFor())

        expect(result).toEqual({ success: false, errorMessage: GENERIC_REFUSAL })
        expect(userRepository.save).not.toHaveBeenCalled()
        // Reads a ~7-day window ending "now" (timer.getUTCDate mocked to new Date(1)).
        const [start, end] = (userRepository.countAllCreatedBetween as jest.Mock).mock.calls[0]
        expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
      })

      it('allows a signup while under the cap', async () => {
        userRepository.countAllCreatedBetween = jest.fn().mockResolvedValue(4)

        const result = await createUseCaseWithLimits(makeLimitsResolver({ perWeekMax: 5 })).execute(dtoFor())

        expect(result.success).toBe(true)
        expect(userRepository.save).toHaveBeenCalled()
      })

      it('FAILS OPEN when the DB count throws', async () => {
        userRepository.countAllCreatedBetween = jest.fn().mockRejectedValue(new Error('db down'))

        const result = await createUseCaseWithLimits(makeLimitsResolver({ perWeekMax: 5 })).execute(dtoFor())

        expect(result.success).toBe(true)
        expect(userRepository.save).toHaveBeenCalled()
      })
    })

    describe('per-IP cap', () => {
      it('refuses once the post-increment count exceeds the cap', async () => {
        const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(4) }

        const result = await createUseCaseWithLimits(
          makeLimitsResolver({ perIpMax: 3, perIpWindowHours: 24 }),
          rateLimiter,
        ).execute(dtoFor({ ipAddress: '1.2.3.4' }))

        expect(result).toEqual({ success: false, errorMessage: GENERIC_REFUSAL })
        expect(rateLimiter.incrementAndCount).toHaveBeenCalledWith('signup:ip:1.2.3.4', 24 * 3600)
        expect(userRepository.save).not.toHaveBeenCalled()
      })

      it('allows a signup at exactly the cap', async () => {
        const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(3) }

        const result = await createUseCaseWithLimits(makeLimitsResolver({ perIpMax: 3 }), rateLimiter).execute(
          dtoFor({ ipAddress: '1.2.3.4' }),
        )

        expect(result.success).toBe(true)
        expect(userRepository.save).toHaveBeenCalled()
      })

      it('FAILS OPEN when the limiter cannot determine a count (Redis absent/error -> null)', async () => {
        const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(null) }

        const result = await createUseCaseWithLimits(makeLimitsResolver({ perIpMax: 1 }), rateLimiter).execute(
          dtoFor({ ipAddress: '1.2.3.4' }),
        )

        expect(result.success).toBe(true)
        expect(userRepository.save).toHaveBeenCalled()
      })

      it('is a no-op when no rate limiter is wired even if the cap is set', async () => {
        const result = await createUseCaseWithLimits(makeLimitsResolver({ perIpMax: 1 })).execute(
          dtoFor({ ipAddress: '1.2.3.4' }),
        )

        expect(result.success).toBe(true)
        expect(userRepository.save).toHaveBeenCalled()
      })
    })

    describe('per-device SOFT cap', () => {
      it('is enforced ONLY when the client supplied a device id', async () => {
        const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(2) }

        // No deviceId on the request: the per-device counter is never consulted.
        const allowed = await createUseCaseWithLimits(makeLimitsResolver({ perDeviceMax: 1 }), rateLimiter).execute(
          dtoFor(),
        )
        expect(allowed.success).toBe(true)
        expect(rateLimiter.incrementAndCount).not.toHaveBeenCalled()
      })

      it('refuses once a present device id exceeds the cap', async () => {
        const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(2) }

        const result = await createUseCaseWithLimits(
          makeLimitsResolver({ perDeviceMax: 1, perDeviceWindowHours: 24 }),
          rateLimiter,
        ).execute(dtoFor({ deviceId: 'dev-abc' }))

        expect(result).toEqual({ success: false, errorMessage: GENERIC_REFUSAL })
        expect(rateLimiter.incrementAndCount).toHaveBeenCalledWith('signup:dev:dev-abc', 24 * 3600)
        expect(userRepository.save).not.toHaveBeenCalled()
      })

      it('never stamps the client-supplied device id onto the persisted user entity', async () => {
        const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(1) }

        await createUseCaseWithLimits(makeLimitsResolver({ perDeviceMax: 5 }), rateLimiter).execute(
          dtoFor({ deviceId: 'dev-abc' }),
        )

        const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0]
        expect(savedUser.deviceId).toBeUndefined()
      })
    })

    it('all caps = 0 (unlimited) is a complete no-op even with a limiter present', async () => {
      const rateLimiter = { incrementAndCount: jest.fn().mockResolvedValue(999) }
      userRepository.countAllCreatedBetween = jest.fn().mockResolvedValue(999)

      const result = await createUseCaseWithLimits(makeLimitsResolver({}), rateLimiter).execute(
        dtoFor({ ipAddress: '1.2.3.4', deviceId: 'dev-abc' }),
      )

      expect(result.success).toBe(true)
      expect(rateLimiter.incrementAndCount).not.toHaveBeenCalled()
      expect(userRepository.countAllCreatedBetween).not.toHaveBeenCalled()
      expect(userRepository.save).toHaveBeenCalled()
    })

    it('FAILS OPEN when the limits resolver itself throws (registration is never taken down)', async () => {
      const rateLimiter = { incrementAndCount: jest.fn() }
      const resolver: SignupLimitsConfigResolverInterface = {
        resolve: jest.fn().mockRejectedValue(new Error('overlay unreadable')),
      }

      const result = await createUseCaseWithLimits(resolver, rateLimiter).execute(
        dtoFor({ ipAddress: '1.2.3.4', deviceId: 'dev-abc' }),
      )

      expect(result.success).toBe(true)
      expect(rateLimiter.incrementAndCount).not.toHaveBeenCalled()
      expect(userRepository.save).toHaveBeenCalled()
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

  describe('Standard Red Notes: email confirmation on registration', () => {
    const makeResolver = (config: Partial<RegistrationConfig>): RegistrationConfigResolverInterface => ({
      resolve: jest.fn().mockResolvedValue({
        defaultRole: RoleName.NAMES.CoreUser,
        domainMode: 'off',
        domainList: [],
        emailConfirmationEnabled: false,
        emailConfirmationGating: 'block_signin',
        emailConfirmationSubject: 's',
        emailConfirmationBody: 'b',
        emailConfirmationBaseUrl: 'https://notes.example.com',
        ...config,
      } as RegistrationConfig),
    })

    const dto = {
      email: 'person@example.com',
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
    }

    const createWith = (resolver: RegistrationConfigResolverInterface, sender?: { execute: jest.Mock }) =>
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
        false,
        undefined,
        resolver,
        sender as never,
      )

    it('creates the user UNCONFIRMED and sends the confirmation email when enabled', async () => {
      const sender = { execute: jest.fn().mockResolvedValue(Result.ok(true)) }
      const result = await createWith(makeResolver({ emailConfirmationEnabled: true }), sender).execute(dto)

      expect(result.success).toBe(true)
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0] as User
      expect(savedUser.emailConfirmed).toBe(false)
      expect(sender.execute).toHaveBeenCalledWith(
        expect.objectContaining({ userUuid: expect.any(String), email: 'person@example.com' }),
      )
    })

    it('does NOT touch emailConfirmed or send an email when the feature is disabled', async () => {
      const sender = { execute: jest.fn() }
      const result = await createWith(makeResolver({ emailConfirmationEnabled: false }), sender).execute(dto)

      expect(result.success).toBe(true)
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0] as User
      expect(savedUser.emailConfirmed).toBeUndefined()
      expect(sender.execute).not.toHaveBeenCalled()
    })

    it('does NOT create an unconfirmed user when enabled but no sender is wired (never lock out)', async () => {
      const result = await createWith(makeResolver({ emailConfirmationEnabled: true })).execute(dto)

      expect(result.success).toBe(true)
      const savedUser = (userRepository.save as jest.Mock).mock.calls[0][0] as User
      expect(savedUser.emailConfirmed).toBeUndefined()
    })

    it('still succeeds if the confirmation email send throws (best-effort)', async () => {
      const sender = { execute: jest.fn().mockRejectedValue(new Error('smtp down')) }
      const result = await createWith(makeResolver({ emailConfirmationEnabled: true }), sender).execute(dto)

      expect(result.success).toBe(true)
    })
  })

  describe('Standard Red Notes: signup invite links (invite-only gate + atomic slot consume)', () => {
    const makeResolver = (config: Partial<RegistrationConfig>): RegistrationConfigResolverInterface => ({
      resolve: jest.fn().mockResolvedValue({
        defaultRole: RoleName.NAMES.CoreUser,
        domainMode: 'off',
        domainList: [],
        emailConfirmationEnabled: false,
        emailConfirmationGating: 'block_signin',
        emailConfirmationSubject: 's',
        emailConfirmationBody: 'b',
        emailConfirmationBaseUrl: '',
        inviteOnly: false,
        ...config,
      } as RegistrationConfig),
    })

    const dtoFor = (overrides: { email?: string; inviteToken?: string } = {}) => ({
      email: overrides.email ?? 'person@example.com',
      password: 'asdzxc',
      updatedWithUserAgent: 'Mozilla',
      apiVersion: '20200115',
      ephemeralSession: false,
      version: '004',
      inviteToken: overrides.inviteToken,
    })

    const createWithInvite = (
      resolver: RegistrationConfigResolverInterface,
      consumer?: ConsumeSignupInvite,
    ) =>
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
        false,
        undefined,
        resolver,
        undefined,
        undefined,
        undefined,
        undefined,
        consumer,
      )

    it('invite-only ON with NO token is refused (fail closed, generic message)', async () => {
      const { repo } = makeFakeInviteRepo({ token: 'tok', maxUses: 1 })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor(),
      )

      expect(result).toEqual({ success: false, errorMessage: 'User registration is currently not allowed.' })
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it('invite-only ON with NO consumer wired is refused (fail closed)', async () => {
      const result = await createWithInvite(makeResolver({ inviteOnly: true })).execute(
        dtoFor({ inviteToken: 'anything' }),
      )

      expect(result.success).toBe(false)
      expect(userRepository.save).not.toHaveBeenCalled()
    })

    it('invite-only ON with a VALID token succeeds and consumes exactly one slot', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 1 })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ inviteToken: 'tok' }),
      )

      expect(result.success).toBe(true)
      expect(state.usedCount).toBe(1)
    })

    it('invite-only ON with an EXPIRED link is refused', async () => {
      const { repo } = makeFakeInviteRepo({ token: 'tok', maxUses: 1, expiresAt: new Date(0) })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ inviteToken: 'tok' }),
      )

      expect(result.success).toBe(false)
    })

    it('invite-only ON with a REVOKED link is refused', async () => {
      const { repo } = makeFakeInviteRepo({ token: 'tok', maxUses: 1, revoked: true })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ inviteToken: 'tok' }),
      )

      expect(result.success).toBe(false)
    })

    it('CONCURRENCY: two concurrent registrations on a 1-slot link — exactly one succeeds, used_count ends at 1', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 1 })
      const consumer = new ConsumeSignupInvite(repo)

      const [a, b] = await Promise.all([
        createWithInvite(makeResolver({ inviteOnly: true }), consumer).execute(dtoFor({ inviteToken: 'tok' })),
        createWithInvite(makeResolver({ inviteOnly: true }), consumer).execute(dtoFor({ inviteToken: 'tok' })),
      ])

      const successes = [a, b].filter((r) => r.success).length
      expect(successes).toBe(1)
      expect(state.usedCount).toBe(1)
    })

    it('BATCH: a max_uses=2 link allows exactly two signups then refuses the third', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 2 })
      const consumer = new ConsumeSignupInvite(repo)
      const run = () =>
        createWithInvite(makeResolver({ inviteOnly: true }), consumer).execute(dtoFor({ inviteToken: 'tok' }))

      expect((await run()).success).toBe(true)
      expect((await run()).success).toBe(true)
      expect((await run()).success).toBe(false)
      expect(state.usedCount).toBe(2)
    })

    it('invite-only OFF with a VALID token still honors + consumes it (batch links work in open mode)', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 5 })
      const result = await createWithInvite(makeResolver({ inviteOnly: false }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ inviteToken: 'tok' }),
      )

      expect(result.success).toBe(true)
      expect(state.usedCount).toBe(1)
    })

    it('invite-only OFF with an INVALID token still succeeds (fail open — the link is a bonus)', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 1 })
      const result = await createWithInvite(makeResolver({ inviteOnly: false }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ inviteToken: 'wrong-token' }),
      )

      expect(result.success).toBe(true)
      expect(state.usedCount).toBe(0)
    })

    it('invite-only OFF with NO token succeeds and never touches the consumer', async () => {
      const { repo } = makeFakeInviteRepo({ token: 'tok', maxUses: 1 })
      const consumer = new ConsumeSignupInvite(repo)
      const result = await createWithInvite(makeResolver({ inviteOnly: false }), consumer).execute(dtoFor())

      expect(result.success).toBe(true)
      expect(repo.consumeSlot).not.toHaveBeenCalled()
    })

    it('a per-link email-domain lock refuses a mismatching email (invite-only) and never consumes', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 1, allowedDomain: 'company.com' })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ email: 'person@other.com', inviteToken: 'tok' }),
      )

      expect(result.success).toBe(false)
      expect(state.usedCount).toBe(0)
    })

    it('a per-link email-domain lock accepts a matching email (and its subdomains)', async () => {
      const { repo, state } = makeFakeInviteRepo({ token: 'tok', maxUses: 1, allowedDomain: 'company.com' })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ email: 'person@mail.company.com', inviteToken: 'tok' }),
      )

      expect(result.success).toBe(true)
      expect(state.usedCount).toBe(1)
    })

    it('applies the link default_role override to the new account', async () => {
      const proRole = new Role()
      proRole.name = RoleName.NAMES.ProUser
      roleRepository.findOneByName = jest.fn().mockResolvedValue(proRole)

      const { repo } = makeFakeInviteRepo({
        token: 'tok',
        maxUses: 1,
        defaultRole: RoleName.NAMES.ProUser,
      })
      const result = await createWithInvite(makeResolver({ inviteOnly: true }), new ConsumeSignupInvite(repo)).execute(
        dtoFor({ inviteToken: 'tok' }),
      )

      expect(result.success).toBe(true)
      expect(roleRepository.findOneByName).toHaveBeenCalledWith(RoleName.NAMES.ProUser)
    })
  })
})
