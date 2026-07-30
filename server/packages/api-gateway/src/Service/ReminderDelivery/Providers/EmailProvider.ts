import * as nodemailer from 'nodemailer'
import SMTPTransport from 'nodemailer/lib/smtp-transport'
import { isIP } from 'net'

import { DeliveryChannel, DeliveryResult, ReminderDeliveryProvider } from '../Types'

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000
const DEFAULT_GREETING_TIMEOUT_MS = 10_000
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

export interface SmtpConfig {
  host?: string
  port?: number
  user?: string
  password?: string
  from?: string
  /** true selects implicit TLS. false/undefined selects STARTTLS unless allowInsecure is explicitly enabled. */
  secure?: boolean
  /** Explicit operator opt-out for trusted loopback or internal plaintext relays. */
  allowInsecure?: boolean
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

  private transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo> | undefined

  constructor(private readonly config: SmtpConfig) {}

  isConfigured(): boolean {
    const host = this.config.host?.trim()
    const from = this.config.from?.trim()
    const user = this.config.user?.trim()
    const password = this.config.password
    const credentialsArePaired = Boolean(user) === Boolean(password)
    const usesImplicitTls = this.config.secure ?? this.config.port === 465
    const plaintextOverrideIsSafe =
      this.config.allowInsecure !== true || usesImplicitTls || (host !== undefined && isTrustedInsecureRelayHost(host))
    const portIsValid =
      this.config.port === undefined ||
      (Number.isSafeInteger(this.config.port) && this.config.port > 0 && this.config.port <= 65_535)

    return (
      Boolean(host) &&
      Boolean(from) &&
      !containsHeaderBreak(host as string) &&
      !containsHeaderBreak(from as string) &&
      credentialsArePaired &&
      plaintextOverrideIsSafe &&
      portIsValid
    )
  }

  async send(destination: string, message: string): Promise<DeliveryResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        notConfigured: true,
        reason: 'SMTP is not configured correctly (check host, from, port, and paired credentials).',
      }
    }

    const to = (destination ?? '').trim()
    if (to.length === 0) {
      return { ok: false, reason: 'A recipient email address (destination) is required.' }
    }
    if (containsHeaderBreak(to)) {
      return { ok: false, reason: 'The recipient email address contains invalid line breaks.' }
    }

    try {
      const result = await this.getTransporter().sendMail({
        from: this.config.from?.trim(),
        to,
        subject: 'Reminder',
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

  private getTransporter(): nodemailer.Transporter<SMTPTransport.SentMessageInfo> {
    if (this.transporter !== undefined) {
      return this.transporter
    }

    this.transporter = nodemailer.createTransport(smtpTransportOptions(this.config))

    return this.transporter
  }
}

export function smtpTransportOptions(config: SmtpConfig): SMTPTransport.Options {
  const secure = config.secure ?? config.port === 465
  const allowInsecure = config.allowInsecure === true
  const user = config.user?.trim()
  const auth = user && config.password ? { user, pass: config.password } : undefined

  return {
    host: config.host?.trim(),
    port: config.port ?? (secure ? 465 : 587),
    secure,
    requireTLS: !secure && !allowInsecure,
    ignoreTLS: !secure && allowInsecure,
    auth,
    connectionTimeout: boundedTimeout(config.connectionTimeoutMs, DEFAULT_CONNECTION_TIMEOUT_MS),
    greetingTimeout: boundedTimeout(config.greetingTimeoutMs, DEFAULT_GREETING_TIMEOUT_MS),
    socketTimeout: boundedTimeout(config.socketTimeoutMs, DEFAULT_SOCKET_TIMEOUT_MS),
    name: 'standard-red-notes',
    disableFileAccess: true,
    disableUrlAccess: true,
  }
}

function containsHeaderBreak(value: string): boolean {
  return /[\r\n]/.test(value)
}

function isTrustedInsecureRelayHost(host: string): boolean {
  const normalizedHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  const ipVersion = isIP(normalizedHost)
  if (ipVersion === 4) {
    const [first, second] = normalizedHost.split('.').map(Number)

    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }
  if (ipVersion === 6) {
    return (
      normalizedHost === '::1' ||
      normalizedHost.startsWith('fc') ||
      normalizedHost.startsWith('fd') ||
      /^fe[89ab]/.test(normalizedHost)
    )
  }

  return normalizedHost.endsWith('.localhost') || !normalizedHost.includes('.')
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
