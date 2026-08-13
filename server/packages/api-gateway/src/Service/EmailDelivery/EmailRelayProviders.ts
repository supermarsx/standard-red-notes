import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import * as nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import SMTPConnection from 'nodemailer/lib/smtp-connection'

import {
  AwsSesRelayProfile,
  EmailMessage,
  EmailRelay,
  EmailRelayFactory,
  EmailRelayProfile,
  EmailRelayResult,
  MailgunRelayProfile,
  relaySenderIdentity,
  sanitizedProviderCode,
  SendGridRelayProfile,
  SmtpRelayProfile,
  validateRelayProfile,
} from './Types'

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const PROVIDER_TIMEOUT_MS = 30_000

interface DefaultEmailRelayFactoryOptions {
  providerTimeoutMs?: number
  smtpConnectionFactory?: (options: SMTPConnection.Options) => SMTPConnection
}

export class DefaultEmailRelayFactory implements EmailRelayFactory {
  private readonly providerTimeoutMs: number
  private readonly smtpConnectionFactory: (options: SMTPConnection.Options) => SMTPConnection

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly sesClientFactory: (profile: AwsSesRelayProfile) => SESv2Client = defaultSesClient,
    options: DefaultEmailRelayFactoryOptions = {},
  ) {
    this.providerTimeoutMs = boundedProviderTimeout(options.providerTimeoutMs)
    this.smtpConnectionFactory = options.smtpConnectionFactory ?? ((smtpOptions) => new SMTPConnection(smtpOptions))
  }

  create(profile: EmailRelayProfile): EmailRelay {
    validateRelayProfile(profile)
    if (profile.kind === 'smtp') {
      return new SmtpEmailRelay(profile, this.smtpConnectionFactory, this.providerTimeoutMs)
    }
    if (profile.kind === 'sendgrid') {
      return new SendGridEmailRelay(profile, this.fetcher, this.providerTimeoutMs)
    }
    if (profile.kind === 'mailgun') {
      return new MailgunEmailRelay(profile, this.fetcher, this.providerTimeoutMs)
    }

    return new AwsSesEmailRelay(profile, this.sesClientFactory, this.providerTimeoutMs)
  }
}

class SmtpEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: SmtpRelayProfile,
    private readonly connectionFactory: (options: SMTPConnection.Options) => SMTPConnection,
    private readonly providerTimeoutMs: number,
  ) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    const connection = this.connectionFactory(smtpOptions(this.profile))
    try {
      const result = await withProviderDeadline(
        sendSmtp(connection, this.profile, mailOptions(this.profile.from, message)),
        () => abortSmtpConnection(connection),
        this.providerTimeoutMs,
      )
      const accepted = Array.isArray(result.accepted) ? result.accepted : []
      return accepted.length > 0
        ? { outcome: 'sent', providerCode: 'SMTP_ACCEPTED' }
        : { outcome: 'permanent-failure', failureClass: 'recipient-rejected', providerCode: 'SMTP_REJECTED' }
    } catch (error) {
      return nodemailerFailure(error)
    } finally {
      closeSmtpConnection(connection)
    }
  }
}

class SendGridEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: SendGridRelayProfile,
    private readonly fetcher: Fetcher,
    private readonly providerTimeoutMs: number,
  ) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    const content = [
      ...(message.text !== undefined ? [{ type: 'text/plain', value: message.text }] : []),
      ...(message.html !== undefined ? [{ type: 'text/html', value: message.html }] : []),
    ]
    try {
      const sender = relaySenderIdentity(this.profile.from) as { address: string; name?: string }
      const response = await this.fetcher('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.profile.apiKey as string}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: sender.address, ...(sender.name ? { name: sender.name } : {}) },
          subject: message.subject,
          content,
          attachments: message.attachments?.map((attachment) => ({
            filename: attachment.filename,
            type: attachment.contentType,
            disposition: 'attachment',
            content: attachment.contentBase64,
          })),
        }),
        signal: AbortSignal.timeout(this.providerTimeoutMs),
      })

      return httpResult(response, 202)
    } catch (error) {
      return networkFailure(error)
    }
  }
}

class MailgunEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: MailgunRelayProfile,
    private readonly fetcher: Fetcher,
    private readonly providerTimeoutMs: number,
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
        signal: AbortSignal.timeout(this.providerTimeoutMs),
      })

      return httpResult(response, 200)
    } catch (error) {
      return networkFailure(error)
    }
  }
}

class AwsSesEmailRelay implements EmailRelay {
  constructor(
    private readonly profile: AwsSesRelayProfile,
    private readonly clientFactory: (profile: AwsSesRelayProfile) => SESv2Client,
    private readonly providerTimeoutMs: number,
  ) {}

