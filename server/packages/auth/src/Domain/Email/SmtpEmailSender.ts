import * as nodemailer from 'nodemailer'
import { Logger } from 'winston'

import { EmailSenderInterface } from './EmailSenderInterface'

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
    return this.config.host !== undefined && this.config.host !== '' && this.config.from !== undefined
  }

  async sendEmail(to: string, subject: string, body: string): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.debug('SMTP is not configured. Skipping email delivery.')

      return false
    }

    try {
      const transporter = this.getTransporter()

      await transporter.sendMail({
        from: this.config.from,
        to,
        subject,
        text: body,
      })

      return true
    } catch (error) {
      this.logger.error(`Failed to send email via SMTP: ${(error as Error).message}`)

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
