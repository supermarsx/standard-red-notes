import 'reflect-metadata'

import { Logger } from 'winston'

import { VerifyMagicLinkCode } from './VerifyMagicLinkCode'
import { GenerateMagicLinkCode } from '../GenerateMagicLinkCode/GenerateMagicLinkCode'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { MagicLinkToken } from '../../MagicLink/MagicLinkToken'
import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'

describe('VerifyMagicLinkCode', () => {
  let magicLinkTokenRepository: jest.Mocked<MagicLinkTokenRepositoryInterface>
  let logger: jest.Mocked<Logger>

  const createUseCase = () => new VerifyMagicLinkCode(magicLinkTokenRepository, logger)

  const createToken = (
    overrides: Partial<{ code: string; consumed: boolean; expiresAt: Date; failedAttempts: number }> = {},
  ) =>
    MagicLinkToken.create({
      userIdentifier: 'test@test.te',
      code: overrides.code ?? '123456',
      consumed: overrides.consumed ?? false,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 1000),
      failedAttempts: overrides.failedAttempts ?? 0,
      createdAt: new Date(),
    }).getValue()

  beforeEach(() => {
    magicLinkTokenRepository = {
      save: jest.fn(),
      findLatestByUserIdentifier: jest.fn(),
      findByUserIdentifierAndCode: jest.fn(),
    }

    logger = {
      debug: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('should fail if parameters are missing', async () => {
    const result = await createUseCase().execute({ userIdentifier: '', code: '' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if no token was issued', async () => {
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(null)
    magicLinkTokenRepository.findLatestByUserIdentifier.mockResolvedValue(null)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '123456' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('No magic link code was issued for this account.')
  })

  it('should fail if the token is already consumed', async () => {
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(createToken({ consumed: true }))

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '123456' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('This magic link code has already been used.')
  })

  it('should fail if the token is expired', async () => {
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(
      createToken({ expiresAt: new Date(Date.now() - 1000) }),
    )

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '123456' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('This magic link code has expired.')
  })

  it('should fail if the code does not match', async () => {
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(null)
    magicLinkTokenRepository.findLatestByUserIdentifier.mockResolvedValue(createToken({ code: '999999' }))

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '123456' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('The magic link code you entered is incorrect.')
  })

  it('should succeed and mark the token consumed when the code is valid', async () => {
    const token = createToken({ code: '123456' })
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(token)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '123456' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
    expect(token.props.consumed).toBe(true)
    expect(magicLinkTokenRepository.save).toHaveBeenCalledWith(token)
    // A correct code spends none of the per-code attempt budget.
    expect(token.props.failedAttempts).toBe(0)
  })

  it('selects the delivered code when same-second concurrent issuance makes latest-token order ambiguous', async () => {
    const sameCreatedAt = new Date('2026-08-13T12:00:00.000Z')
    const queueSurvivor = MagicLinkToken.create({
      userIdentifier: 'test@test.te',
      code: '111111',
      consumed: false,
      expiresAt: new Date('2026-08-13T12:15:00.000Z'),
      failedAttempts: 0,
      createdAt: sameCreatedAt,
    }).getValue()
    const ambiguouslyLatest = MagicLinkToken.create({
      userIdentifier: 'test@test.te',
      code: '222222',
      consumed: false,
      expiresAt: new Date('2026-08-13T12:15:00.000Z'),
      failedAttempts: 0,
      createdAt: sameCreatedAt,
    }).getValue()
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockImplementation(async (_identifier, code) => {
      return code === queueSurvivor.props.code ? queueSurvivor : null
    })
    magicLinkTokenRepository.findLatestByUserIdentifier.mockResolvedValue(ambiguouslyLatest)

    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T12:01:00.000Z'))
    try {
      const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '111111' })

      expect(result.getValue()).toBe(true)
      expect(queueSurvivor.props.consumed).toBe(true)
      expect(ambiguouslyLatest.props.consumed).toBe(false)
      expect(magicLinkTokenRepository.findByUserIdentifierAndCode).toHaveBeenCalledWith('test@test.te', '111111')
      expect(magicLinkTokenRepository.findLatestByUserIdentifier).not.toHaveBeenCalled()
      expect(magicLinkTokenRepository.save).toHaveBeenCalledWith(queueSurvivor)
    } finally {
      jest.useRealTimers()
    }
  })

  it('should fail gracefully if the repository throws', async () => {
    magicLinkTokenRepository.findByUserIdentifierAndCode.mockRejectedValue(new Error('db down'))

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: '123456' })

    expect(result.isFailed()).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })

  /**
   * Standard Red Notes: THE PER-CODE ATTEMPT CAP.
   *
   * A magic-link code is SIX NUMERIC DIGITS and stays valid for fifteen minutes.
   * Before this, a wrong guess left the token completely untouched: the code the
   * attacker had not found yet was still there, still unconsumed, still good for
   * the rest of its fifteen minutes, and the next guess cost exactly as little as
   * the last. The only brakes were the account-wide lockout counter and the
   * per-address gateway bucket, and BOTH ARE SHARED, which is the actual defect:
   *
   *   - an attacker who has already spent the account's lockout budget guessing
   *     TOTP has spent the magic-link budget too, and vice versa; and
   *   - spending that shared budget is itself a denial of service against the
   *     legitimate owner of the account.
   *
   * A per-TOKEN counter has neither property. A wrong guess costs THE CODE, not
   * the account: five wrong guesses kill that one code and nothing else, and the
   * owner simply asks for another. The guess budget against any issued code is
   * therefore 5 out of 10^6, and no amount of guessing can lock the owner out of
   * anything they cannot immediately undo with one more email.
   */
  describe('per-code attempt cap', () => {
    const EXHAUSTED =
      'Too many incorrect attempts have been made against this verification code. Please request a new one.'
    const WRONG = '000000'
    const RIGHT = '123456'

    it('charges a wrong guess to the live code, and the cap kills the code', async () => {
      const token = createToken({ code: RIGHT })

      // Preconditions, so the test cannot pass vacuously: a REAL token is on the
      // account, it is live (unconsumed, unexpired), its counter starts at zero,
      // and the cap is the small number this is all about.
      expect(token.props.consumed).toBe(false)
      expect(token.isExpired(new Date())).toBe(false)
      expect(token.props.failedAttempts).toBe(0)
      expect(token.hasExhaustedAttempts()).toBe(false)
      expect(MagicLinkToken.MAX_FAILED_ATTEMPTS).toBe(5)

      // The guessed code resolves to no token at all, so this is genuinely the
      // wrong-guess path and not the success path.
      magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(null)
      magicLinkTokenRepository.findLatestByUserIdentifier.mockResolvedValue(token)

      const useCase = createUseCase()
      for (let attempt = 1; attempt < MagicLinkToken.MAX_FAILED_ATTEMPTS; attempt++) {
        const result = await useCase.execute({ userIdentifier: 'test@test.te', code: WRONG })

        expect(result.isFailed()).toBe(true)
        expect(result.getError()).toEqual('The magic link code you entered is incorrect.')
        // The counter really moved, and it was really written back.
        expect(token.props.failedAttempts).toBe(attempt)
        expect(magicLinkTokenRepository.save).toHaveBeenCalledTimes(attempt)
        expect(magicLinkTokenRepository.save).toHaveBeenLastCalledWith(token)
      }

      const atTheCap = await useCase.execute({ userIdentifier: 'test@test.te', code: WRONG })

      expect(atTheCap.isFailed()).toBe(true)
      expect(atTheCap.getError()).toEqual(EXHAUSTED)
      expect(token.props.failedAttempts).toBe(MagicLinkToken.MAX_FAILED_ATTEMPTS)
      expect(token.hasExhaustedAttempts()).toBe(true)
      expect(magicLinkTokenRepository.save).toHaveBeenCalledTimes(MagicLinkToken.MAX_FAILED_ATTEMPTS)
      expect(magicLinkTokenRepository.save).toHaveBeenLastCalledWith(token)
    })

    it('refuses the CORRECT code once the cap is spent, and still does not consume it', async () => {
      const token = createToken({ code: RIGHT, failedAttempts: MagicLinkToken.MAX_FAILED_ATTEMPTS })

      // Preconditions: nothing but the attempt counter is wrong with this token.
      // Unconsumed, unexpired, and the code presented is the RIGHT one — so a pass
      // here can only come from the cap.
      expect(token.props.consumed).toBe(false)
      expect(token.isExpired(new Date())).toBe(false)
      expect(token.hasExhaustedAttempts()).toBe(true)

      magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(token)

      const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: RIGHT })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual(EXHAUSTED)
      expect(token.props.consumed).toBe(false)
      expect(magicLinkTokenRepository.save).not.toHaveBeenCalled()
      // It really was the matched-by-code branch, not the fallback.
      expect(magicLinkTokenRepository.findByUserIdentifierAndCode).toHaveBeenCalledWith('test@test.te', RIGHT)
      expect(magicLinkTokenRepository.findLatestByUserIdentifier).not.toHaveBeenCalled()
    })

    it('stops charging an exhausted code, so it cannot be used as a free write', async () => {
      const token = createToken({ code: RIGHT, failedAttempts: MagicLinkToken.MAX_FAILED_ATTEMPTS })
      magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(null)
      magicLinkTokenRepository.findLatestByUserIdentifier.mockResolvedValue(token)

      const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: WRONG })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual(EXHAUSTED)
      expect(token.props.failedAttempts).toBe(MagicLinkToken.MAX_FAILED_ATTEMPTS)
      expect(magicLinkTokenRepository.save).not.toHaveBeenCalled()
    })

    it.each([
      ['consumed', { consumed: true }],
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ])('does not charge an already-dead (%s) code', async (_label, overrides) => {
      const token = createToken({ code: RIGHT, ...overrides })
      magicLinkTokenRepository.findByUserIdentifierAndCode.mockResolvedValue(null)
      magicLinkTokenRepository.findLatestByUserIdentifier.mockResolvedValue(token)

      const result = await createUseCase().execute({ userIdentifier: 'test@test.te', code: WRONG })

      expect(result.isFailed()).toBe(true)
      expect(token.props.failedAttempts).toBe(0)
      expect(magicLinkTokenRepository.save).not.toHaveBeenCalled()
    })

    /**
     * The whole point of charging the CODE instead of the ACCOUNT: the owner is
     * one email away from a working sign-in, however many guesses were burned.
     * Driven end to end through the real GenerateMagicLinkCode so it also pins
     * that a freshly issued token starts its counter at zero — if generation
     * forgot that, every new code would be born exhausted and this fix would be a
     * permanent lockout instead of a brake.
     */
    it('lets the owner verify a FRESHLY REQUESTED code after one was exhausted', async () => {
      const tokens: MagicLinkToken[] = []
      const repository: MagicLinkTokenRepositoryInterface = {
        save: async (token: MagicLinkToken): Promise<void> => {
          if (!tokens.includes(token)) {
            tokens.push(token)
          }
        },
        findLatestByUserIdentifier: async (userIdentifier: string): Promise<MagicLinkToken | null> => {
          const matches = tokens.filter((token) => token.props.userIdentifier === userIdentifier)

          return matches.length === 0 ? null : (matches[matches.length - 1] as MagicLinkToken)
        },
        // Reverse scan, mirroring the real repository's ORDER BY created_at DESC:
        // the newest row wins, so a (1-in-10^6) repeated code is deterministic.
        findByUserIdentifierAndCode: async (userIdentifier: string, code: string): Promise<MagicLinkToken | null> => {
          for (let index = tokens.length - 1; index >= 0; index--) {
            const token = tokens[index] as MagicLinkToken
            if (token.props.userIdentifier === userIdentifier && token.props.code === code) {
              return token
            }
          }

          return null
        },
      }
      const emailSender = {
        acceptanceMode: 'provider' as const,
        isConfigured: jest.fn().mockReturnValue(true),
        sendEmail: jest.fn().mockResolvedValue(true),
      } as unknown as jest.Mocked<EmailSenderInterface>
      const generate = new GenerateMagicLinkCode(repository, emailSender, logger)
      const verify = new VerifyMagicLinkCode(repository, logger)

      const firstIssue = await generate.execute({ userIdentifier: 'test@test.te' })
      expect(firstIssue.isFailed()).toBe(false)
      expect(tokens).toHaveLength(1)
      const firstToken = tokens[0] as MagicLinkToken
      const firstCode = firstToken.props.code
      expect(firstCode).toMatch(/^\d{6}$/)
      expect(firstToken.props.failedAttempts).toBe(0)

      const wrongGuess = firstCode === WRONG ? '111111' : WRONG
      for (let attempt = 1; attempt <= MagicLinkToken.MAX_FAILED_ATTEMPTS; attempt++) {
        const burned = await verify.execute({ userIdentifier: 'test@test.te', code: wrongGuess })

        expect(burned.isFailed()).toBe(true)
        expect(firstToken.props.failedAttempts).toBe(attempt)
      }
      expect(firstToken.hasExhaustedAttempts()).toBe(true)

      // The exhausted code is dead even though it is neither consumed nor expired.
      expect(firstToken.props.consumed).toBe(false)
      expect(firstToken.isExpired(new Date())).toBe(false)
      const replay = await verify.execute({ userIdentifier: 'test@test.te', code: firstCode })
      expect(replay.isFailed()).toBe(true)
      expect(replay.getError()).toEqual(EXHAUSTED)

      const secondIssue = await generate.execute({ userIdentifier: 'test@test.te' })
      expect(secondIssue.isFailed()).toBe(false)
      expect(tokens).toHaveLength(2)
      const secondToken = tokens[1] as MagicLinkToken
      expect(secondToken.props.failedAttempts).toBe(0)
      expect(secondToken.hasExhaustedAttempts()).toBe(false)

      const accepted = await verify.execute({ userIdentifier: 'test@test.te', code: secondToken.props.code })

      expect(accepted.isFailed()).toBe(false)
      expect(accepted.getValue()).toBe(true)
      expect(secondToken.props.consumed).toBe(true)
    })
  })
})
