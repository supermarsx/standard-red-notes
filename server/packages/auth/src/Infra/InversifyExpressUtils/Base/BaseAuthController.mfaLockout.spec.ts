import 'reflect-metadata'

/**
 * Deterministic TOTP. The real otplib would make "is this token wrong?" depend on
 * the wall clock; VerifyMFA is still the real use case, and it is VerifyMFA that
 * decides which ErrorTag a rejected code carries — the thing this spec must not
 * assume.
 */
jest.mock('otplib', () => ({
  generateSync: jest.fn(() => '123456'),
  verifySync: jest.fn(({ token }: { token: string }) => ({ valid: token === '123456' })),
}))

import { ReadStream } from 'fs'
import { Request, Response } from 'express'
import { Logger } from 'winston'
import { ErrorTag } from '@standardnotes/responses'
import { DeterministicSelector } from '@standardnotes/security'
import { Email, Result, SettingName, Timestamps, UniqueEntityId, Username, Uuid } from '@standardnotes/domain-core'

import { AppPassword } from '../../../Domain/AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../../Domain/AppPassword/AppPasswordRepositoryInterface'
import { Authenticator } from '../../../Domain/Authenticator/Authenticator'
import { AuthenticatorChallenge } from '../../../Domain/Authenticator/AuthenticatorChallenge'
import { AuthenticatorChallengeRepositoryInterface } from '../../../Domain/Authenticator/AuthenticatorChallengeRepositoryInterface'
import { AuthenticatorRepositoryInterface } from '../../../Domain/Authenticator/AuthenticatorRepositoryInterface'
import { ClearLoginAttempts } from '../../../Domain/UseCase/ClearLoginAttempts'
import { EncryptionVersion } from '../../../Domain/Encryption/EncryptionVersion'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { GetUserKeyParams } from '../../../Domain/UseCase/GetUserKeyParams/GetUserKeyParams'
import { IncreaseLoginAttempts } from '../../../Domain/UseCase/IncreaseLoginAttempts'
import { LockRepositoryInterface } from '../../../Domain/User/LockRepositoryInterface'
import { LoginLockGuard } from '../../../Domain/User/LoginLockGuard'
import { MagicLinkToken } from '../../../Domain/MagicLink/MagicLinkToken'
import { MagicLinkTokenRepositoryInterface } from '../../../Domain/MagicLink/MagicLinkTokenRepositoryInterface'
import { ProofOfWorkChallengeRepositoryInterface } from '../../../Domain/ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { ProofOfWorkConfig } from '../../../Domain/ProofOfWork/ProofOfWorkConfig'
import { ProofOfWorkConfigResolverInterface } from '../../../Domain/ProofOfWork/ProofOfWorkConfigResolverInterface'
import { ProofOfWorkGate } from '../../../Domain/ProofOfWork/ProofOfWorkGate'
import { RequestProofOfWorkChallenge } from '../../../Domain/UseCase/RequestProofOfWorkChallenge/RequestProofOfWorkChallenge'
import { Session } from '../../../Domain/Session/Session'
import { SessionRepositoryInterface } from '../../../Domain/Session/SessionRepositoryInterface'
import { Setting } from '../../../Domain/Setting/Setting'
import { SettingCrypterInterface } from '../../../Domain/Setting/SettingCrypterInterface'
import { SettingRepositoryInterface } from '../../../Domain/Setting/SettingRepositoryInterface'
import { SubscriptionSetting } from '../../../Domain/Setting/SubscriptionSetting'
import { TrustedDevice } from '../../../Domain/TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../../../Domain/TrustedDevice/TrustedDeviceRepositoryInterface'
import { User } from '../../../Domain/User/User'
import {
  AdminUserListQuery,
  AdminUserListResult,
  UserRepositoryInterface,
} from '../../../Domain/User/UserRepositoryInterface'
import { VerifyAppPassword } from '../../../Domain/UseCase/VerifyAppPassword/VerifyAppPassword'
import { VerifyAuthenticatorAuthenticationResponse } from '../../../Domain/UseCase/VerifyAuthenticatorAuthenticationResponse/VerifyAuthenticatorAuthenticationResponse'
import { VerifyMFA } from '../../../Domain/UseCase/VerifyMFA'
import { VerifyMagicLinkCode } from '../../../Domain/UseCase/VerifyMagicLinkCode/VerifyMagicLinkCode'
import { VerifyProofOfWork } from '../../../Domain/UseCase/VerifyProofOfWork/VerifyProofOfWork'
import { VerifyTrustedDevice } from '../../../Domain/UseCase/VerifyTrustedDevice/VerifyTrustedDevice'
import { VerifyUserServerPassword } from '../../../Domain/UseCase/VerifyUserServerPassword/VerifyUserServerPassword'
import { SignIn } from '../../../Domain/UseCase/SignIn'
import { BaseAuthController } from './BaseAuthController'

