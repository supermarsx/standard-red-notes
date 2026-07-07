import 'reflect-metadata'

import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'
import { UniqueEntityId } from '@standardnotes/domain-core'

import { EmailConfirmationToken } from '../../EmailConfirmation/EmailConfirmationToken'
import { EmailConfirmationTokenRepositoryInterface } from '../../EmailConfirmation/EmailConfirmationTokenRepositoryInterface'
import { hashEmailConfirmationToken } from '../../EmailConfirmation/hashEmailConfirmationToken'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { User } from '../../User/User'

import { VerifyEmailConfirmation } from './VerifyEmailConfirmation'

describe('VerifyEmailConfirmation', () => {
  let tokenRepository: jest.Mocked<EmailConfirmationTokenRepositoryInterface>
  let userRepository: jest.Mocked<UserRepositoryInterface>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>

  const NOW = new Date('2026-07-06T00:00:00.000Z')
  const RAW = 'raw-token-value'
  const USER_UUID = '00000000-0000-0000-0000-000000000001'

  const makeUser = (emailConfirmed: boolean): User => {
    const user = new User()
    user.uuid = USER_UUID
    user.email = 'a@b.co'
    user.emailConfirmed = emailConfirmed
    user.emailConfirmedAt = null
    return user
  }

  const makeToken = (over: { consumed?: boolean; expiresAt?: Date } = {}): EmailConfirmationToken =>
    EmailConfirmationToken.create(
      {
        userUuid: USER_UUID,
        email: 'a@b.co',
        hashedToken: hashEmailConfirmationToken(RAW),
        expiresAt: over.expiresAt ?? new Date(NOW.getTime() + 60 * 60 * 1000),
        consumed: over.consumed ?? false,
        createdAt: new Date(NOW.getTime() - 60 * 1000),
      },
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()

  const createUseCase = () => new VerifyEmailConfirmation(tokenRepository, userRepository, timer, logger)

  beforeEach(() => {
    tokenRepository = {
      save: jest.fn(),
      findByHashedToken: jest.fn(),
      deleteAllForUser: jest.fn(),
      deleteExpiredOrConsumed: jest.fn().mockResolvedValue(0),
    }
    userRepository = {
      findOneByUuid: jest.fn(),
      save: jest.fn(async (u) => u),
    } as unknown as jest.Mocked<UserRepositoryInterface>
    timer = { getUTCDate: jest.fn().mockReturnValue(NOW) } as unknown as jest.Mocked<TimerInterface>
    logger = { debug: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  it('confirms a VALID token: marks the user confirmed, stamps the time and consumes the token', async () => {
    const user = makeUser(false)
    tokenRepository.findByHashedToken.mockResolvedValue(makeToken())
    userRepository.findOneByUuid.mockResolvedValue(user)

    const result = await createUseCase().execute({ token: RAW })

    expect(result.getValue()).toEqual({ success: true })
    expect(user.emailConfirmed).toBe(true)
    expect(user.emailConfirmedAt).toEqual(NOW)
    expect(userRepository.save).toHaveBeenCalledWith(user)
    // token consumed (single-use)
    const savedToken = tokenRepository.save.mock.calls[0][0]
    expect(savedToken.props.consumed).toBe(true)
  })

  it('looks the token up by its HASH, not the raw value', async () => {
    tokenRepository.findByHashedToken.mockResolvedValue(makeToken())
    userRepository.findOneByUuid.mockResolvedValue(makeUser(false))

    await createUseCase().execute({ token: RAW })

    expect(tokenRepository.findByHashedToken).toHaveBeenCalledWith(hashEmailConfirmationToken(RAW))
    expect(tokenRepository.findByHashedToken).not.toHaveBeenCalledWith(RAW)
  })

  it('rejects an EXPIRED token with a clear error and does not confirm', async () => {
    tokenRepository.findByHashedToken.mockResolvedValue(
      makeToken({ expiresAt: new Date(NOW.getTime() - 1000) }),
    )
    userRepository.findOneByUuid.mockResolvedValue(makeUser(false))

    const result = await createUseCase().execute({ token: RAW })

    expect(result.getValue().success).toBe(false)
    expect(result.getValue().errorMessage).toMatch(/expired/i)
    expect(userRepository.save).not.toHaveBeenCalled()
  })

  it('rejects an already-USED token for an unconfirmed user', async () => {
    tokenRepository.findByHashedToken.mockResolvedValue(makeToken({ consumed: true }))
    userRepository.findOneByUuid.mockResolvedValue(makeUser(false))

    const result = await createUseCase().execute({ token: RAW })

    expect(result.getValue().success).toBe(false)
    expect(result.getValue().errorMessage).toMatch(/already been used/i)
  })

  it('treats a re-click of a used token by an already-confirmed user as friendly success', async () => {
    tokenRepository.findByHashedToken.mockResolvedValue(makeToken({ consumed: true }))
    userRepository.findOneByUuid.mockResolvedValue(makeUser(true))

    const result = await createUseCase().execute({ token: RAW })

    expect(result.getValue()).toEqual({ success: true, alreadyConfirmed: true })
  })

  it('rejects an unknown token', async () => {
    tokenRepository.findByHashedToken.mockResolvedValue(null)

    const result = await createUseCase().execute({ token: RAW })

    expect(result.getValue().success).toBe(false)
    expect(result.getValue().errorMessage).toMatch(/invalid/i)
  })

  it('rejects an empty token without hitting the repository', async () => {
    const result = await createUseCase().execute({ token: '  ' })

    expect(result.getValue().success).toBe(false)
    expect(tokenRepository.findByHashedToken).not.toHaveBeenCalled()
  })
})