  async send(message: EmailMessage): Promise<EmailRelayResult> {
    const client = this.clientFactory(this.profile)
    const abortController = new AbortController()
    try {
      const rawMessage = await new MailComposer(mailOptions(this.profile.from, message)).compile().build()
      const result = await withProviderDeadline(
        client.send(
          new SendEmailCommand({
            FromEmailAddress: relaySenderIdentity(this.profile.from)?.address,
            Destination: { ToAddresses: [message.to] },
            Content: { Raw: { Data: rawMessage } },
          }),
          { abortSignal: abortController.signal },
        ),
        () => {
          abortController.abort()
          client.destroy()
        },
        this.providerTimeoutMs,
      )
      const accepted = typeof result.MessageId === 'string' && result.MessageId.length > 0
      return accepted
        ? { outcome: 'sent', providerCode: 'SES_ACCEPTED' }
        : { outcome: 'permanent-failure', failureClass: 'recipient-rejected', providerCode: 'SES_REJECTED' }
    } catch (error) {
      return awsFailure(error)
    } finally {
      client.destroy()
    }
  }
}

function closeSmtpConnection(connection: Pick<SMTPConnection, 'close'>): void {
  try {
    connection.close()
  } catch {
    // Delivery classification must survive best-effort transport cleanup.
  }
}

function abortSmtpConnection(connection: SMTPConnection): void {
  // SMTPConnection.close() deliberately performs a graceful socket.end() once
  // connected. A hard provider deadline must destroy the exact active socket;
  // otherwise a stalled SMTP peer can keep the transaction alive and accept a
  // late DATA response after the queue has scheduled a retry.
  const socketHolder = connection as unknown as {
    _socket?: { socket?: { destroy(): void }; destroy?: () => void }
  }
  const socket = socketHolder._socket?.socket ?? socketHolder._socket
  try {
    socket?.destroy?.()
  } catch {
    // Preserve the explicit timeout classification if teardown itself fails.
  }
  closeSmtpConnection(connection)
}

function withProviderDeadline<T>(operation: Promise<T>, abort: () => void, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      try {
        abort()
      } catch {
        // Preserve the explicit timeout classification even if cleanup fails.
      }
      const error = new Error('Email provider deadline exceeded') as Error & { code: string }
      error.name = 'TimeoutError'
      error.code = 'ETIMEDOUT'
      reject(error)
    }, timeoutMs)
    timer.unref?.()

    operation.then(
      (value) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(value)
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      },
    )
  })
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
    // Queue retry owns backoff. One bounded SDK attempt ensures graceful
    // shutdown cannot be overrun by hidden in-client retries.
    maxAttempts: 1,
  })
}

function smtpOptions(profile: SmtpRelayProfile): SMTPConnection.Options {
  const secure = profile.tlsMode === 'implicit'
  const insecure = profile.tlsMode === 'insecure'
  return {
    host: profile.host,
    port: profile.port,
    secure,
    requireTLS: !secure && !insecure,
    ignoreTLS: insecure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    name: 'standard-red-notes',
  }
}

function sendSmtp(
  connection: SMTPConnection,
  profile: SmtpRelayProfile,
  options: nodemailer.SendMailOptions,
): Promise<SMTPConnection.SentMessageInfo> {
  const message = new MailComposer(options).compile()

  return new Promise<SMTPConnection.SentMessageInfo>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      connection.removeListener('error', onError)
      connection.removeListener('end', onEnd)
    }
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const onError = (error: SMTPConnection.SMTPError) => fail(error)
    const onEnd = () => {
      const error = new Error('SMTP connection ended before delivery acknowledgement.') as SMTPConnection.SMTPError
      error.code = 'ECONNECTION'
      fail(error)
    }
    const send = () => {
      connection.send(message.getEnvelope(), message.createReadStream(), (error, result) => {
        if (error) {
          fail(error)
          return
        }
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(result)
      })
    }

    connection.once('error', onError)
    connection.once('end', onEnd)
    connection.connect((connectionError) => {
      if (connectionError) {
        fail(connectionError)
        return
      }
      if (profile.username && profile.password) {
        connection.login({ user: profile.username, pass: profile.password }, (authenticationError) => {
          if (authenticationError) {
            fail(authenticationError)
            return
          }
          send()
        })
        return
      }
      send()
    })
  })
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

function httpResult(response: Response, acceptedStatus: number): EmailRelayResult {
  const providerCode = `HTTP_${response.status}`
  if (response.status === acceptedStatus) {
    return { outcome: 'sent', providerCode, httpStatus: response.status }
  }
  if (response.ok) {
    return {
      outcome: 'transient-failure',
      failureClass: 'provider-protocol',
      providerCode,
      httpStatus: response.status,
    }
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

function boundedProviderTimeout(value: number | undefined): number {
  const timeout = value ?? PROVIDER_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 120_000) {
    throw new Error('Email provider timeout is invalid.')
  }
  return timeout
}
