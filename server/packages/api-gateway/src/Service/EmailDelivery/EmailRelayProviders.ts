import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import * as nodemailer from 'nodemailer'
import SMTPTransport from 'nodemailer/lib/smtp-transport'

import {
  AwsSesRelayProfile,
  EmailMessage,
  EmailRelay,
  EmailRelayFactory,
  EmailRelayProfile,
  EmailRelayResult,
  MailgunRelayProfile,
  sanitizedProviderCode,
  SendGridRelayProfile,
  SmtpRelayProfile,
  validateRelayProfile,
} from './Types'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const PROVIDER_TIMEOUT_MS = 30_000

export class DefaultEmailRelayFactory implements EmailRelayFactory {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly sesClientFactory: (profile: AwsSesRelayProfile) => SESv2Client = defaultSesClient,
  ) {}

  create(profile: EmailRelayProfile): EmailRelay {
    validateRelayProfile(profile)
    if (profile.kind === 'smtp') {
      return new SmtpEmailRelay(profile)
    }
    if (profile.kind === 'sendgrid') {
      return new SendGridEmailRelay(profile, this.fetcher)
    }
    if (profile.kind === 'mailgun') {
      return new MailgunEmailRelay(profile, this.fetcher)
    }

    return new AwsSesEmailRelay(profile, this.sesClientFactory)
  }
}

class SmtpEmailRelay implements EmailRelay {
  constructor(private readonly profile: SmtpRelayProfile) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    try {
      const result = await nodemailer
        .createTransport(smtpOptions(this.profile))
        .sendMail(mailOptions(this.profile.from, message))
      const accepted = Array.isArray(result.accepted) ? result.accepted : []
      return accepted.length > 0
        ? { outcome: 'sent', providerCode: 'SMTP_ACCEPTED' }
        : { outcome: 'permanent-failure', failureClass: 'recipient-rejected', providerCode: 'SMTP_REJECTED' }
    } catch (error) {
      return nodemailerFailure(error)
    }
  }
}

class SendGridEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: SendGridRelayProfile,
    private readonly fetcher: Fetcher,
  ) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    const content = [
      ...(message.text !== undefined ? [{ type: 'text/plain', value: message.text }] : []),
      ...(message.html !== undefined ? [{ type: 'text/html', value: message.html }] : []),
    ]
    try {
      const response = await this.fetcher('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.profile.apiKey as string}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: senderAddress(this.profile.from) },
          subject: message.subject,
          content,
          attachments: message.attachments?.map((attachment) => ({
            filename: attachment.filename,
            type: attachment.contentType,
            disposition: 'attachment',
            content: attachment.contentBase64,
          })),
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      })

      return httpResult(response)
    } catch (error) {
      return networkFailure(error)
    }
  }
}

class MailgunEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: MailgunRelayProfile,
    private readonly fetcher: Fetcher,
  ) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    const form = new FormData()
    form.set('from', this.profile.from)
    form.set('to', message.to)
    form.set('subject', message.subject)
    if (message.text !== undefined) {
      form.set('text', message.text)
    }
    if (message.html !== undefined) {
      form.set('html', message.html)
    }
    for (const attachment of message.attachments ?? []) {
      form.append(
        'attachment',
        new Blob([Buffer.from(attachment.contentBase64, 'base64')], {
          type: attachment.contentType ?? 'application/octet-stream',
        }),
        attachment.filename,
      )
    }

    const baseUrl = (this.profile.baseUrl ?? 'https://api.mailgun.net').replace(/\/$/, '')
    try {
      const response = await this.fetcher(`${baseUrl}/v3/${encodeURIComponent(this.profile.domain)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`api:${this.profile.apiKey as string}`).toString('base64')}` },
        body: form,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      })

      return httpResult(response)
    } catch (error) {
      return networkFailure(error)
    }
  }
}

class AwsSesEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: AwsSesRelayProfile,
    private readonly clientFactory: (profile: AwsSesRelayProfile) => SESv2Client,
  ) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    const client = this.clientFactory(this.profile)
    try {
      // Nodemailer's SESv2 transport creates a standards-compliant raw MIME
      // message, including attachments, while the modular SDK owns SigV4.
      const transport = nodemailer.createTransport({
        SES: { sesClient: client, SendEmailCommand },
        sendingRate: 1,
      } as nodemailer.TransportOptions)
      const result = await transport.sendMail(mailOptions(this.profile.from, message))
      const accepted = Array.isArray(result.accepted) ? result.accepted : []
      return accepted.length > 0
        ? { outcome: 'sent', providerCode: 'SES_ACCEPTED' }
        : { outcome: 'permanent-failure', failureClass: 'recipient-rejected', providerCode: 'SES_REJECTED' }
    } catch (error) {
      return awsFailure(error)
    } finally {
      client.destroy()
    }
  }
}

function defaultSesClient(profile: AwsSesRelayProfile): SESv2Client {
  return new SESv2Client({
    region: profile.region,
    ...(profile.accessKeyId && profile.secretAccessKey
      ? {
          credentials: {
            accessKeyId: profile.accessKeyId,
            secretAccessKey: profile.secretAccessKey,
            ...(profile.sessionToken ? { sessionToken: profile.sessionToken } : {}),
          },
        }
      : {}),
    requestHandler: { requestTimeout: PROVIDER_TIMEOUT_MS, connectionTimeout: 10_000 },
    maxAttempts: 2,
  })
}

function smtpOptions(profile: SmtpRelayProfile): SMTPTransport.Options {
  const secure = profile.tlsMode === 'implicit'
  const insecure = profile.tlsMode === 'insecure'
  return {
    host: profile.host,
    port: profile.port,
    secure,
    requireTLS: !secure && !insecure,
    ignoreTLS: insecure,
    auth: profile.username && profile.password ? { user: profile.username, pass: profile.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    name: 'standard-red-notes',
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

function mailOptions(from: string, message: EmailMessage): nodemailer.SendMailOptions {
  return {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: message.attachments?.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: Buffer.from(attachment.contentBase64, 'base64'),
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

function senderAddress(value: string): string {
  const match = value.match(/<([^<>]+)>\s*$/)
  return (match?.[1] ?? value).trim()
}

function httpResult(response: Response): EmailRelayResult {
  const providerCode = `HTTP_${response.status}`
  if (response.ok) {
    return { outcome: 'sent', providerCode, httpStatus: response.status }
  }
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    return {
      outcome: 'transient-failure',
      failureClass: 'provider-unavailable',
      providerCode,
      httpStatus: response.status,
    }
  }

  return { outcome: 'permanent-failure', failureClass: 'provider-rejected', providerCode, httpStatus: response.status }
}

function networkFailure(error: unknown): EmailRelayResult {
  const name = error instanceof Error ? error.name : undefined
  return {
    outcome: 'transient-failure',
    failureClass: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    providerCode: errorCode(error),
  }
}

function nodemailerFailure(error: unknown): EmailRelayResult {
  const status = numericProperty(error, 'responseCode')
  const permanent = status !== undefined && status >= 500 && status < 600
  return {
    outcome: permanent ? 'permanent-failure' : 'transient-failure',
    failureClass: permanent ? 'provider-rejected' : 'transport',
    providerCode: errorCode(error),
    ...(status !== undefined ? { httpStatus: status } : {}),
  }
}

function awsFailure(error: unknown): EmailRelayResult {
  const status = numericNestedProperty(error, '$metadata', 'httpStatusCode')
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? sanitizedProviderCode(error.name) : undefined
  const permanent = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
  return {
    outcome: permanent ? 'permanent-failure' : 'transient-failure',
    failureClass: permanent ? 'provider-rejected' : 'provider-unavailable',
    providerCode: name,
    ...(status !== undefined ? { httpStatus: status } : {}),
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? sanitizedProviderCode(error.code) : undefined
}

function numericProperty(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : undefined
}

function numericNestedProperty(value: unknown, outer: string, inner: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(outer in value)) {
    return undefined
  }
  return numericProperty((value as Record<string, unknown>)[outer], inner)
}
