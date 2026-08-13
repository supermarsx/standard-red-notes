import {
  isTrustedInsecureRelayHost,
  validateEmailRecipient,
  validateEmailSenderIdentity,
} from '@standardnotes/domain-core'

export const EMAIL_RELAY_KINDS = ['smtp', 'sendgrid', 'mailgun', 'aws-ses'] as const
export type EmailRelayKind = (typeof EMAIL_RELAY_KINDS)[number]
export type EmailDeliverySource = 'reminder' | 'published-reminder' | 'account' | 'backup' | 'test' | 'other'
export type EmailFallbackMode = 'next-enabled' | 'none'

export interface EmailAttachment {
  filename: string
  contentType?: string
  /** Base64 is used so a queued message has one portable, JSON-safe representation. */
  contentBase64: string
}

export interface EmailMessage {
  to: string
  subject: string
  text?: string
  html?: string
  attachments?: EmailAttachment[]
}

export interface RelayRateLimit {
  /** 0 disables the profile-specific limit. */
  max: number
  windowSeconds: number
}

interface EmailRelayProfileBase {
  id: string
  name: string
  kind: EmailRelayKind
  enabled: boolean
  priority: number
  from: string
  rateLimit: RelayRateLimit
}

export interface SmtpRelayProfile extends EmailRelayProfileBase {
  kind: 'smtp'
  host: string
  port: number
  username?: string
  password?: string
  tlsMode: 'implicit' | 'starttls' | 'insecure'
}

export interface SendGridRelayProfile extends EmailRelayProfileBase {
  kind: 'sendgrid'
  apiKey?: string
}

export interface MailgunRelayProfile extends EmailRelayProfileBase {
  kind: 'mailgun'
  apiKey?: string
  domain: string
  /** Restricted to Mailgun's official US or EU API origins by validation. */
  baseUrl?: string
}

export interface AwsSesRelayProfile extends EmailRelayProfileBase {
  kind: 'aws-ses'
  region: string
  /** Omit all three values to use the runtime's default AWS credential chain. */
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
}

export type EmailRelayProfile = SmtpRelayProfile | SendGridRelayProfile | MailgunRelayProfile | AwsSesRelayProfile

export interface EmailDeliveryConfig {
  relays: EmailRelayProfile[]
  fallbackPolicy: { mode: EmailFallbackMode }
}

export type EmailRelayResult =
  | { outcome: 'sent'; providerCode?: string; httpStatus?: number }
  | {
      outcome: 'transient-failure' | 'permanent-failure'
      failureClass: string
      providerCode?: string
      httpStatus?: number
    }

export interface EmailRelay {
  send(message: EmailMessage): Promise<EmailRelayResult>
}

export interface EmailRelayFactory {
  create(profile: EmailRelayProfile): EmailRelay
}

export type QueueState = 'ready' | 'leased' | 'dead'

export interface QueuedEmail {
  id: string
  source: EmailDeliverySource
  message: EmailMessage
  attempt: number
  maxAttempts: number
  createdAt: number
  nextAttemptAt: number
  lastRelayId?: string
  lastFailureClass?: string
  deadAt?: number
  expiresAt?: number
  retryMode?: 'bounded' | 'indefinite'
  supersessionKey?: string
}

export interface ClaimedEmail {
  job: QueuedEmail
  token: string
  leaseExpiresAt: number
}

export type QueueSettlementResult = 'settled' | 'stale' | 'quarantined'
export type QueueDiscardResult = 'discarded' | 'not-found' | 'leased'

export interface QueueItemView {
  id: string
  state: QueueState
  source: EmailDeliverySource
  attempt: number
  maxAttempts: number
  createdAt: number
  nextAttemptAt?: number
  leaseExpiresAt?: number
  lastRelayId?: string
  lastFailureClass?: string
  expiresAt?: number
  retryMode?: 'bounded' | 'indefinite'
}

export type EmailAttemptOutcome = 'sent' | 'rejected' | 'transient-failure' | 'permanent-failure' | 'rate-limited'

