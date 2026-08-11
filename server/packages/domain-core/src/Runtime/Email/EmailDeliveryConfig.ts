import { isIP } from 'net'

/**
 * Shared runtime email-delivery contract.
 *
 * The api-gateway owns the persisted overlay while auth and the gateway both
 * consume it. Keeping resolution and validation here prevents the two SMTP
 * paths from drifting on TLS, credential pairing, or input bounds.
 */
export const EMAIL_DELIVERY_TLS_MODES = ['implicit', 'starttls', 'insecure'] as const

export type EmailDeliveryTlsMode = (typeof EMAIL_DELIVERY_TLS_MODES)[number]

export const EMAIL_DELIVERY_LIMITS = {
  host: 253,
  username: 320,
  password: 4_096,
  from: 998,
  recipient: 320,
} as const

export interface EmailDeliveryConfig {
  host?: string
  port?: number
  username?: string
  password?: string
  from?: string
  tlsMode?: EmailDeliveryTlsMode
}

export interface ResolvedEmailDeliveryConfig {
  host: string
  port: number
  username?: string
  password?: string
  from: string
  tlsMode: EmailDeliveryTlsMode
}

export function resolveEmailDeliveryConfig(
  persisted: EmailDeliveryConfig | undefined,
  environment: EmailDeliveryConfig | undefined,
): ResolvedEmailDeliveryConfig {
  const portCandidate = persisted?.port ?? environment?.port
  const tlsMode =
    persisted?.tlsMode ??
    environment?.tlsMode ??
    (portCandidate === 465 ? ('implicit' as const) : ('starttls' as const))

  return {
    host: (persisted?.host ?? environment?.host ?? '').trim(),
    port: portCandidate ?? (tlsMode === 'implicit' ? 465 : 587),
    username: normalizedOptionalString(persisted?.username ?? environment?.username),
    password: normalizedOptionalSecret(persisted?.password ?? environment?.password),
    from: (persisted?.from ?? environment?.from ?? '').trim(),
    tlsMode,
  }
}

/** Returns a safe operator-facing validation error, never a value or secret. */
export function emailDeliveryConfigurationError(config: ResolvedEmailDeliveryConfig): string | undefined {
  if (!isSafeHost(config.host)) {
    return 'SMTP host is required and must be a valid bounded host name or IP address.'
  }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    return 'SMTP port must be an integer between 1 and 65535.'
  }
  if (!isSafeFromIdentity(config.from)) {
    return 'From identity is required and must be a bounded email identity without line breaks.'
  }
  if (config.username !== undefined && !isSafeHeaderValue(config.username, EMAIL_DELIVERY_LIMITS.username)) {
    return 'SMTP username is invalid or too long.'
  }
  if (
    config.password !== undefined &&
    (config.password.length < 1 ||
      config.password.length > EMAIL_DELIVERY_LIMITS.password ||
      config.password.includes('\0'))
  ) {
    return 'SMTP password is invalid or too long.'
  }
  if (Boolean(config.username) !== Boolean(config.password)) {
    return 'SMTP username and password must be configured together.'
  }
  if (!(EMAIL_DELIVERY_TLS_MODES as readonly string[]).includes(config.tlsMode)) {
    return 'SMTP TLS mode is invalid.'
  }
  if (config.tlsMode === 'insecure' && !isTrustedInsecureRelayHost(config.host)) {
    return 'Insecure SMTP is allowed only for an explicit loopback or private relay host.'
  }

  return undefined
}

export function isEmailDeliveryConfigured(config: ResolvedEmailDeliveryConfig): boolean {
  return emailDeliveryConfigurationError(config) === undefined
}

export function validateEmailRecipient(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const recipient = value.trim()
  if (
    recipient.length < 3 ||
    recipient.length > EMAIL_DELIVERY_LIMITS.recipient ||
    /[\r\n\0\s]/.test(recipient) ||
    !/^[^@]+@[^@]+$/.test(recipient)
  ) {
    return undefined
  }

  return recipient
}

export function isTrustedInsecureRelayHost(host: string): boolean {
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

  return normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')
}

function isSafeHost(value: string): boolean {
  return isSafeHeaderValue(value, EMAIL_DELIVERY_LIMITS.host) && !/[\s/?#]/.test(value) && !value.includes('://')
}

function isSafeFromIdentity(value: string): boolean {
  return isSafeHeaderValue(value, EMAIL_DELIVERY_LIMITS.from) && value.includes('@')
}

function isSafeHeaderValue(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength && !/[\r\n\0]/.test(value)
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()

  return normalized ? normalized : undefined
}

function normalizedOptionalSecret(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
