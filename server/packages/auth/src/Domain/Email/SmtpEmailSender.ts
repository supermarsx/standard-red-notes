import * as nodemailer from 'nodemailer'
import { Logger } from 'winston'
import {
  EmailDeliveryConfig,
  ResolvedEmailDeliveryConfig,
  isEmailDeliveryConfigured,
  resolveEmailDeliveryConfig,
  validateEmailRecipient,
} from '@standardnotes/domain-core'

import { EmailSenderInterface, SendEmailOptions } from './EmailSenderInterface'

export interface SmtpEmailSenderConfig {
  host?: string
  port?: number
  user?: string
  pass?: string
  from?: string
  tlsMode?: EmailDeliveryConfig['tlsMode']
}

export class SmtpEmailSender implements EmailSenderInterface {
  readonly acceptanceMode = 'provider' as const

  constructor(
    private readonly config: SmtpEmailSenderConfig,
    private readonly logger: Logger,
    private readonly overlayResolver?: () => Promise<EmailDeliveryConfig | undefined>,
  ) {}

  async isConfigured(): Promise<boolean> {
    return isEmailDeliveryConfigured(await this.resolveConfig())
  }

  async sendEmail(to: string, subject: string, body: string, options?: SendEmailOptions): Promise<boolean> {
    const config = await this.resolveConfig()
    const recipient = validateEmailRecipient(to)
    // An unconfigured relay and a malformed message are different operator
    // problems, and the first one is the whole reason a self-hosted deployment
    // silently sends nothing. Diagnose each at a level the shipped
    // LOG_LEVEL=info actually prints: at `debug` the only trace an operator saw
    // was a cause-free "could not publish" from the event publisher.
    if (!isEmailDeliveryConfigured(config)) {
      this.logger.warn('Email delivery is not configured; the message was not sent to any relay.', {
        codeTag: 'SmtpEmailSender',
        reason: 'relay-unconfigured',
      })

      return false
    }
    if (!recipient || /[\r\n\0]/.test(subject) || subject.length > 998) {
      this.logger.warn('Email delivery rejected a message before contacting the relay.', {
        codeTag: 'SmtpEmailSender',
        reason: recipient ? 'invalid-subject' : 'invalid-recipient',
      })

      return false
    }

    try {
      const transporter = nodemailer.createTransport(this.transportOptions(config))
      const bodyContent = options?.html ? { html: body } : { text: body }

      const result = await transporter.sendMail({
        from: config.from,
        to: recipient,
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

  private async resolveConfig(): Promise<ResolvedEmailDeliveryConfig> {
    const persisted = await this.overlayResolver?.()

    return resolveEmailDeliveryConfig(persisted, {
      host: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: this.config.pass,
      from: this.config.from,
      tlsMode: this.config.tlsMode,
    })
  }

  private transportOptions(config: ResolvedEmailDeliveryConfig): nodemailer.TransportOptions {
    const secure = config.tlsMode === 'implicit'
    const allowInsecure = config.tlsMode === 'insecure'

    return {
      host: config.host,
      port: config.port,
      secure,
      requireTLS: !secure && !allowInsecure,
      ignoreTLS: !secure && allowInsecure,
      auth: config.username && config.password ? { user: config.username, pass: config.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      name: 'standard-red-notes',
      disableFileAccess: true,
      disableUrlAccess: true,
    } as nodemailer.TransportOptions
  }
}