/**
 * Standard Red Notes: SECOND-FACTOR BRUTE FORCE.
 *
 * `POST /v2/login-params` and `GET /v1/login-params` both proxy to
 * `auth.pkceParams`, and that is where VerifyMFA runs. It needs no session. Before
 * the change these tests cover:
 *
 *   - `increaseLoginAttempts` was called only on a failed ACCOUNT PASSWORD
 *     (pkceSignIn) and a failed recovery-code sign-in, never on a failed second
 *     factor — so a wrong TOTP, a wrong magic-link code, a wrong app password and
 *     a wrong trusted-device token all cost the attacker nothing;
 *   - with the counter frozen at zero, the progressive delay ramp in LoginLockGuard
 *     never started climbing, the hard lock was never reached, and
 *     ProofOfWorkGate's adaptive threshold — which reads those same lock counters —
 *     was never crossed;
 *   - and the guard was never consulted on this route at all (LockMiddleware is
 *     wired to /pkce_sign_in and /recovery/login only), so even a counter that did
 *     move would not have slowed this endpoint down.
 *
 * These tests use REAL instances of every one of those mechanisms —
 * IncreaseLoginAttempts, ClearLoginAttempts, LoginLockGuard, ProofOfWorkGate,
 * VerifyMFA, VerifyAppPassword, VerifyTrustedDevice, VerifyMagicLinkCode and a
 * LockRepository that reproduces the Redis one's two-tier semantics — so the
 * assertions are about the lock counter and about what the ramp and the
 * proof-of-work threshold then DO, not about whether a spy was called. A spy
 * assertion proves wiring; it cannot tell a working brake from a disconnected one.
 * (One wiring assertion is included as well, at the end.)
 */

const EMAIL = 'person@example.com'
const USER_UUID = '00000000-0000-0000-0000-000000000001'
const CORRECT_TOTP = '123456'
const WRONG_TOTP = '654321'
const MFA_SECRET = 'JBSWY3DPEHPK3PXP'

/** MAX_LOGIN_ATTEMPTS default (Container.ts). The ramp starts at this many. */
const MAX_LOGIN_ATTEMPTS = 6
/** LOCKOUT_PROGRESSIVE_DELAY_CAP_SECONDS, capped delay in seconds. */
const DELAY_CAP_SECONDS = 30
/** PROOF_OF_WORK_SIGNIN_ADAPTIVE_THRESHOLD default (Container.ts). */
const POW_ADAPTIVE_THRESHOLD = 3

const unused = (name: string): never => {
  throw new Error(`${name} is not exercised by this spec`)
}

/**
 * The lock counter, with the two-tier behaviour RedisLockRepository implements:
 * attempts land in the non-captcha tier until it reaches the maximum, then in the
 * captcha tier, and `isUserLocked` is true once the CAPTCHA tier has reached the
 * maximum. Both tiers are reset together.
 */
class InMemoryLockRepository implements LockRepositoryInterface {
  private readonly counters = new Map<string, number>()
  private readonly otpLocks = new Map<string, string>()

  constructor(private maxLoginAttempts: number) {}

  private key(identifier: string, mode: 'captcha' | 'non-captcha'): string {
    return `${mode}:${identifier}`
  }

  async resetLockCounter(userIdentifier: string): Promise<void> {
    this.counters.delete(this.key(userIdentifier, 'captcha'))
    this.counters.delete(this.key(userIdentifier, 'non-captcha'))
  }

  async updateLockCounter(userIdentifier: string, counter: number, mode: 'captcha' | 'non-captcha'): Promise<void> {
    this.counters.set(this.key(userIdentifier, mode), counter)
  }

  async getLockCounter(userIdentifier: string, mode: 'captcha' | 'non-captcha'): Promise<number> {
    return this.counters.get(this.key(userIdentifier, mode)) ?? 0
  }

  async isUserLocked(userIdentifier: string): Promise<boolean> {
    return (await this.getLockCounter(userIdentifier, 'captcha')) >= this.maxLoginAttempts
  }

  async lockSuccessfullOTP(userIdentifier: string, otp: string): Promise<void> {
    this.otpLocks.set(userIdentifier, otp)
  }

  async isOTPLocked(userIdentifier: string, otp: string): Promise<boolean> {
    return this.otpLocks.get(userIdentifier) === otp
  }

