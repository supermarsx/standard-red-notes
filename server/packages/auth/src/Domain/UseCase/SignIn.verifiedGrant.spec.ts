import 'reflect-metadata'
import { createHash } from 'crypto'
import { CacheEntry, CacheEntryRepositoryInterface, SettingName } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'
import { SignIn } from './SignIn'
import { User } from '../User/User'
import { LoginGrantScope } from '../User/LoginGrantScope'
import { TypeORMPKCERepository } from '../../Infra/TypeORM/TypeORMPKCERepository'
import { SettingRepositoryInterface } from '../Setting/SettingRepositoryInterface'
import { AuthenticatorRepositoryInterface } from '../Authenticator/AuthenticatorRepositoryInterface'
import { Setting } from '../Setting/Setting'
jest.mock('bcryptjs', () => ({ compare: jest.fn(async () => true) }))

describe('SignIn verified grant before session issuance', () => {
  const verifier = 'local-fixture-verifier',
    challenge = createHash('sha256').update(verifier).digest('base64url')
  const user = {
    uuid: '11111111-1111-4111-8111-111111111111',
    email: 'local@example.test',
    workspaceIdentifier: 'default',
    encryptedPassword: 'password-hash',
    isAccessBlocked: () => false,
  } as User
  let factor: string | null
  let rows: CacheEntry[]
  let now: number
  const settings = {
    findLastByNameAndUserUuid: async (name: string) =>
      name === SettingName.NAMES.MfaSecret && factor ? ({ props: { value: factor } } as Setting) : null,
  } as SettingRepositoryInterface
  const authenticators = { findByUserUuid: async () => [] } as unknown as AuthenticatorRepositoryInterface
  const cache = {
    save: async (entry: CacheEntry) => {
      rows.push(entry)
    },
    consumeUnexpiredByKey: async (key: string) => {
      const removed = rows.filter((row) => row.props.key === key && row.props.expiresAt!.getTime() > now)
      rows = rows.filter((row) => !removed.includes(row))
      return removed.length > 0
    },
  } as unknown as CacheEntryRepositoryInterface
  const logger = { debug: jest.fn(), error: jest.fn() } as unknown as Logger
  const timer = { getUTCDateNSecondsAhead: (seconds: number) => new Date(now + seconds * 1000) } as TimerInterface
  const repository = new TypeORMPKCERepository(cache, logger, timer, new LoginGrantScope(settings, authenticators))
  const createResponse = jest.fn(async () => ({ legacyResponse: { ok: true } }))
  const build = () =>
    new SignIn(
      { findOneByUsernameOrEmail: async () => user } as never,
      { resolveAuthResponseFactoryVersion: () => ({ createResponse }) } as never,
      { publish: jest.fn() } as never,
      { createEmailRequestedEvent: jest.fn() } as never,
      { getOperatingSystemInfoFromUserAgent: () => '', getBrowserInfoFromUserAgent: () => '' } as never,
      repository,
      {
        sha256Hash: (value: string) => createHash('sha256').update(value).digest(),
        base64URLEncode: (value: Buffer) => value.toString('base64url'),
      } as never,
      logger,
      6,
      { getLockCounter: async () => 0 } as never,
      {} as never,
    )
  const dto = {
    email: user.email,
    password: 'local-password',
    userAgent: 'unit-test',
    apiVersion: '20200115',
    ephemeralSession: false,
    codeVerifier: verifier,
  }
  beforeEach(() => {
    factor = null
    rows = []
    now = Date.now()
    createResponse.mockClear()
  })
  it('refuses an enabled TOTP account without a verified matching grant', async () => {
    factor = 'encrypted-totp'
    expect((await build().execute(dto)).success).toBe(false)
    expect(createResponse).not.toHaveBeenCalled()
  })
  it('refuses a grant from another account or workspace', async () => {
    for (const subject of [
      { ...user, uuid: '22222222-2222-4222-8222-222222222222' },
      { ...user, workspaceIdentifier: 'other' },
    ]) {
      await repository.storeCodeChallenge(
        challenge,
        subject as User,
        'login',
        await repository.captureGrantScope(subject as User, 'login'),
      )
      expect((await build().execute(dto)).success).toBe(false)
    }
    expect(createResponse).not.toHaveBeenCalled()
  })
  it('refuses an older grant after TOTP was enabled and refuses recovery grants on password login', async () => {
    await repository.storeCodeChallenge(challenge, user, 'login', await repository.captureGrantScope(user, 'login'))
    factor = 'encrypted-totp'
    expect((await build().execute(dto)).success).toBe(false)
    await repository.storeCodeChallenge(
      challenge,
      user,
      'recovery',
      await repository.captureGrantScope(user, 'recovery'),
    )
    expect((await build().execute(dto)).success).toBe(false)
    expect(createResponse).not.toHaveBeenCalled()
  })
  it('accepts a verified current grant exactly once, including a TOTP account', async () => {
    factor = 'encrypted-totp'
    await repository.storeCodeChallenge(challenge, user, 'login', await repository.captureGrantScope(user, 'login'))
    expect((await build().execute(dto)).success).toBe(true)
    expect((await build().execute(dto)).success).toBe(false)
    expect(createResponse).toHaveBeenCalledTimes(1)
  })
  it('keeps ordinary non-TOTP login working and rejects expired grants', async () => {
    await repository.storeCodeChallenge(challenge, user, 'login', await repository.captureGrantScope(user, 'login'))
    expect((await build().execute(dto)).success).toBe(true)
    await repository.storeCodeChallenge(challenge, user, 'login', await repository.captureGrantScope(user, 'login'))
    now += 3601000
    expect((await build().execute(dto)).success).toBe(false)
    expect(createResponse).toHaveBeenCalledTimes(1)
  })
  it('allows only one concurrent consume before any session is created', async () => {
    await repository.storeCodeChallenge(challenge, user, 'login', await repository.captureGrantScope(user, 'login'))
    const results = await Promise.all([build().execute(dto), build().execute(dto)])
    expect(results.filter((result) => result.success)).toHaveLength(1)
    expect(createResponse).toHaveBeenCalledTimes(1)
  })
  it('cannot issue a grant when the factor policy changes while the factor is being verified', async () => {
    const verifiedPolicy = await repository.captureGrantScope(user, 'login')
    factor = 'new-encrypted-totp'
    await expect(repository.storeCodeChallenge(challenge, user, 'login', verifiedPolicy)).rejects.toThrow(
      'Login factor policy changed during verification',
    )
    expect((await build().execute(dto)).success).toBe(false)
    expect(createResponse).not.toHaveBeenCalled()
  })
})
