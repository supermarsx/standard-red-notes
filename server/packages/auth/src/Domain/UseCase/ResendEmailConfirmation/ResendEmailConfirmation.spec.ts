import 'reflect-metadata'

import { Logger } from 'winston'
import { Result } from '@standardnotes/domain-core'

import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { User } from '../../User/User'
import { RegistrationConfigResolverInterface } from '../../Registration/RegistrationConfigResolverInterface'
import { DEFAULT_REGISTRATION_CONFIG, RegistrationConfig } from '../../Registration/RegistrationConfig'
import { SendEmailConfirmation } from '../SendEmailConfirmation/SendEmailConfirmation'

import { ResendEmailConfirmation } from './ResendEmailConfirmation'

describe('ResendEmailConfirmation', () => {
  let userRepository: jest.Mocked<UserRepositoryInterface>
  let resolver: jest.Mocked<RegistrationConfigResolverInterface>
  let sendEmailConfirmation: jest.Mocked<SendEmailConfirmation>
  let logger: jest.Mocked<Logger>

  const config = (over: Partial<RegistrationConfig>): RegistrationConfig => ({
    ...DEFAULT_REGISTRATION_CONFIG,
    ...over,
  })

  const makeUser = (emailConfirmed: boolean): User => {
    const user = new User()
    user.uuid = 'u-1'
    user.email = 'a@b.co'
    user.emailConfirmed = emailConfirmed
    return user
  }

  const createUseCase = () => new ResendEmailConfirmation(userRepository, resolver, sendEmailConfirmation, logger)

  beforeEach(() => {
    userRepository = { findOneByUsernameOrEmail: jest.fn() } as unknown as jest.Mocked<UserRepositoryInterface>
    resolver = { resolve: jest.fn() }
    sendEmailConfirmation = {
      execute: jest.fn().mockResolvedValue(Result.ok(true)),
    } as unknown as jest.Mocked<SendEmailConfirmation>
    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  it('sends a new confirmation when the feature is enabled and the user is unconfirmed', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: true }))
    userRepository.findOneByUsernameOrEmail.mockResolvedValue(makeUser(false))

    const result = await createUseCase().execute({ email: 'a@b.co' })

    expect(result.getValue()).toBe(true)
    expect(sendEmailConfirmation.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userUuid: 'u-1', email: 'a@b.co' }),
    )
  })

  it('does nothing (but still returns success) when the feature is disabled', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: false }))

    const result = await createUseCase().execute({ email: 'a@b.co' })

    expect(result.getValue()).toBe(true)
    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(sendEmailConfirmation.execute).not.toHaveBeenCalled()
  })

  it('returns uniform success for an unknown address (no enumeration)', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: true }))
    userRepository.findOneByUsernameOrEmail.mockResolvedValue(null)

    const result = await createUseCase().execute({ email: 'ghost@b.co' })

    expect(result.getValue()).toBe(true)
    expect(sendEmailConfirmation.execute).not.toHaveBeenCalled()
  })

  it('does not resend to an already-confirmed user', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: true }))
    userRepository.findOneByUsernameOrEmail.mockResolvedValue(makeUser(true))

    const result = await createUseCase().execute({ email: 'a@b.co' })

    expect(result.getValue()).toBe(true)
    expect(sendEmailConfirmation.execute).not.toHaveBeenCalled()
  })

  it('does not await the send — a slow/never-settling SMTP call cannot delay the uniform 200 (constant latency)', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: true }))
    userRepository.findOneByUsernameOrEmail.mockResolvedValue(makeUser(false))
    // A send that never resolves must not block the response.
    sendEmailConfirmation.execute.mockReturnValue(new Promise<Result<boolean>>(() => {}))

    const result = await createUseCase().execute({ email: 'a@b.co' })

    expect(result.getValue()).toBe(true)
    expect(sendEmailConfirmation.execute).toHaveBeenCalled()
  })

  it('logs a fire-and-forget send rejection without blocking or throwing', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: true }))
    userRepository.findOneByUsernameOrEmail.mockResolvedValue(makeUser(false))
    sendEmailConfirmation.execute.mockRejectedValue(new Error('smtp down'))

    const result = await createUseCase().execute({ email: 'a@b.co' })
    expect(result.getValue()).toBe(true)

    // Drain the microtask queue so the fire-and-forget .catch runs.
    await new Promise((resolve) => setImmediate(resolve))
    expect(logger.error).toHaveBeenCalled()
  })

  it('logs when the fire-and-forget send resolves to a failed Result', async () => {
    resolver.resolve.mockResolvedValue(config({ emailConfirmationEnabled: true }))
    userRepository.findOneByUsernameOrEmail.mockResolvedValue(makeUser(false))
    sendEmailConfirmation.execute.mockResolvedValue(Result.fail('send failed'))

    const result = await createUseCase().execute({ email: 'a@b.co' })
    expect(result.getValue()).toBe(true)

    await new Promise((resolve) => setImmediate(resolve))
    expect(logger.error).toHaveBeenCalled()
  })

  it('never throws even if resolution fails', async () => {
    resolver.resolve.mockRejectedValue(new Error('overlay unreadable'))

    const result = await createUseCase().execute({ email: 'a@b.co' })

    expect(result.getValue()).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })
})
