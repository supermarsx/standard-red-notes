import { Logger } from 'winston'

import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { SendApprovalNotification } from './SendApprovalNotification'

describe('SendApprovalNotification', () => {
  let emailSender: EmailSenderInterface
  let logger: Logger

  const email = 'approved@example.com'

  const createUseCase = () => new SendApprovalNotification(emailSender, logger)

  beforeEach(() => {
    emailSender = {} as jest.Mocked<EmailSenderInterface>
    emailSender.isConfigured = jest.fn().mockReturnValue(true)
    emailSender.sendEmail = jest.fn().mockResolvedValue(true)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('should fail if no email is given', async () => {
    const result = await createUseCase().execute({ email: '' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not send approval notification: missing email.')
    expect(emailSender.isConfigured).not.toHaveBeenCalled()
  })

  it('should skip cleanly when SMTP is not configured', async () => {
    emailSender.isConfigured = jest.fn().mockResolvedValue(false)

    const result = await createUseCase().execute({ email })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(false)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('should send the approval email without a sign-in link when no url is given', async () => {
    const result = await createUseCase().execute({ email })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    const [to, subject, body] = (emailSender.sendEmail as jest.Mock).mock.calls[0]
    expect(to).toEqual(email)
    expect(subject).toEqual('Your account has been approved')
    expect(body).not.toContain('Sign in here')
  })

  it('should append the trimmed sign-in link with trailing slashes stripped', async () => {
    await createUseCase().execute({ email, signInUrl: '  https://notes.example.com//  ' })

    const body = (emailSender.sendEmail as jest.Mock).mock.calls[0][2] as string
    expect(body).toContain('Sign in here: https://notes.example.com')
    expect(body).not.toContain('example.com/')
  })

  it('should treat a blank sign-in url as no link at all', async () => {
    await createUseCase().execute({ email, signInUrl: '   ' })

    const body = (emailSender.sendEmail as jest.Mock).mock.calls[0][2] as string
    expect(body).not.toContain('Sign in here')
  })

  it('should report the sender saying it did not dispatch', async () => {
    emailSender.sendEmail = jest.fn().mockResolvedValue(false)

    const result = await createUseCase().execute({ email })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(false)
  })

  it('should fail without leaking the email address when the sender throws', async () => {
    emailSender.sendEmail = jest.fn().mockRejectedValue(new Error('smtp down'))

    const result = await createUseCase().execute({ email })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not send approval notification.')
    expect(logger.error).toHaveBeenCalledWith('[approval] Failed to send an approval notification.', {
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('smtp down')
  })
})
