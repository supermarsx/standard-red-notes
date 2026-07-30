import * as nodemailer from 'nodemailer'
import { Logger } from 'winston'

import { SmtpEmailSender } from './SmtpEmailSender'

jest.mock('nodemailer')

describe('SmtpEmailSender', () => {
  let logger: jest.Mocked<Logger>
  let sendMail: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()

    sendMail = jest.fn().mockResolvedValue({ accepted: ['person@example.com'], rejected: [] })
    ;(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail })
  })

  it('sends attachment bytes with the requested filename and content type', async () => {
    const sender = new SmtpEmailSender(
      {
        host: 'smtp.example.com',
        port: 465,
        user: 'smtp-user',
        pass: 'smtp-password',
        from: 'notes@example.com',
      },
      logger,
    )
    const content = Buffer.from('encrypted-backup')

    await expect(
      sender.sendEmail('person@example.com', 'Your backup', '<p>Attached.</p>', {
        attachments: [{ filename: 'SN-Data-2026-07-30.txt', content, contentType: 'application/json' }],
        html: true,
      }),
    ).resolves.toBe(true)

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'smtp-user', pass: 'smtp-password' },
    })
    expect(sendMail).toHaveBeenCalledWith({
      from: 'notes@example.com',
      to: 'person@example.com',
      subject: 'Your backup',
      html: '<p>Attached.</p>',
      attachments: [{ filename: 'SN-Data-2026-07-30.txt', content, contentType: 'application/json' }],
    })
  })

  it('keeps direct callers text-only and always uses the configured From address', async () => {
    const sender = new SmtpEmailSender({ host: 'smtp.example.com', from: 'notes@example.com' }, logger)

    await expect(sender.sendEmail('person@example.com', 'subject', 'plain body')).resolves.toBe(true)

    expect(sendMail).toHaveBeenCalledWith({
      from: 'notes@example.com',
      to: 'person@example.com',
      subject: 'subject',
      text: 'plain body',
      attachments: undefined,
    })
  })

  it('does not create a transport when host or from is blank', async () => {
    const sender = new SmtpEmailSender({ host: 'smtp.example.com', from: '  ' }, logger)

    await expect(sender.sendEmail('person@example.com', 'subject', 'body')).resolves.toBe(false)

    expect(nodemailer.createTransport).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith('SMTP is not configured. Skipping email delivery.')
  })

  it('rejects an invalid SMTP port as unconfigured', async () => {
    const sender = new SmtpEmailSender(
      { host: 'smtp.example.com', port: Number.NaN, from: 'notes@example.com' },
      logger,
    )

    await expect(sender.sendEmail('person@example.com', 'subject', 'body')).resolves.toBe(false)

    expect(nodemailer.createTransport).not.toHaveBeenCalled()
  })

  it('returns false and logs no SMTP response or recipient when delivery fails', async () => {
    sendMail.mockRejectedValue(new Error('550 rejected secret-recipient@example.com'))
    const sender = new SmtpEmailSender({ host: 'smtp.example.com', from: 'notes@example.com' }, logger)

    await expect(sender.sendEmail('secret-recipient@example.com', 'subject', 'body')).resolves.toBe(false)

    expect(logger.error).toHaveBeenCalledWith('Failed to send email via SMTP', {
      codeTag: 'SmtpEmailSender',
      errorName: 'Error',
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-recipient@example.com')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('550 rejected')
  })

  it('returns false when SMTP resolves without accepting the recipient', async () => {
    sendMail.mockResolvedValue({ accepted: [], rejected: ['person@example.com'] })
    const sender = new SmtpEmailSender({ host: 'smtp.example.com', from: 'notes@example.com' }, logger)

    await expect(sender.sendEmail('person@example.com', 'subject', 'body')).resolves.toBe(false)

    expect(logger.error).toHaveBeenCalledWith('SMTP did not confirm recipient acceptance', {
      codeTag: 'SmtpEmailSender',
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('person@example.com')
  })
})
