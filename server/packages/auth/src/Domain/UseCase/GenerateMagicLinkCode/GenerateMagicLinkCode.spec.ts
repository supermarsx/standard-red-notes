import 'reflect-metadata'

import { Logger } from 'winston'

import { GenerateMagicLinkCode } from './GenerateMagicLinkCode'
import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

describe('GenerateMagicLinkCode', () => {
  let magicLinkTokenRepository: jest.Mocked<MagicLinkTokenRepositoryInterface>
  let emailSender: jest.Mocked<EmailSenderInterface>
  let logger: jest.Mocked<Logger>

  const createUseCase = () => new GenerateMagicLinkCode(magicLinkTokenRepository, emailSender, logger)

  beforeEach(() => {
    magicLinkTokenRepository = {
      save: jest.fn(),
      findLatestByUserIdentifier: jest.fn(),
    }

    emailSender = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn().mockResolvedValue(true),
    }

    logger = {
      debug: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('should fail if no user identifier is provided', async () => {
    const result = await createUseCase().execute({ userIdentifier: '' })

    expect(result.isFailed()).toBe(true)
    expect(magicLinkTokenRepository.save).not.toHaveBeenCalled()
  })

  it('should generate, persist, and email a 6 digit numeric code without returning it', async () => {
    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual({ emailed: true })
    expect(magicLinkTokenRepository.save).toHaveBeenCalledTimes(1)

    const persistedToken = magicLinkTokenRepository.save.mock.calls[0][0]
    expect(persistedToken.props.code).toMatch(/^\d{6}$/)
    expect(emailSender.sendEmail).toHaveBeenCalledWith(
      'test@test.te',
      'Your sign-in verification code',
      expect.stringContaining(persistedToken.props.code),
    )
  })

  it('should fail closed without generating or persisting a code when SMTP is not configured', async () => {
    emailSender.isConfigured.mockResolvedValue(false)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Email delivery is not configured. Magic-link sign-in is unavailable.')
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(magicLinkTokenRepository.save).not.toHaveBeenCalled()
  })

  it('should email the code when SMTP is configured', async () => {
    emailSender.isConfigured.mockReturnValue(true)
    emailSender.sendEmail.mockResolvedValue(true)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.getValue()).toEqual({ emailed: true })
    expect(emailSender.sendEmail).toHaveBeenCalledWith(
      'test@test.te',
      'Your sign-in verification code',
      expect.stringMatching(/\d{6}/),
    )
  })

  it('should fail without returning an on-screen fallback when email delivery fails', async () => {
    emailSender.isConfigured.mockReturnValue(true)
    emailSender.sendEmail.mockResolvedValue(false)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not deliver the magic-link verification code. Please try again.')
    expect(magicLinkTokenRepository.save).toHaveBeenCalledTimes(1)
  })

  it('should fail gracefully if persistence throws', async () => {
    magicLinkTokenRepository.save.mockRejectedValue(new Error('db down'))

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })
})
