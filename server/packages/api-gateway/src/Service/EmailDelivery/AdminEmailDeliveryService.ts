import { EmailRelayWrite } from './RelayConfiguration'
import { EmailDeliverySource, EmailRelayKind } from './Types'

export const EMAIL_QUEUE_STATES = ['ready', 'leased', 'dead'] as const
export type EmailQueueState = (typeof EMAIL_QUEUE_STATES)[number]

export const EMAIL_DELIVERY_LOG_OUTCOMES = [
  'sent',
  'rejected',
  'transient-failure',
  'permanent-failure',
  'rate-limited',
] as const
export type EmailDeliveryLogOutcome = (typeof EMAIL_DELIVERY_LOG_OUTCOMES)[number]

export type EmailRelayFallbackPolicy = { mode: 'next-enabled' | 'none' }

type EmailRelayBase = {
  id: string
  name: string
  enabled: boolean
  priority: number
  from: string
  rateLimit: { max: number; windowSeconds: number }
}

/**
 * Internal relay shape returned by the concrete persistence adapter. It may
 * contain write-only credentials, so controllers must project it into a public
 * DTO rather than serializing the object directly.
 */
export type StoredEmailRelay =
  | (EmailRelayBase & {
      kind: 'smtp'
      host: string
      port: number
      username?: string
      tlsMode: 'implicit' | 'starttls' | 'insecure'
      credentialsConfigured: boolean
      password?: string
    })
  | (EmailRelayBase & {
      kind: 'sendgrid'
      credentialsConfigured: boolean
      apiKey?: string
    })
  | (EmailRelayBase & {
      kind: 'mailgun'
      domain: string
      baseUrl?: string
      credentialsConfigured: boolean
      apiKey?: string
    })
  | (EmailRelayBase & {
      kind: 'aws-ses'
      region: string
      credentialsConfigured: boolean
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string
    })

export type EmailRelaySnapshot = {
  relays: StoredEmailRelay[]
  fallbackPolicy: EmailRelayFallbackPolicy
  configured: boolean
}

export type EmailRelayUpdate = {
  relays: EmailRelayWrite[]
  fallbackPolicy: EmailRelayFallbackPolicy
}

export type EmailDeliveryTestRequest = {
  recipient: string
  relayId?: string
}

export type EmailDeliveryTestRecord = {
  accepted: boolean
  relayId: string | null
  relayKind: EmailRelayKind | null
  outcome: 'sent' | 'rejected' | 'rate-limited' | 'unconfigured' | 'failed'
  /** Internal-only fields which must never cross the controller boundary. */
  recipient?: string
  rawProviderResponse?: unknown
}

export type EmailQueueQuery = {
  state: EmailQueueState
  limit: number
  cursor?: string
}

export type EmailQueueRecord = {
  id: string
  state: EmailQueueState
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
  /** Internal delivery data which must never cross the controller boundary. */
  recipient?: string
  subject?: string
  body?: string
  attachments?: unknown
  rawProviderResponse?: unknown
}

export type EmailQueuePage = {
  items: EmailQueueRecord[]
  nextCursor?: string
}

export type EmailDeliveryLogQuery = {
  limit: number
  cursor?: string
  relayId?: string
  outcome?: EmailDeliveryLogOutcome
}

export type EmailDeliveryLogRecord = {
  id: string
  jobId: string
  relayId: string
  relayKind: EmailRelayKind
  attempt: number
  outcome: EmailDeliveryLogOutcome
  failureClass?: string
  providerCode?: string
  httpStatus?: number
  durationMs: number
  createdAt: number
  /** Internal delivery data which must never cross the controller boundary. */
  recipient?: string
  subject?: string
  body?: string
  attachments?: unknown
  rawProviderResponse?: unknown
}

export type EmailDeliveryLogPage = {
  items: EmailDeliveryLogRecord[]
  nextCursor?: string
}

/**
 * Persistence/queue/provider facade consumed by the HTTP boundary. Concrete
 * lifecycle and storage wiring deliberately lives elsewhere.
 */
export interface AdminEmailDeliveryService {
  getRelays(): Promise<EmailRelaySnapshot>
  putRelays(update: EmailRelayUpdate): Promise<EmailRelaySnapshot>
  testDelivery(request: EmailDeliveryTestRequest): Promise<EmailDeliveryTestRecord>
  listQueue(query: EmailQueueQuery): Promise<EmailQueuePage>
  listLogs(query: EmailDeliveryLogQuery): Promise<EmailDeliveryLogPage>
  retryQueueItem(id: string): Promise<EmailQueueRecord>
  discardQueueItem(id: string): Promise<void>
}

export type AdminEmailDeliveryErrorCode =
  'bad-request' | 'not-found' | 'conflict' | 'rate-limited' | 'provider-failure' | 'unavailable'

/**
 * Safe classification channel from an adapter to the controller. The message
 * is intentionally never serialized because provider errors can contain SMTP
 * replies, recipients, or request bodies.
 */
export class AdminEmailDeliveryServiceError extends Error {
  constructor(
    readonly code: AdminEmailDeliveryErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Admin email delivery service error: ${code}`)
    this.name = 'AdminEmailDeliveryServiceError'
  }
}