  /** Total attempts across both tiers — what the ramp and the PoW gate both read. */
  async totalAttempts(userIdentifier: string): Promise<number> {
    return (
      (await this.getLockCounter(userIdentifier, 'non-captcha')) +
      (await this.getLockCounter(userIdentifier, 'captcha'))
    )
  }
}

class StubUserRepository implements UserRepositoryInterface {
  constructor(private user: User | null) {}

  async findOneByUsernameOrEmail(usernameOrEmail: Email | Username): Promise<User | null> {
    return this.user !== null && this.user.email === usernameOrEmail.value ? this.user : null
  }

  async findOneByUuid(uuid: Uuid): Promise<User | null> {
    return this.user !== null && this.user.uuid === uuid.value ? this.user : null
  }

  async findUsersForAdmin(_query: AdminUserListQuery): Promise<AdminUserListResult> {
    return { rows: [], total: 0 }
  }

  async streamAll(): Promise<ReadStream> {
    return unused('streamAll')
  }
  async streamTeam(): Promise<ReadStream> {
    return unused('streamTeam')
  }
  async findAllByUsernameOrEmail(): Promise<User[]> {
    return unused('findAllByUsernameOrEmail')
  }
  async findOneByEmailAndWorkspaceIdentifier(): Promise<User | null> {
    return unused('findOneByEmailAndWorkspaceIdentifier')
  }
  async findAllCreatedBetween(): Promise<User[]> {
    return unused('findAllCreatedBetween')
  }
  async countAllCreatedBetween(): Promise<number> {
    return unused('countAllCreatedBetween')
  }
  async countAll(): Promise<number> {
    return unused('countAll')
  }
  async compareAndSwapCredentialsAndInvalidateAccountRecovery(): Promise<User | null> {
    return unused('compareAndSwapCredentialsAndInvalidateAccountRecovery')
  }
  async save(): Promise<User> {
    return unused('save')
  }
  async remove(): Promise<User> {
    return unused('remove')
  }
}

class StubSessionRepository implements SessionRepositoryInterface {
  /** No recorded sessions, so the trusted-source exemption never applies here. */
  async findAllByUserUuid(): Promise<Session[]> {
    return []
  }

  async findOneByUuid(): Promise<Session | null> {
    return unused('findOneByUuid')
  }
  async findOneByPrivateIdentifier(): Promise<Session | null> {
    return unused('findOneByPrivateIdentifier')
  }
  async findOneByUuidAndUserUuid(): Promise<Session | null> {
    return unused('findOneByUuidAndUserUuid')
  }
  async findAllByRefreshExpirationAndUserUuid(): Promise<Session[]> {
    return unused('findAllByRefreshExpirationAndUserUuid')
  }
  async deleteAllByUserUuidExceptOne(): Promise<void> {
    return unused('deleteAllByUserUuidExceptOne')
  }
  async deleteOneByUuid(): Promise<void> {
    return unused('deleteOneByUuid')
  }
  async insert(): Promise<void> {
    return unused('insert')
  }
  async update(): Promise<void> {
    return unused('update')
  }
  async remove(): Promise<Session> {
    return unused('remove')
  }
  async clearUserAgentByUserUuid(): Promise<void> {
    return unused('clearUserAgentByUserUuid')
  }
  async removeExpiredBefore(): Promise<void> {
    return unused('removeExpiredBefore')
  }
}

class InMemorySettingRepository implements SettingRepositoryInterface {
  private readonly settings: Setting[] = []

  add(setting: Setting): void {
    this.settings.push(setting)
  }

  async findLastByNameAndUserUuid(name: string, userUuid: string): Promise<Setting | null> {
    const matches = this.settings.filter(
      (setting) => setting.props.name === name && setting.props.userUuid.value === userUuid,
    )

    return matches.length === 0 ? null : matches[matches.length - 1]
  }

  async findOneByUuid(): Promise<Setting | null> {
    return unused('findOneByUuid')
  }
  async findOneByUuidAndNames(): Promise<Setting | null> {
    return unused('findOneByUuidAndNames')
  }
  async findOneByNameAndUserUuid(): Promise<Setting | null> {
    return unused('findOneByNameAndUserUuid')
  }
  async findAllByUserUuid(): Promise<Setting[]> {
    return unused('findAllByUserUuid')
  }
  async countAllByNameAndValue(): Promise<number> {
    return unused('countAllByNameAndValue')
  }
  async countAllByName(): Promise<number> {
    return unused('countAllByName')
  }
  async countAllByNameAndValueOwnedByRole(): Promise<number> {
    return unused('countAllByNameAndValueOwnedByRole')
  }
  async findAllByNameAndValue(): Promise<Setting[]> {
    return unused('findAllByNameAndValue')
  }
  async findAllByName(): Promise<Setting[]> {
    return unused('findAllByName')
  }
  async deleteByUserUuid(): Promise<void> {
    return unused('deleteByUserUuid')
  }
  async insert(): Promise<void> {
    return unused('insert')
  }
  async update(): Promise<void> {
    return unused('update')
  }
}

