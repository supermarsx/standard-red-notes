import * as nodemailer from 'nodemailer'
import { Logger } from 'winston'

import { EmailSenderInterface, SendEmailOptions } from './EmailSenderInterface'

export interface SmtpEmailSenderConfig {
  host?: string
  port?: number
  user?: string
  pass?: string
  from?: string
}

export class SmtpEmailSender implements EmailSenderInterface {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transporter: any | null = null

  constructor(
    private config: SmtpEmailSenderConfig,
    private logger: Logger,
  ) {}

  isConfigured(): boolean {
    return (
      typeof this.config.host === 'string' &&
      this.config.host.trim().length > 0 &&
      typeof this.config.from === 'string' &&
      this.config.from.trim().length > 0 &&
      (this.config.port === undefined ||
        (Number.isSafeInteger(this.config.port) && this.config.port > 0 && this.config.port <= 65535))
    )
  }

  async sendEmail(to: string, subject: string, body: string, options?: SendEmailOptions): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.debug('SMTP is not configured. Skipping email delivery.')

      return false
    }

    try {
      const transporter = this.getTransporter()
      const bodyContent = options?.html ? { html: body } : { text: body }

      const result = await transporter.sendMail({
        from: this.config.from,
        to,
        subject,
        ...bodyContent,
        attachments: options?.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
        })),
      })

      const acceptedRecipients = Array.isArray(result?.accepted) ? result.accepted : []
      const accepted = acceptedRecipients.length > 0
      if (!accepted) {
        this.logger.error('SMTP did not confirm recipient acceptance', {
          codeTag: 'SmtpEmailSender',
        })
      }

      return accepted
    } catch (error) {
      this.logger.error('Failed to send email via SMTP', {
        codeTag: 'SmtpEmailSender',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })

      return false
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getTransporter(): any {
    if (this.transporter === null) {
      const auth =
        this.config.user !== undefined && this.config.user !== ''
          ? { user: this.config.user, pass: this.config.pass }
          : undefined

      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port ?? 587,
        secure: (this.config.port ?? 587) === 465,
        auth,
      })
    }

    return this.transporter
  }
}