export interface EmailAttemptLog {
  id: string
  jobId: string
  relayId: string
  relayKind: EmailRelayKind
  attempt: number
  outcome: EmailAttemptOutcome
  failureClass?: string
  providerCode?: string
  httpStatus?: number
  durationMs: number
  createdAt: number
}

export type EmailAttemptLogView = EmailAttemptLog

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export interface EmailDeliveryQueue {
  enqueue(job: QueuedEmail): Promise<void>
  claim(): Promise<ClaimedEmail | null>
  renewLease(claim: ClaimedEmail): Promise<boolean>
  acknowledge(claim: ClaimedEmail): Promise<QueueSettlementResult>
  retry(claim: ClaimedEmail, job: QueuedEmail): Promise<QueueSettlementResult>
  deadLetter(claim: ClaimedEmail, job: QueuedEmail): Promise<QueueSettlementResult>
  list(state: QueueState, limit?: number, cursor?: string): Promise<Page<QueueItemView>>
  requeue(id: string): Promise<QueueItemView | null>
  discard(id: string): Promise<QueueDiscardResult>
}

export interface EmailAttemptLogStore {
  record(entry: EmailAttemptLog): Promise<void>
  list(
    limit?: number,
    cursor?: string,
    query?: { relayId?: string; outcome?: EmailAttemptOutcome },
  ): Promise<Page<EmailAttemptLogView>>
}

export interface ProfileRateLimitDecision {
  allowed: boolean
  retryAfterMs: number
}

export interface EmailProfileRateLimiter {
  reserve(profileId: string, limit: RelayRateLimit): Promise<ProfileRateLimitDecision>
}

export interface EmailRelayViewBase {
  id: string
  name: string
  kind: EmailRelayKind
  enabled: boolean
  priority: number
  from: string
  rateLimit: RelayRateLimit
  credentialsConfigured: boolean
}

export type EmailRelayView = EmailRelayViewBase &
  Partial<Pick<SmtpRelayProfile, 'host' | 'port' | 'username' | 'tlsMode'>> &
  Partial<Pick<MailgunRelayProfile, 'domain' | 'baseUrl'>> &
  Partial<Pick<AwsSesRelayProfile, 'region'>>

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const SAFE_PROVIDER_CODE = /^[A-Za-z0-9_.:-]{1,64}$/
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/
const MAX_SUBJECT = 998
const MAX_BODY_CHARS = 5_000_000
const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export function validateEmailMessage(message: EmailMessage): EmailMessage {
  const to = validateEmailRecipient(message.to)
  if (!to || /[\r\n\0]/.test(message.to)) {
    throw new Error('A valid recipient email address is required.')
  }
  if (!message.subject || message.subject.length > MAX_SUBJECT || /[\r\n\0]/.test(message.subject)) {
    throw new Error('The email subject is invalid.')
  }
  if (message.text === undefined && message.html === undefined) {
    throw new Error('An email text or HTML body is required.')
  }
  if ((message.text?.length ?? 0) > MAX_BODY_CHARS || (message.html?.length ?? 0) > MAX_BODY_CHARS) {
    throw new Error('The email body is too large.')
  }
  const attachments = message.attachments ?? []
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error('The email has too many attachments.')
  }
  for (const attachment of attachments) {
    if (
      !attachment.filename ||
      attachment.filename.length > 255 ||
      /[\r\n\0/\\]/.test(attachment.filename) ||
      (attachment.contentType !== undefined &&
        (!/^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType) || attachment.contentType.length > 127))
    ) {
      throw new Error('An email attachment has invalid metadata.')
    }
    const bytes = Buffer.from(attachment.contentBase64, 'base64')
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== attachment.contentBase64) {
      throw new Error('An email attachment has invalid or oversized content.')
    }
  }

  return {
    ...message,
    to,
    ...(attachments.length > 0 ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}),
  }
}