/** Settings are stored in the clear in this spec; encryption is not under test. */
class PlaintextSettingCrypter implements SettingCrypterInterface {
  async encryptValue(value: string | null): Promise<string | null> {
    return value
  }
  async decryptSettingValue(setting: Setting): Promise<string | null> {
    return setting.props.value
  }
  async decryptSubscriptionSettingValue(setting: SubscriptionSetting): Promise<string | null> {
    return setting.props.value
  }
}

class InMemoryMagicLinkTokenRepository implements MagicLinkTokenRepositoryInterface {
  private readonly tokens: MagicLinkToken[] = []

  add(token: MagicLinkToken): void {
    this.tokens.push(token)
  }

  async findLatestByUserIdentifier(userIdentifier: string): Promise<MagicLinkToken | null> {
    const matches = this.tokens.filter((token) => token.props.userIdentifier === userIdentifier)

    return matches.length === 0 ? null : matches[matches.length - 1]
  }

  async findByUserIdentifierAndCode(userIdentifier: string, code: string): Promise<MagicLinkToken | null> {
    return (
      this.tokens.find((token) => token.props.userIdentifier === userIdentifier && token.props.code === code) ?? null
    )
  }

  async save(magicLinkToken: MagicLinkToken): Promise<void> {
    if (!this.tokens.includes(magicLinkToken)) {
      this.tokens.push(magicLinkToken)
    }
  }
}

/** No registered authenticators, so VerifyMFA never takes the U2F branch here. */
class StubAuthenticatorRepository implements AuthenticatorRepositoryInterface {
  async findByUserUuid(): Promise<Authenticator[]> {
    return []
  }
  async findById(): Promise<Authenticator | null> {
    return unused('findById')
  }
  async findByUserUuidAndCredentialId(): Promise<Authenticator | null> {
    return unused('findByUserUuidAndCredentialId')
  }
  async save(): Promise<void> {
    return unused('save')
  }
  async updateCounter(): Promise<void> {
    return unused('updateCounter')
  }
  async remove(): Promise<void> {
    return unused('remove')
  }
  async removeByUserUuid(): Promise<void> {
    return unused('removeByUserUuid')
  }
}

class StubAuthenticatorChallengeRepository implements AuthenticatorChallengeRepositoryInterface {
  async findByUserUuid(): Promise<AuthenticatorChallenge | null> {
    return null
  }
  async save(): Promise<void> {
    return unused('save')
  }
}

/** No stored app passwords / trusted devices, so any presented one is rejected. */
class EmptyAppPasswordRepository implements AppPasswordRepositoryInterface {
  async findByUserUuid(): Promise<AppPassword[]> {
    return []
  }
  async findById(): Promise<AppPassword | null> {
    return unused('findById')
  }
  async save(): Promise<void> {
    return unused('save')
  }
  async updateLastUsedAt(): Promise<void> {
    return unused('updateLastUsedAt')
  }
  async remove(): Promise<void> {
    return unused('remove')
  }
  async removeByUserUuid(): Promise<void> {
    return unused('removeByUserUuid')
  }
}

class EmptyTrustedDeviceRepository implements TrustedDeviceRepositoryInterface {
  async findByUserUuid(): Promise<TrustedDevice[]> {
    return []
  }
  async findById(): Promise<TrustedDevice | null> {
    return unused('findById')
  }
  async save(): Promise<void> {
    return unused('save')
  }
  async remove(): Promise<void> {
    return unused('remove')
  }
  async removeByUserUuid(): Promise<void> {
    return unused('removeByUserUuid')
  }
}

class InMemoryProofOfWorkChallengeRepository implements ProofOfWorkChallengeRepositoryInterface {
  private readonly challenges = new Map<string, number>()

  async storeChallenge(seed: string, scope: string, difficulty: number): Promise<void> {
    this.challenges.set(`${scope}:${seed}`, difficulty)
  }

  async getChallengeDifficulty(seed: string, scope: string): Promise<number | null> {
    return this.challenges.get(`${scope}:${seed}`) ?? null
  }

  async consumeChallenge(seed: string, scope: string): Promise<boolean> {
    return this.challenges.delete(`${scope}:${seed}`)
  }
}

