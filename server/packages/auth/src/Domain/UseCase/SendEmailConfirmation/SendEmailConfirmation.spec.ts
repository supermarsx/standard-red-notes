import 'reflect-metadata'

import { Logger } from 'winston'

import { EmailConfirmationTokenRepositoryInterface } from '../../EmailConfirmation/EmailConfirmationTokenRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { DEFAULT_REGISTRATION_CONFIG, RegistrationConfig } from '../../Registration/RegistrationConfig'
import { hashEmailConfirmationToken } from '../../EmailConfirmation/hashEmailConfirmationToken'

import { SendEmailConfirmation } from './SendEmailConfirmation'

describe('SendEmailConfirmation', () => {
  let tokenRepository: jest.Mocked<EmailConfirmationTokenRepositoryInterface>
  let emailSender: jest.Mocked<EmailSenderInterface>
  let logger: jest.Mocked<Logger>

  const config = (over: Partial<RegistrationConfig> = {}): RegistrationConfig => ({
    ...DEFAULT_REGISTRATION_CONFIG,
    emailConfirmationEnabled: true,
    emailConfirmationBaseUrl: 'https://notes.example.com',
    ...over,
  })

  const createUseCase = () => new SendEmailConfirmation(tokenRepository, emailSender, logger)

  beforeEach(() => {
    tokenRepository = {
      save: jest.fn(),
      findByHashedToken: jest.fn(),
      deleteAllForUser: jest.fn(),
      deleteExpiredOrConsumed: jest.fn().mockResolvedValue(0),
    }
    emailSender = { isConfigured: jest.fn().mockReturnValue(true), sendEmail: jest.fn().mockResolvedValue(true) }
    logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  it('stores only the HASH of the token (never the raw token) and emails a link containing the raw token', async () => {
    const result = await createUseCase().execute({ userUuid: 'u-1', email: 'a@b.co', registrationConfig: config() })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
    expect(tokenRepository.save).toHaveBeenCalledTimes(1)

    const savedToken = tokenRepository.save.mock.calls[0][0]
    // The persisted value is a 64-char sha256 hex, not the raw token in the link.
    expect(savedToken.props.hashedToken).toMatch(/^[a-f0-9]{64}$/)

    const [, , body] = emailSender.sendEmail.mock.calls[0]
    const rawToken = decodeURIComponent(body.match(/email_confirmation=([^\s&]+)/)![1])
    expect(hashEmailConfirmationToken(rawToken)).toBe(savedToken.props.hashedToken)
    expect(body).not.toContain(savedToken.props.hashedToken)
  })

  it('sets a ~24h expiry on the token', async () => {
    await createUseCase().execute({ userUuid: 'u-1', email: 'a@b.co', registrationConfig: config() })

    const saved = tokenRepository.save.mock.calls[0][0]
    const ttlHours = (saved.props.expiresAt.getTime() - saved.props.createdAt.getTime()) / (60 * 60 * 1000)
    expect(ttlHours).toBeCloseTo(24, 5)
    expect(saved.props.consumed).toBe(false)
  })

  it('stores the token but returns false (not emailed) when SMTP is unconfigured', async () => {
    emailSender.isConfigured.mockReturnValue(false)

    const result = await createUseCase().execute({ userUuid: 'u-1', email: 'a@b.co', registrationConfig: config() })

    expect(result.getValue()).toBe(false)
    expect(tokenRepository.save).toHaveBeenCalledTimes(1)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('uses the configured subject/body template', async () => {
    await createUseCase().execute({
      userUuid: 'u-1',
      email: 'a@b.co',
      registrationConfig: config({ emailConfirmationSubject: 'Verify!', emailConfirmationBody: 'Link: {{confirmation_url}}' }),
    })

    const [to, subject, body] = emailSender.sendEmail.mock.calls[0]
    expect(to).toBe('a@b.co')
    expect(subject).toBe('Verify!')
    expect(body).toMatch(/^Link: https:\/\/notes\.example\.com\/\?email_confirmation=/)
  })

  it('invalidates prior tokens BEFORE saving the new one, then prunes expired/consumed rows', async () => {
    const order: string[] = []
    tokenRepository.deleteAllForUser.mockImplementation(async () => {
      order.push('deleteAllForUser')
    })
    tokenRepository.save.mockImplementation(async () => {
      order.push('save')
    })

    await createUseCase().execute({ userUuid: 'u-1', email: 'a@b.co', registrationConfig: config() })

    expect(tokenRepository.deleteAllForUser).toHaveBeenCalledWith('u-1')
    // Ordering matters: deleting after save would remove the token we just issued.
    expect(order).toEqual(['deleteAllForUser', 'save'])
    expect(tokenRepository.deleteExpiredOrConsumed).toHaveBeenCalledTimes(1)
  })

  it('still issues the token when the opportunistic cleanup fails (non-fatal)', async () => {
    tokenRepository.deleteExpiredOrConsumed.mockRejectedValue(new Error('gc boom'))

    const result = await createUseCase().execute({ userUuid: 'u-1', email: 'a@b.co', registrationConfig: config() })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
    expect(tokenRepository.save).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('fails gracefully when persistence throws', async () => {
    tokenRepository.save.mockRejectedValue(new Error('db down'))

    const result = await createUseCase().execute({ userUuid: 'u-1', email: 'a@b.co', registrationConfig: config() })

    expect(result.isFailed()).toBe(true)
    expect(logger.error).toHaveBeenCalled()
  })
})
