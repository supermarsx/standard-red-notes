import 'reflect-metadata'
import { Username } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { LockRepositoryInterface } from '../User/LockRepositoryInterface'

import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { ClearLoginAttempts } from './ClearLoginAttempts'

describe('ClearLoginAttempts', () => {
  let userRepository: UserRepositoryInterface
  let lockRepository: LockRepositoryInterface
  let user: User
  let logger: Logger

  const createUseCase = () => new ClearLoginAttempts(userRepository, lockRepository, logger)

  beforeEach(() => {
    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()

    user = {} as jest.Mocked<User>
    user.uuid = '234'

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(user)

    lockRepository = {} as jest.Mocked<LockRepositoryInterface>
    lockRepository.resetLockCounter = jest.fn()
  })

  it('should do nothing if a user identifier is invalid', async () => {
    const result = await createUseCase().execute({ email: '   ' })

    expect(result.isFailed()).toEqual(true)

    expect(lockRepository.resetLockCounter).toHaveBeenCalledTimes(0)
  })

  it('should unlock an user by email and uuid', async () => {
    const result = await createUseCase().execute({ email: 'test@test.te' })
    expect(result.isFailed()).toEqual(false)

    expect(lockRepository.resetLockCounter).toHaveBeenCalledTimes(2)
    expect(lockRepository.resetLockCounter).toHaveBeenNthCalledWith(1, 'test@test.te')
    expect(lockRepository.resetLockCounter).toHaveBeenNthCalledWith(2, '234')
  })

  it('should unlock an user by email and uuid if user does not exist', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(null)

    const result = await createUseCase().execute({ email: 'test@test.te' })
    expect(result.isFailed()).toEqual(false)

    expect(lockRepository.resetLockCounter).toHaveBeenCalledTimes(1)
    expect(lockRepository.resetLockCounter).toHaveBeenCalledWith('test@test.te')
  })

  /**
   * Standard Red Notes: REGRESSION GUARD for the lockout ratchet.
   *
   * ClearLoginAttempts resolves the identifier with `{ skipValidation: true }`,
   * exactly as SignIn and IncreaseLoginAttempts do. Drop that option and every
   * identifier below returns Result.fail BEFORE resetLockCounter runs, so a
   * successful sign-in never clears the counter and the account ratchets towards
   * a lockout it can never escape. These are real legacy shapes the 2025 username
   * rules reject.
   */
  describe('legacy identifiers the 2025 username rules reject', () => {
    const legacyIdentifiers = [
      ['consecutive special characters', 'john..doe@example.com'],
      ['a leading special character', '.legacy@example.com'],
      ['a trailing special character', 'legacy-@example.com'],
      ['non-ASCII characters', 'josé@example.com'],
      ['fewer than three characters', 'ab'],
    ] as const

    it.each(legacyIdentifiers)('should clear both counters for an identifier with %s', async (_label, email) => {
      const result = await createUseCase().execute({ email })

      expect(result.isFailed()).toEqual(false)
      expect(lockRepository.resetLockCounter).toHaveBeenNthCalledWith(1, email)
      expect(lockRepository.resetLockCounter).toHaveBeenNthCalledWith(2, '234')
    })

    /**
     * The invariant behind the fix, stated directly: the clear side must accept
     * every identifier the increment side accepts. IncreaseLoginAttempts is
     * called with `skipUsernameValidation: true` from BaseAuthController, so its
     * acceptance set is "any non-empty string". If clearing ever accepts less
     * than incrementing, the counter is no longer a count of CONSECUTIVE
     * failures and the account drifts into a permanent lock.
     */
    it('should accept every identifier the increment side accepts', async () => {
      const incrementSideAccepts = (email: string) => !Username.create(email, { skipValidation: true }).isFailed()

      for (const [, email] of legacyIdentifiers) {
        expect(incrementSideAccepts(email)).toEqual(true)

        const result = await createUseCase().execute({ email })

        expect(result.isFailed()).toEqual(false)
      }
    })
  })

  it('should still reject a whitespace-only identifier, which skipValidation does not permit', async () => {
    const result = await createUseCase().execute({ email: '   ' })

    expect(result.isFailed()).toEqual(true)
    expect(lockRepository.resetLockCounter).toHaveBeenCalledTimes(0)
  })
})