class StaticProofOfWorkConfigResolver implements ProofOfWorkConfigResolverInterface {
  constructor(private config: ProofOfWorkConfig) {}

  async resolve(): Promise<ProofOfWorkConfig> {
    return this.config
  }
}

const buildLogger = (): Logger =>
  ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as jest.Mocked<Logger>

const buildUser = (): User => {
  const user = new User()
  user.uuid = USER_UUID
  user.email = EMAIL
  user.roles = Promise.resolve([])

  return user
}

const mfaSecretSetting = (): Setting =>
  Setting.create({
    name: SettingName.NAMES.MfaSecret,
    value: MFA_SECRET,
    serverEncryptionVersion: EncryptionVersion.Default,
    userUuid: Uuid.create(USER_UUID).getValue(),
    sensitive: true,
    timestamps: Timestamps.create(1, 1).getValue(),
  }).getValue()

const magicLinkEnabledSetting = (): Setting =>
  Setting.create({
    name: SettingName.NAMES.MagicLinkEnabled,
    value: 'true',
    serverEncryptionVersion: EncryptionVersion.Default,
    userUuid: Uuid.create(USER_UUID).getValue(),
    sensitive: false,
    timestamps: Timestamps.create(1, 1).getValue(),
  }).getValue()

/**
 * A real ProofOfWorkGate over a given lock repository. `enabled` is the sign-in
 * scope's switch; the challenge store starts empty, so the real VerifyProofOfWork
 * rejects every submission as an unknown challenge and the gate issues a fresh one
 * — which is precisely the "challenge required" outcome the adaptive threshold is
 * supposed to produce once the counter crosses it.
 */
const buildProofOfWorkGate = (
  lockRepository: LockRepositoryInterface,
  userRepository: UserRepositoryInterface,
  logger: Logger,
  enabled: boolean,
): ProofOfWorkGate => {
  const challenges = new InMemoryProofOfWorkChallengeRepository()

  return new ProofOfWorkGate(
    new RequestProofOfWorkChallenge(challenges),
    new VerifyProofOfWork(challenges),
    new StaticProofOfWorkConfigResolver({
      register: { enabled: false, difficulty: 12, ttlSeconds: 600 },
      signIn: {
        enabled,
        difficulty: 16,
        ttlSeconds: 600,
        mode: 'adaptive',
        adaptiveThreshold: POW_ADAPTIVE_THRESHOLD,
      },
    }),
    lockRepository,
    userRepository,
    logger,
  )
}

type Harness = {
  controller: BaseAuthController
  lockRepository: InMemoryLockRepository
  /**
   * A second guard over the SAME lock counter, configured with the real
   * LOCKOUT_PROGRESSIVE_DELAY_CAP_SECONDS default so the ramp values can be
   * asserted. The guard the controller holds is built with a cap of 0 — the ramp
   * is applied by `sleepSeconds`, and a test that drove twelve failures through a
   * 30-second cap would spend over a minute asleep and blow the suite timeout.
   * `progressiveLockDelaySeconds` returns 0 for a cap of 0, so the controller's
   * guard still refuses a locked account; only the stalling is skipped.
   */
  rampGuard: LoginLockGuard
  increaseLoginAttempts: IncreaseLoginAttempts
  magicLinkTokens: InMemoryMagicLinkTokenRepository
  logger: Logger
}

