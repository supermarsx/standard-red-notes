import * as nodemailer from 'nodemailer'
import SMTPTransport from 'nodemailer/lib/smtp-transport'
import {
  EmailDeliveryConfig,
  ResolvedEmailDeliveryConfig,
  isEmailDeliveryConfigured,
  resolveEmailDeliveryConfig,
  validateEmailRecipient,
} from '@standardnotes/domain-core'

import { DeliveryChannel, DeliveryResult, ReminderDeliveryProvider } from '../Types'

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000
const DEFAULT_GREETING_TIMEOUT_MS = 10_000
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

export interface SmtpConfig {
  host?: string
  port?: number
  user?: string
  username?: string
  password?: string
  from?: string
  /** true selects implicit TLS. false/undefined selects STARTTLS unless allowInsecure is explicitly enabled. */
  secure?: boolean
  /** Explicit operator opt-out for trusted loopback or internal plaintext relays. */
  allowInsecure?: boolean
  /** Canonical runtime-overlay TLS mode. Legacy secure/allowInsecure remain supported. */
  tlsMode?: EmailDeliveryConfig['tlsMode']
  connectionTimeoutMs?: number
  greetingTimeoutMs?: number
  socketTimeoutMs?: number
}

/**
 * SMTP reminder delivery backed by Nodemailer.
 *
 * TLS is mandatory by default: port 465 uses implicit TLS when SMTP_SECURE is
 * enabled, while other ports require a successful STARTTLS upgrade. Operators
 * may explicitly set SMTP_ALLOW_INSECURE for a trusted loopback/internal relay.
 */
export class EmailProvider implements ReminderDeliveryProvider {
  readonly channel: DeliveryChannel = 'email'

  constructor(private readonly configSource: SmtpConfig | (() => Promise<SmtpConfig>)) {}

  isConfigured(): boolean {
    return typeof this.configSource === 'function'
      ? false
      : isEmailDeliveryConfigured(normalizeSmtpConfig(this.configSource))
  }

  async send(destination: string, message: string): Promise<DeliveryResult> {
    return this.sendMessage(destination, 'Reminder', message)
  }

  async sendTest(destination: string): Promise<DeliveryResult> {
    return this.sendMessage(
      destination,
      'Standard Red Notes email delivery test',
      'This message confirms that your Standard Red Notes server can deliver email using the active SMTP settings.',
    )
  }

  private async sendMessage(destination: string, subject: string, message: string): Promise<DeliveryResult> {
    const sourceConfig = await this.resolveConfig()
    const config = normalizeSmtpConfig(sourceConfig)
    if (!isEmailDeliveryConfigured(config)) {
      return {
        ok: false,
        notConfigured: true,
        reason: 'SMTP is not configured correctly (check host, from, port, and paired credentials).',
      }
    }

    if (/[\r\n]/.test(destination ?? '')) {
      return { ok: false, reason: 'The recipient email address contains invalid line breaks.' }
    }
    const to = validateEmailRecipient(destination)
    if (!to) {
      return { ok: false, reason: 'A recipient email address (destination) is required.' }
    }

    try {
      const result = await nodemailer.createTransport(smtpTransportOptions({ ...sourceConfig, ...config })).sendMail({
        from: config.from,
        to,
        subject,
        text: message,
        disableFileAccess: true,
        disableUrlAccess: true,
      })
      const acceptedRecipients = Array.isArray(result.accepted) ? result.accepted : []
      if (acceptedRecipients.length === 0) {
        return { ok: false, reason: 'SMTP did not accept the reminder recipient.' }
      }

      return { ok: true }
    } catch (error) {
      return { ok: false, reason: describeSmtpFailure(error) }
    }
  }

  private async resolveConfig(): Promise<SmtpConfig> {
    return typeof this.configSource === 'function' ? this.configSource() : this.configSource
  }
}

export function smtpTransportOptions(config: SmtpConfig | ResolvedEmailDeliveryConfig): SMTPTransport.Options {
  const resolved = normalizeSmtpConfig(config)
  const secure = resolved.tlsMode === 'implicit'
  const allowInsecure = resolved.tlsMode === 'insecure'
  const auth = resolved.username && resolved.password ? { user: resolved.username, pass: resolved.password } : undefined

  return {
    host: resolved.host,
    port: resolved.port,
    secure,
    requireTLS: !secure && !allowInsecure,
    ignoreTLS: !secure && allowInsecure,
    auth,
    connectionTimeout: boundedTimeout(
      'connectionTimeoutMs' in config ? config.connectionTimeoutMs : undefined,
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    greetingTimeout: boundedTimeout(
      'greetingTimeoutMs' in config ? config.greetingTimeoutMs : undefined,
      DEFAULT_GREETING_TIMEOUT_MS,
    ),
    socketTimeout: boundedTimeout(
      'socketTimeoutMs' in config ? config.socketTimeoutMs : undefined,
      DEFAULT_SOCKET_TIMEOUT_MS,
    ),
    name: 'standard-red-notes',
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

function normalizeSmtpConfig(config: SmtpConfig | ResolvedEmailDeliveryConfig): ResolvedEmailDeliveryConfig {
  const legacy = config as SmtpConfig
  const tlsMode =
    config.tlsMode ??
    (legacy.allowInsecure === true
      ? 'insecure'
      : legacy.secure === true || (legacy.secure === undefined && config.port === 465)
        ? 'implicit'
        : 'starttls')

  return resolveEmailDeliveryConfig(
    {
      host: config.host,
      port: config.port,
      username: config.username ?? legacy.user,
      password: config.password,
      from: config.from,
      tlsMode,
    },
    undefined,
  )
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return fallback
  }

  return Math.min(value as number, MAX_TIMEOUT_MS)
}

function describeSmtpFailure(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_-]{1,40}$/.test(error.code)
      ? error.code
      : undefined

  return code ? `Email delivery failed (${code}).` : 'Email delivery failed.'
}