export function validateRelayProfile(profile: EmailRelayProfile): void {
  if (!SAFE_ID.test(profile.id) || !profile.name.trim() || profile.name.length > 128) {
    throw new Error('Email relay identity is invalid.')
  }
  if (!Number.isSafeInteger(profile.priority) || profile.priority < 0 || profile.priority > 100_000) {
    throw new Error('Email relay priority is invalid.')
  }
  if (
    !Number.isSafeInteger(profile.rateLimit.max) ||
    profile.rateLimit.max < 0 ||
    profile.rateLimit.max > 1_000_000 ||
    !Number.isSafeInteger(profile.rateLimit.windowSeconds) ||
    profile.rateLimit.windowSeconds < 1 ||
    profile.rateLimit.windowSeconds > 2_592_000
  ) {
    throw new Error('Email relay rate limit is invalid.')
  }
  if (!relaySenderAddress(profile.from)) {
    throw new Error('Email relay sender is invalid.')
  }

  if (profile.kind === 'smtp') {
    const pairedCredentials = Boolean(profile.username) === Boolean(profile.password)
    if (
      !profile.host ||
      profile.host.length > 253 ||
      /[\s\r\n\0/\\]/.test(profile.host) ||
      !Number.isSafeInteger(profile.port) ||
      profile.port < 1 ||
      profile.port > 65_535 ||
      !pairedCredentials ||
      (profile.tlsMode === 'insecure' && !isTrustedInsecureRelayHost(profile.host))
    ) {
      throw new Error('SMTP relay configuration is invalid.')
    }
  } else if (profile.kind === 'sendgrid') {
    if (profile.enabled && !profile.apiKey) {
      throw new Error('SendGrid credentials are required.')
    }
  } else if (profile.kind === 'mailgun') {
    const baseUrl = profile.baseUrl ?? 'https://api.mailgun.net'
    if (
      (profile.enabled && !profile.apiKey) ||
      !isDnsName(profile.domain) ||
      !['https://api.mailgun.net', 'https://api.eu.mailgun.net'].includes(baseUrl.replace(/\/$/, ''))
    ) {
      throw new Error('Mailgun relay configuration is invalid.')
    }
  } else {
    const staticCredentials =
      Boolean(profile.accessKeyId) || Boolean(profile.secretAccessKey) || Boolean(profile.sessionToken)
    if (!AWS_REGION.test(profile.region) || (staticCredentials && (!profile.accessKeyId || !profile.secretAccessKey))) {
      throw new Error('AWS SES relay configuration is invalid.')
    }
  }
}

/** Parses the validated mailbox and optional display name used consistently by every provider. */
export function relaySenderIdentity(value: unknown): { address: string; name?: string } | undefined {
  return validateEmailSenderIdentity(value)
}

/** Returns only the mailbox portion for provider contracts that require it. */
export function relaySenderAddress(value: unknown): string | undefined {
  return relaySenderIdentity(value)?.address
}

function isDnsName(value: string): boolean {
  if (value.length < 1 || value.length > 253 || value.endsWith('.')) {
    return false
  }

  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
}

export function orderedEnabledRelays(config: EmailDeliveryConfig): EmailRelayProfile[] {
  const seen = new Set<string>()
  for (const relay of config.relays) {
    validateRelayProfile(relay)
    if (seen.has(relay.id)) {
      throw new Error('Email relay ids must be unique.')
    }
    seen.add(relay.id)
  }

  return config.relays
    .filter((relay) => relay.enabled)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
}

export function toRelayView(profile: EmailRelayProfile): EmailRelayView {
  const base: EmailRelayViewBase = {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    enabled: profile.enabled,
    priority: profile.priority,
    from: profile.from,
    rateLimit: { ...profile.rateLimit },
    credentialsConfigured:
      profile.kind === 'smtp'
        ? Boolean(profile.username && profile.password)
        : profile.kind === 'aws-ses'
          ? Boolean(profile.accessKeyId && profile.secretAccessKey) ||
            (!profile.accessKeyId && !profile.secretAccessKey)
          : Boolean(profile.apiKey),
  }
  if (profile.kind === 'smtp') {
    return { ...base, host: profile.host, port: profile.port, username: profile.username, tlsMode: profile.tlsMode }
  }
  if (profile.kind === 'mailgun') {
    return { ...base, domain: profile.domain, baseUrl: profile.baseUrl }
  }
  if (profile.kind === 'aws-ses') {
    return { ...base, region: profile.region }
  }

  return base
}

export function sanitizedProviderCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_PROVIDER_CODE.test(value) ? value : undefined
}
