import 'reflect-metadata'

import { Logger } from 'winston'

import { VerifyMagicLinkCode } from './VerifyMagicLinkCode'
import { MagicLinkToken } from '../../MagicLink/MagicLinkToken'
import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'

describe('VerifyMagicLinkCode', () => {
  let magicLinkTokenRepository: jest.Mocked<MagicLinkTokenRepositoryInterface>
  let logger: jest.Mocked<Logger>

  const createUseCase = () => new VerifyMagicLinkCode(magicLinkTokenRepository, logger)

  const createToken = (overrides: Partial<{ code: string; consumed: boolean; expiresAt: Date }> = {}) =>
    MagicLinkToken.create({
      userIdentifier: 'test@test.te',
      code: overrides.code ?? '123456',
      consumed: overrides.consumed ?? false,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 1000),
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
  })

  it('selects the delivered code when same-second concurrent issuance makes latest-token order ambiguous', async () => {
    const sameCreatedAt = new Date('2026-08-13T12:00:00.000Z')
    const queueSurvivor = MagicLinkToken.create({
      userIdentifier: 'test@test.te',
      code: '111111',
      consumed: false,
      expiresAt: new Date('2026-08-13T12:15:00.000Z'),
      createdAt: sameCreatedAt,
    }).getValue()
    const ambiguouslyLatest = MagicLinkToken.create({
      userIdentifier: 'test@test.te',
      code: '222222',
      consumed: false,
      expiresAt: new Date('2026-08-13T12:15:00.000Z'),
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
})
