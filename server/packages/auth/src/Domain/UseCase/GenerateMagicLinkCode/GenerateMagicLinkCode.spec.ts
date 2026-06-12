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
      isConfigured: jest.fn().mockReturnValue(false),
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

  it('should generate and persist a 6 digit numeric code', async () => {
    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().code).toMatch(/^\d{6}$/)
    expect(result.getValue().emailed).toBe(false)
    expect(magicLinkTokenRepository.save).toHaveBeenCalledTimes(1)
  })

  it('should not email the code when SMTP is not configured', async () => {
    emailSender.isConfigured.mockReturnValue(false)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.getValue().emailed).toBe(false)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('should email the code when SMTP is configured', async () => {
    emailSender.isConfigured.mockReturnValue(true)
    emailSender.sendEmail.mockResolvedValue(true)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.getValue().emailed).toBe(true)
    expect(emailSender.sendEmail).toHaveBeenCalledWith(
      'test@test.te',
      'Your sign-in verification code',
      expect.stringContaining(result.getValue().code),
    )
  })

  it('should still succeed (on-screen fallback) when email delivery fails', async () => {
    emailSender.isConfigured.mockReturnValue(true)
    emailSender.sendEmail.mockResolvedValue(false)

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().emailed).toBe(false)
    expect(result.getValue().code).toMatch(/^\d{6}$/)
  })

  it('should fail gracefully if persistence throws', async () => {
    magicLinkTokenRepository.save.mockRejectedValue(new Error('db down'))

    const result = await createUseCase().execute({ userIdentifier: 'test@test.te' })

    expect(result.isFailed()).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })
})