const buildHarness = (
  options: { secondFactor: 'totp' | 'magic-link' | 'none' } = { secondFactor: 'totp' },
): Harness => {
  const logger = buildLogger()
  const user = buildUser()
  const userRepository = new StubUserRepository(user)
  const lockRepository = new InMemoryLockRepository(MAX_LOGIN_ATTEMPTS)

  const settingRepository = new InMemorySettingRepository()
  if (options.secondFactor === 'totp') {
    settingRepository.add(mfaSecretSetting())
  }
  if (options.secondFactor === 'magic-link') {
    settingRepository.add(magicLinkEnabledSetting())
  }

  const getSetting = new GetSetting(
    settingRepository,
    new PlaintextSettingCrypter(),
    new VerifyUserServerPassword(userRepository),
  )

  const magicLinkTokens = new InMemoryMagicLinkTokenRepository()
  const verifyMFA = new VerifyMFA(
    userRepository,
    new DeterministicSelector<boolean>(),
    lockRepository,
    'pseudo-key-params-key',
    new StubAuthenticatorRepository(),
    new VerifyAuthenticatorAuthenticationResponse(
      new StubAuthenticatorRepository(),
      new StubAuthenticatorChallengeRepository(),
      'localhost',
      ['http://localhost'],
      false,
    ),
    getSetting,
    new VerifyMagicLinkCode(magicLinkTokens, logger),
    logger,
  )

  const increaseLoginAttempts = new IncreaseLoginAttempts(userRepository, lockRepository, MAX_LOGIN_ATTEMPTS)
  const clearLoginAttempts = new ClearLoginAttempts(userRepository, lockRepository, logger)

  const loginLockGuard = new LoginLockGuard(
    userRepository,
    lockRepository,
    new StubSessionRepository(),
    MAX_LOGIN_ATTEMPTS,
    0,
    true,
    logger,
  )
  const rampGuard = new LoginLockGuard(
    userRepository,
    lockRepository,
    new StubSessionRepository(),
    MAX_LOGIN_ATTEMPTS,
    DELAY_CAP_SECONDS,
    true,
    logger,
  )

  // The sign-in gate in THIS harness is DISABLED, exactly as a stock deploy has it
  // (Container.ts requires PROOF_OF_WORK_SIGNIN_ENABLED === 'true', and the
  // variable appears in no compose file, .env.sample or setup script), so the
  // controller tests below cannot be quietly protected by proof-of-work. The
  // adaptive threshold is exercised separately, through its own enabled gate.
  const proofOfWorkGate = buildProofOfWorkGate(lockRepository, userRepository, logger, false)

  const verifyAppPassword = new VerifyAppPassword(new EmptyAppPasswordRepository(), userRepository)
  const verifyTrustedDevice = new VerifyTrustedDevice(new EmptyTrustedDeviceRepository(), userRepository)

  /**
   * `getUserKeyParams` only shapes the 200 body on the success path, and
   * `createPendingMfaApproval` is a best-effort push already wrapped in the
   * controller's own try/catch. Neither is the mechanism under test and nothing
   * ever asks either for an `instanceof`, so these two are the only stand-ins
   * here; every brake, counter, verifier and repository above is a real instance.
   */
  const getUserKeyParams = {
    execute: jest.fn().mockResolvedValue({ keyParams: { identifier: EMAIL, version: '004' } }),
  } as unknown as GetUserKeyParams
  const createPendingMfaApproval = {
    execute: jest.fn().mockResolvedValue(Result.fail('no push in this spec')),
  } as never

  const signInUseCase = {
    execute: jest.fn().mockResolvedValue({ success: true, result: { legacyResponse: { ok: true } } }),
  } as unknown as SignIn

  const controller = new BaseAuthController(
    verifyMFA,
    signInUseCase,
    getUserKeyParams,
    clearLoginAttempts,
    increaseLoginAttempts,
    logger,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    '',
    verifyAppPassword,
    verifyTrustedDevice,
    createPendingMfaApproval,
    userRepository,
    proofOfWorkGate,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    loginLockGuard,
  )

  return {
    controller,
    lockRepository,
    rampGuard,
    increaseLoginAttempts,
    magicLinkTokens,
    logger,
  }
}

const paramsRequest = (body: Record<string, unknown> = {}): Request =>
  ({
    body: { email: EMAIL, code_challenge: 'a-code-challenge', ...body },
    headers: {},
    path: '/pkce_params',
    originalUrl: '/auth/pkce_params',
  }) as unknown as Request

const signInRequest = (): Request =>
  ({
    body: {
      email: EMAIL,
      password: 'the-correct-password',
      code_verifier: 'a-verifier-long-enough-to-pass-the-presence-check',
      api: '20200115',
    },
    headers: {},
    path: '/pkce_sign_in',
    originalUrl: '/auth/pkce_sign_in',
  }) as unknown as Request

const buildResponse = (): Response => ({ locals: {}, setHeader: jest.fn() }) as unknown as Response

describe('BaseAuthController second-factor lockout (the MFA gate)', () => {
  describe('a rejected second factor is counted', () => {
    /**
     * THE DEFECT, DEMONSTRATED. Three wrong TOTPs used to leave the lock counter at
     * zero, so the MFA gate was a credential check with no memory of being wrong.
     * This asserts the counter the ramp and the proof-of-work gate actually read.
     */
    it('increments the lock counter once per wrong TOTP', async () => {
      const { controller, lockRepository } = buildHarness()

      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(0)

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())

        expect(result.statusCode).toEqual(401)
        expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(attempt)
      }
    })

    it('increments the lock counter for a wrong magic-link code', async () => {
      const { controller, lockRepository, magicLinkTokens } = buildHarness({ secondFactor: 'magic-link' })

      magicLinkTokens.add(
        MagicLinkToken.create(
          {
            userIdentifier: EMAIL,
            code: '111111',
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            consumed: false,
            createdAt: new Date(),
          },
          new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
        ).getValue(),
      )

      const result = await controller.pkceParams(paramsRequest({ magic_link_code: '222222' }), buildResponse())

      expect(result.statusCode).toEqual(401)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(1)
    })

    it('increments the lock counter for a rejected app password', async () => {
      const { controller, lockRepository } = buildHarness()

      const result = await controller.pkceParams(
        paramsRequest({ app_password: 'not-an-app-password' }),
        buildResponse(),
      )

      expect(result.statusCode).toEqual(401)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(1)
    })

    it('increments the lock counter for a rejected trusted-device token', async () => {
      const { controller, lockRepository } = buildHarness()

      const result = await controller.pkceParams(
        paramsRequest({ trusted_device_token: 'not-a-device-token' }),
        buildResponse(),
      )

      expect(result.statusCode).toEqual(401)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(1)
    })

    /**
     * THE LINE THIS FIX MUST NOT CROSS. A request that presents no second factor at
     * all gets the "please enter your code" challenge — that is the first round trip
     * of every legitimate sign-in on a 2FA account, and it carries no guess. If it
     * counted, every 2FA sign-in would spend lockout budget and any stranger who
     * knows an email address could lock the account out with empty requests. The
     * volumetric side of that probing belongs to the gateway bucket, not here.
     */
    it('does not count a challenge-required response that presented nothing', async () => {
      const { controller, lockRepository } = buildHarness()

      const result = await controller.pkceParams(paramsRequest(), buildResponse())

      expect(result.statusCode).toEqual(401)
      expect((result.json as { error: { tag: string } }).error.tag).toEqual(ErrorTag.MfaRequired)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(0)
    })

    it('does not count a correct TOTP', async () => {
      const { controller, lockRepository } = buildHarness()

      const result = await controller.pkceParams(paramsRequest({ mfa_1: CORRECT_TOTP }), buildResponse())

      expect(result.statusCode).toEqual(200)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(0)
    })

    it('does not count anything for an account with no second factor configured', async () => {
      const { controller, lockRepository } = buildHarness({ secondFactor: 'none' })

      const result = await controller.pkceParams(paramsRequest(), buildResponse())

      expect(result.statusCode).toEqual(200)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(0)
    })
  })

  /**
   * The counter is only worth incrementing if something reads it. These two tests
   * drive the REAL ramp and the REAL proof-of-work gate off the counter the
   * controller just wrote, so a fix that increments a counter nothing consults
   * cannot pass them.
   */
  describe('what the counter then drives', () => {
    it('makes the progressive delay ramp climb, and eventually locks', async () => {
      const { controller, lockRepository, rampGuard } = buildHarness()

      const decisionBefore = await rampGuard.evaluate({ identifier: EMAIL, isRecoveryRoute: false })
      expect(decisionBefore.attempts).toEqual(0)
      expect(decisionBefore.delaySeconds).toEqual(0)
      expect(decisionBefore.allowed).toBe(true)

      for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
        await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      }

      // Six failures: the ramp is live (2^0 = 1s at the threshold) but the account
      // is not locked yet, so a person who really did mistype six times still gets in.
      const decisionAtThreshold = await rampGuard.evaluate({ identifier: EMAIL, isRecoveryRoute: false })
      expect(decisionAtThreshold.attempts).toEqual(MAX_LOGIN_ATTEMPTS)
      expect(decisionAtThreshold.delaySeconds).toEqual(1)
      expect(decisionAtThreshold.allowed).toBe(true)

      for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
        await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      }

      // Twelve failures: the captcha tier has reached the maximum, so the account is
      // locked and the guard refuses — 10^6 guesses can no longer be walked through.
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(MAX_LOGIN_ATTEMPTS * 2)
      const decisionAtLock = await rampGuard.evaluate({ identifier: EMAIL, isRecoveryRoute: false })
      expect(decisionAtLock.allowed).toBe(false)
      expect(decisionAtLock.delaySeconds).toEqual(DELAY_CAP_SECONDS)
    })

    it('crosses the adaptive proof-of-work threshold', async () => {
      const { controller, lockRepository } = buildHarness()

      // A gate configured the way an operator who turns sign-in PoW on gets it:
      // enabled, adaptive, default threshold. It shares the lock repository with the
      // controller, which is the whole point — the threshold reads those counters.
      const adaptiveGate = buildProofOfWorkGate(
        lockRepository,
        new StubUserRepository(buildUser()),
        buildLogger(),
        true,
      )

      expect(await adaptiveGate.enforceSignInParams(EMAIL, {}, false)).toEqual({ satisfied: true })

      for (let attempt = 0; attempt < POW_ADAPTIVE_THRESHOLD - 1; attempt++) {
        await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      }
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(POW_ADAPTIVE_THRESHOLD - 1)
      expect(await adaptiveGate.enforceSignInParams(EMAIL, {}, false)).toEqual({ satisfied: true })

      await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())

      const afterThreshold = await adaptiveGate.enforceSignInParams(EMAIL, {}, false)
      expect(afterThreshold.satisfied).toBe(false)
      expect(afterThreshold.satisfied === false ? afterThreshold.challenge.difficulty : 0).toEqual(16)
    })

    /**
     * And the gate itself now refuses. Counting without consulting the guard here
     * would have left the counter climbing while /login-params still answered at
     * full speed — LockMiddleware is wired to /pkce_sign_in and /recovery/login
     * only, so nothing else was going to apply it to this route.
     */
    it('refuses the MFA gate with 423 once the account is locked', async () => {
      const { controller, lockRepository } = buildHarness()

      for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS * 2; attempt++) {
        await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      }

      const result = await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())

      expect(result.statusCode).toEqual(423)
      // Refused before the credential check, so the refusal costs the counter nothing.
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(MAX_LOGIN_ATTEMPTS * 2)
    })

    /**
     * An ALREADY-AUTHENTICATED key-params fetch (credential change, key rotation)
     * presents no second factor and must not be held behind an attacker-driven
     * counter. This is why the guard is evaluated after the session branch, and why
     * it is not attached to the route as middleware.
     */
    it('still serves an authenticated key-params fetch while the account is locked', async () => {
      const { controller } = buildHarness()

      for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS * 2; attempt++) {
        await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      }

      const authenticated = {
        locals: { session: { uuid: 'a-session' }, user: { email: EMAIL } },
        setHeader: jest.fn(),
      } as unknown as Response

      const result = await controller.pkceParams(paramsRequest(), authenticated)

      expect(result.statusCode).toEqual(200)
    })
  })

  describe('the success path clears what the failures accumulated', () => {
    /**
     * A user who mistypes a code twice and then signs in must not be left two steps
     * from lockout. The precondition asserts the counter is NON-ZERO first, so this
     * cannot pass vacuously against a counter that never moved.
     */
    it('clears the counter on a completed sign-in', async () => {
      const { controller, lockRepository } = buildHarness()

      await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())

      // PRECONDITION: there is really something to clear.
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(2)
      expect(await lockRepository.totalAttempts(EMAIL)).toEqual(0)

      const signInResult = await controller.pkceSignIn(signInRequest(), buildResponse())

      expect(signInResult.statusCode).toEqual(200)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(0)
    })

    /**
     * And a satisfied second factor on its own does NOT clear it. /login-params
     * verifies no account password, so clearing here would let a holder of the
     * second factor alone reset the PASSWORD lockout counter at will and brute-force
     * the password indefinitely, alternating a guess against /pkce_sign_in with a
     * reset against /login-params.
     */
    it('does not clear the counter on a successful second factor alone', async () => {
      const { controller, lockRepository } = buildHarness()

      await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(2)

      const result = await controller.pkceParams(paramsRequest({ mfa_1: CORRECT_TOTP }), buildResponse())

      expect(result.statusCode).toEqual(200)
      expect(await lockRepository.totalAttempts(USER_UUID)).toEqual(2)
    })
  })

  describe('wiring', () => {
    /**
     * The spy-level assertion, kept alongside the behavioural ones rather than
     * instead of them. `skipUsernameValidation` matters: IncreaseLoginAttempts and
     * ClearLoginAttempts must resolve an identifier the SAME way, or a legacy
     * username accumulates failures that a successful sign-in never clears.
     */
    it('counts through IncreaseLoginAttempts with the same identifier resolution as the password path', async () => {
      const { controller, increaseLoginAttempts } = buildHarness()
      const execute = jest.spyOn(increaseLoginAttempts, 'execute')

      await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())

      expect(execute).toHaveBeenCalledWith({ email: EMAIL, skipUsernameValidation: true })
    })

    it('survives a counter failure without turning the 401 into a 500', async () => {
      const { controller, increaseLoginAttempts, logger } = buildHarness()
      jest.spyOn(increaseLoginAttempts, 'execute').mockResolvedValue(Result.fail('lock store unavailable'))

      const result = await controller.pkceParams(paramsRequest({ mfa_1: WRONG_TOTP }), buildResponse())

      expect(result.statusCode).toEqual(401)
      expect(logger.error).toHaveBeenCalled()
    })
  })
})
