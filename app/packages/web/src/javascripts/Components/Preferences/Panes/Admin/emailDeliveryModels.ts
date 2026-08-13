export const EMAIL_RELAY_KINDS = ['smtp', 'sendgrid', 'mailgun', 'aws-ses'] as const
export const EMAIL_RELAY_PROFILE_LIMIT = 20
export type EmailRelayKind = (typeof EMAIL_RELAY_KINDS)[number]

export const EMAIL_QUEUE_STATES = ['ready', 'leased', 'dead'] as const
export type EmailQueueState = (typeof EMAIL_QUEUE_STATES)[number]

export const EMAIL_LOG_OUTCOMES = [
  'sent',
  'rejected',
  'transient-failure',
  'permanent-failure',
  'rate-limited',
] as const
export type EmailLogOutcome = (typeof EMAIL_LOG_OUTCOMES)[number]

export type RelayFallbackPolicy = { mode: 'next-enabled' | 'none' }

type RelayBase = {
  id: string
  name: string
  enabled: boolean
  priority: number
  from: string
  rateLimit: { max: number; windowSeconds: number }
}

export type RelayView = RelayBase &
  (
    | {
        kind: 'smtp'
        host: string
        port: number
        username?: string
        tlsMode: 'implicit' | 'starttls' | 'insecure'
        credentialsConfigured: boolean
      }
    | { kind: 'sendgrid'; credentialsConfigured: boolean }
    | { kind: 'mailgun'; domain: string; baseUrl?: string; credentialsConfigured: boolean }
    | { kind: 'aws-ses'; region: string; credentialsConfigured: boolean }
  )

export type RelaysResponse = {
  relays: RelayView[]
  fallbackPolicy: RelayFallbackPolicy
  configured: boolean
}

export type RelayDraft = RelayBase & {
  kind: EmailRelayKind
  credentialsConfigured: boolean
  host: string
  port: number
  username: string
  storedUsername: string
  tlsMode: 'implicit' | 'starttls' | 'insecure'
  domain: string
  baseUrl: string
  region: string
  password: string
  apiKey: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  clearCredentials: boolean
}

type RelayWriteBase = RelayBase & { kind: EmailRelayKind }

export type RelayWrite =
  | (RelayWriteBase & {
      kind: 'smtp'
      host: string
      port: number
      username?: string
      password?: string | null
      tlsMode: 'implicit' | 'starttls' | 'insecure'
    })
  | (RelayWriteBase & { kind: 'sendgrid'; apiKey?: string | null })
  | (RelayWriteBase & { kind: 'mailgun'; domain: string; baseUrl?: string; apiKey?: string | null })
  | (RelayWriteBase & {
      kind: 'aws-ses'
      region: string
      accessKeyId?: string | null
      secretAccessKey?: string | null
      sessionToken?: string | null
    })

export type RelayConformityCheck = { id: string; label: string; passing: boolean }

export type EmailTestResult = {
  accepted: boolean
  relayId: string | null
  relayKind: EmailRelayKind | null
  outcome: 'sent' | 'rejected' | 'rate-limited' | 'unconfigured' | 'failed'
}

export type EmailQueueItem = {
  id: string
  state: EmailQueueState
  source: 'reminder' | 'published-reminder' | 'account' | 'backup' | 'test' | 'other'
  attempt: number
  maxAttempts: number
  createdAt: string
  nextAttemptAt?: string
  leaseExpiresAt?: string
  lastRelayId?: string
  lastFailureClass?: string
  expiresAt?: string
  retryMode?: 'bounded' | 'indefinite'
}

export type EmailQueueResponse = { items: EmailQueueItem[]; nextCursor?: string }

export type EmailLogItem = {
  id: string
  jobId: string
  relayId: string
  relayKind: EmailRelayKind
  attempt: number
  outcome: EmailLogOutcome
  failureClass?: string
  providerCode?: string
  httpStatus?: number
  durationMs: number
  createdAt: string
}

export type EmailLogsResponse = { items: EmailLogItem[]; nextCursor?: string }

export const RELAY_KIND_LABELS: Record<EmailRelayKind, string> = {
  smtp: 'SMTP',
  sendgrid: 'SendGrid',
  mailgun: 'Mailgun',
  'aws-ses': 'Amazon SES',
}

export const RELAY_PROVIDER_HELP: Record<EmailRelayKind, string> = {
  smtp: 'Connects to a standard mail relay. STARTTLS is preferred; insecure mode is accepted only for an explicitly trusted private relay.',
  sendgrid:
    'Uses the SendGrid mail API. Create a restricted API key with only the mail-send permission; the key remains write-only.',
  mailgun:
    'Uses the Mailgun HTTP API. Enter the sending domain and only override the base URL for a regional or self-hosted endpoint.',
  'aws-ses':
    'Uses Amazon Simple Email Service in the selected region. Use a dedicated least-privilege IAM credential; all credential fields remain write-only.',
}

const isRelayKind = (value: unknown): value is EmailRelayKind =>
  typeof value === 'string' && (EMAIL_RELAY_KINDS as readonly string[]).includes(value)

const isQueueState = (value: unknown): value is EmailQueueState =>
  typeof value === 'string' && (EMAIL_QUEUE_STATES as readonly string[]).includes(value)

const isLogOutcome = (value: unknown): value is EmailLogOutcome =>
  typeof value === 'string' && (EMAIL_LOG_OUTCOMES as readonly string[]).includes(value)

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const numberValue = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const recordValue = (value: unknown): Record<string, unknown> | undefined => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function createRelayDraft(index = 0): RelayDraft {
  const randomId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `relay-${Date.now().toString(36)}-${index.toString(36)}`

  return {
    id: randomId,
    name: `Relay ${index + 1}`,
    kind: 'smtp',
    enabled: true,
    priority: index + 1,
    from: '',
    rateLimit: { max: 100, windowSeconds: 60 },
    credentialsConfigured: false,
    host: '',
    port: 587,
    username: '',
    storedUsername: '',
    tlsMode: 'starttls',
    domain: '',
    baseUrl: '',
    region: '',
    password: '',
    apiKey: '',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    clearCredentials: false,
  }
}

export function relayViewToDraft(relay: RelayView): RelayDraft {
  const draft = { ...createRelayDraft(relay.priority), ...relay }
  return {
    ...draft,
    rateLimit: { ...relay.rateLimit },
    host: relay.kind === 'smtp' ? relay.host : '',
    port: relay.kind === 'smtp' ? relay.port : 587,
    username: relay.kind === 'smtp' ? (relay.username ?? '') : '',
    storedUsername: relay.kind === 'smtp' ? (relay.username ?? '') : '',
    tlsMode: relay.kind === 'smtp' ? relay.tlsMode : 'starttls',
    domain: relay.kind === 'mailgun' ? relay.domain : '',
    baseUrl: relay.kind === 'mailgun' ? (relay.baseUrl ?? '') : '',
    region: relay.kind === 'aws-ses' ? relay.region : '',
    password: '',
    apiKey: '',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    clearCredentials: false,
  }
}

export function normalizeRelayPriorities(relays: RelayDraft[]): RelayDraft[] {
  return relays.map((relay, index) => ({ ...relay, priority: index + 1 }))
}

function credentialsArePresent(relay: RelayDraft): boolean {
  if (!relay.enabled) {
    return true
  }
  switch (relay.kind) {
    case 'smtp': {
      const hasUsername = relay.username.trim().length > 0
      if (!hasUsername) {
        return relay.password.length === 0 && (!relay.credentialsConfigured || relay.clearCredentials)
      }
      if (relay.password.length > 0) {
        return true
      }
      return !relay.clearCredentials && relay.credentialsConfigured && relay.username.trim() === relay.storedUsername
    }
    case 'sendgrid':
    case 'mailgun':
      return !relay.clearCredentials && (relay.credentialsConfigured || relay.apiKey.length > 0)
    case 'aws-ses':
      if (relay.accessKeyId.length > 0 || relay.secretAccessKey.length > 0 || relay.sessionToken.length > 0) {
        return relay.accessKeyId.length > 0 && relay.secretAccessKey.length > 0
      }
      return (
        relay.clearCredentials ||
        relay.credentialsConfigured ||
        (relay.accessKeyId.length === 0 && relay.secretAccessKey.length === 0 && relay.sessionToken.length === 0)
      )
  }
}

export function relayConformityChecks(relay: RelayDraft): RelayConformityCheck[] {
  const common: RelayConformityCheck[] = [
    {
      id: 'name',
      label: 'Profile name is present and within 128 characters',
      passing: relay.name.trim().length > 0 && relay.name.length <= 128,
    },
    {
      id: 'from',
      label: 'From identity is a plain mailbox or a display name with one mailbox',
      passing: senderIdentityIsValid(relay.from),
    },
    {
      id: 'rate-limit',
      label: 'Rate limit uses a non-negative maximum and a positive window',
      passing:
        Number.isSafeInteger(relay.rateLimit.max) &&
        relay.rateLimit.max >= 0 &&
        relay.rateLimit.max <= 1_000_000 &&
        Number.isSafeInteger(relay.rateLimit.windowSeconds) &&
        relay.rateLimit.windowSeconds > 0 &&
        relay.rateLimit.windowSeconds <= 2_592_000,
    },
    { id: 'credentials', label: 'Required credentials are configured', passing: credentialsArePresent(relay) },
  ]

  switch (relay.kind) {
    case 'smtp':
      return [
        ...common,
        {
          id: 'host',
          label: 'SMTP host is a bounded hostname or IP address',
          passing:
            relay.host.trim().length > 0 &&
            relay.host.length <= 253 &&
            !/[\s/\\@?#]/.test(relay.host) &&
            !relay.host.includes('://'),
        },
        {
          id: 'port',
          label: 'SMTP port is between 1 and 65535',
          passing: Number.isSafeInteger(relay.port) && relay.port >= 1 && relay.port <= 65_535,
        },
      ]
    case 'sendgrid':
      return common
    case 'mailgun':
      return [
        ...common,
        {
          id: 'domain',
          label: 'Mailgun sending domain is bounded and contains no URL path',
          passing: dnsNameIsValid(relay.domain.trim()),
        },
        {
          id: 'base-url',
          label: 'Mailgun API origin is the official US or EU endpoint',
          passing:
            relay.baseUrl.trim().length === 0 ||
            ['https://api.mailgun.net', 'https://api.eu.mailgun.net'].includes(relay.baseUrl.trim().replace(/\/$/, '')),
        },
      ]
    case 'aws-ses':
      return [
        ...common,
        {
          id: 'region',
          label: 'AWS region uses a supported region identifier',
          passing: /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(relay.region.trim()),
        },
      ]
  }
}

function mailboxIsValid(value: string): boolean {
  if (value.length < 3 || value.length > 320 || /[\s\r\n\0,;<>]/.test(value)) {
    return false
  }
  const parts = value.split('@')
  if (parts.length !== 2) {
    return false
  }
  const [localPart, domain] = parts
  return (
    localPart.length >= 1 &&
    localPart.length <= 64 &&
    !localPart.startsWith('.') &&
    !localPart.endsWith('.') &&
    !localPart.includes('..') &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart) &&
    dnsNameIsValid(domain)
  )
}

function senderIdentityIsValid(value: string): boolean {
  if (value.length > 998 || /[\r\n\0]/.test(value)) {
    return false
  }
  const trimmed = value.trim()
  if (!trimmed.includes('<') && !trimmed.includes('>')) {
    return mailboxIsValid(trimmed)
  }
  const match = trimmed.match(/^([^<>]+?)\s*<([^<>]+)>$/)
  return Boolean(match?.[1].trim() && mailboxIsValid((match?.[2] ?? '').trim()))
}

function dnsNameIsValid(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !value.endsWith('.') &&
    value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  )
}

export function relayIsConformant(relay: RelayDraft): boolean {
  return relayConformityChecks(relay).every((check) => check.passing)
}

export function serializeRelayDraft(relay: RelayDraft): RelayWrite {
  const common: RelayWriteBase = {
    id: relay.id,
    name: relay.name.trim(),
    kind: relay.kind,
    enabled: relay.enabled,
    priority: relay.priority,
    from: relay.from.trim(),
    rateLimit: { max: relay.rateLimit.max, windowSeconds: relay.rateLimit.windowSeconds },
  }

  switch (relay.kind) {
    case 'smtp':
      return {
        ...common,
        kind: 'smtp',
        host: relay.host.trim(),
        port: relay.port,
        ...(relay.username.trim() ? { username: relay.username.trim() } : {}),
        ...(relay.password ? { password: relay.password } : relay.clearCredentials ? { password: null } : {}),
        tlsMode: relay.tlsMode,
      }
    case 'sendgrid':
      return {
        ...common,
        kind: 'sendgrid',
        ...(relay.apiKey ? { apiKey: relay.apiKey } : relay.clearCredentials ? { apiKey: null } : {}),
      }
    case 'mailgun':
      return {
        ...common,
        kind: 'mailgun',
        domain: relay.domain.trim(),
        ...(relay.baseUrl.trim() ? { baseUrl: relay.baseUrl.trim() } : {}),
        ...(relay.apiKey ? { apiKey: relay.apiKey } : relay.clearCredentials ? { apiKey: null } : {}),
      }
    case 'aws-ses':
      return {
        ...common,
        kind: 'aws-ses',
        region: relay.region.trim(),
        ...(relay.accessKeyId
          ? { accessKeyId: relay.accessKeyId }
          : relay.clearCredentials
            ? { accessKeyId: null }
            : {}),
        ...(relay.secretAccessKey
          ? { secretAccessKey: relay.secretAccessKey }
          : relay.clearCredentials
            ? { secretAccessKey: null }
            : {}),
        ...(relay.sessionToken
          ? { sessionToken: relay.sessionToken }
          : relay.clearCredentials
            ? { sessionToken: null }
            : {}),
      }
  }
}

/** Decode only the documented public fields so an unexpected server property can never be rendered as a secret. */
export function decodeRelaysResponse(value: unknown): RelaysResponse | undefined {
  const root = recordValue(value)
  const fallback = recordValue(root?.fallbackPolicy)
  if (!root || !Array.isArray(root.relays) || (fallback?.mode !== 'next-enabled' && fallback?.mode !== 'none')) {
    return undefined
  }

  const relays: RelayView[] = []
  for (const candidate of root.relays) {
    const relay = recordValue(candidate)
    const rateLimit = recordValue(relay?.rateLimit)
    if (
      !relay ||
      !isRelayKind(relay.kind) ||
      !stringValue(relay.id) ||
      stringValue(relay.name) === undefined ||
      typeof relay.enabled !== 'boolean' ||
      numberValue(relay.priority) === undefined ||
      stringValue(relay.from) === undefined ||
      numberValue(rateLimit?.max) === undefined ||
      numberValue(rateLimit?.windowSeconds) === undefined ||
      typeof relay.credentialsConfigured !== 'boolean'
    ) {
      return undefined
    }

    const base = {
      id: relay.id as string,
      name: relay.name as string,
      enabled: relay.enabled,
      priority: relay.priority as number,
      from: relay.from as string,
      rateLimit: { max: rateLimit?.max as number, windowSeconds: rateLimit?.windowSeconds as number },
      credentialsConfigured: relay.credentialsConfigured,
    }
    if (relay.kind === 'smtp') {
      if (
        stringValue(relay.host) === undefined ||
        numberValue(relay.port) === undefined ||
        (relay.tlsMode !== 'implicit' && relay.tlsMode !== 'starttls' && relay.tlsMode !== 'insecure')
      ) {
        return undefined
      }
      relays.push({
        ...base,
        kind: 'smtp',
        host: relay.host as string,
        port: relay.port as number,
        ...(stringValue(relay.username) !== undefined ? { username: relay.username as string } : {}),
        tlsMode: relay.tlsMode,
      })
    } else if (relay.kind === 'mailgun') {
      if (stringValue(relay.domain) === undefined) {
        return undefined
      }
      relays.push({
        ...base,
        kind: 'mailgun',
        domain: relay.domain as string,
        ...(stringValue(relay.baseUrl) !== undefined ? { baseUrl: relay.baseUrl as string } : {}),
      })
    } else if (relay.kind === 'aws-ses') {
      if (stringValue(relay.region) === undefined) {
        return undefined
      }
      relays.push({ ...base, kind: 'aws-ses', region: relay.region as string })
    } else {
      relays.push({ ...base, kind: 'sendgrid' })
    }
  }

  return {
    relays,
    fallbackPolicy: { mode: fallback.mode },
    configured: root.configured === true,
  }
}

export function decodeQueueResponse(value: unknown): EmailQueueResponse | undefined {
  const root = recordValue(value)
  if (!root || !Array.isArray(root.items)) {
    return undefined
  }
  const items: EmailQueueItem[] = []
  for (const candidate of root.items) {
    const item = recordValue(candidate)
    if (
      !item ||
      !stringValue(item.id) ||
      !isQueueState(item.state) ||
      (item.source !== 'reminder' &&
        item.source !== 'published-reminder' &&
        item.source !== 'account' &&
        item.source !== 'backup' &&
        item.source !== 'test' &&
        item.source !== 'other') ||
      numberValue(item.attempt) === undefined ||
      numberValue(item.maxAttempts) === undefined ||
      !stringValue(item.createdAt)
    ) {
      return undefined
    }
    items.push({
      id: item.id as string,
      state: item.state,
      source: item.source,
      attempt: item.attempt as number,
      maxAttempts: item.maxAttempts as number,
      createdAt: item.createdAt as string,
      ...(stringValue(item.nextAttemptAt) ? { nextAttemptAt: item.nextAttemptAt as string } : {}),
      ...(stringValue(item.leaseExpiresAt) ? { leaseExpiresAt: item.leaseExpiresAt as string } : {}),
      ...(stringValue(item.lastRelayId) ? { lastRelayId: item.lastRelayId as string } : {}),
      ...(stringValue(item.lastFailureClass) ? { lastFailureClass: item.lastFailureClass as string } : {}),
      ...(stringValue(item.expiresAt) ? { expiresAt: item.expiresAt as string } : {}),
      ...(item.retryMode === 'bounded' || item.retryMode === 'indefinite' ? { retryMode: item.retryMode } : {}),
    })
  }
  return {
    items,
    ...(stringValue(root.nextCursor) ? { nextCursor: root.nextCursor as string } : {}),
  }
}

export function decodeLogsResponse(value: unknown): EmailLogsResponse | undefined {
  const root = recordValue(value)
  if (!root || !Array.isArray(root.items)) {
    return undefined
  }
  const items: EmailLogItem[] = []
  for (const candidate of root.items) {
    const item = recordValue(candidate)
    if (
      !item ||
      !stringValue(item.id) ||
      !stringValue(item.jobId) ||
      !stringValue(item.relayId) ||
      !isRelayKind(item.relayKind) ||
      numberValue(item.attempt) === undefined ||
      !isLogOutcome(item.outcome) ||
      numberValue(item.durationMs) === undefined ||
      !stringValue(item.createdAt)
    ) {
      return undefined
    }
    items.push({
      id: item.id as string,
      jobId: item.jobId as string,
      relayId: item.relayId as string,
      relayKind: item.relayKind,
      attempt: item.attempt as number,
      outcome: item.outcome,
      durationMs: item.durationMs as number,
      createdAt: item.createdAt as string,
      ...(stringValue(item.failureClass) ? { failureClass: item.failureClass as string } : {}),
      ...(stringValue(item.providerCode) ? { providerCode: item.providerCode as string } : {}),
      ...(numberValue(item.httpStatus) !== undefined ? { httpStatus: item.httpStatus as number } : {}),
    })
  }
  return {
    items,
    ...(stringValue(root.nextCursor) ? { nextCursor: root.nextCursor as string } : {}),
  }
}

export function decodeEmailTestResult(value: unknown): EmailTestResult | undefined {
  const root = recordValue(value)
  if (
    !root ||
    typeof root.accepted !== 'boolean' ||
    (root.relayId !== null && stringValue(root.relayId) === undefined) ||
    (root.relayKind !== null && !isRelayKind(root.relayKind)) ||
    (root.outcome !== 'sent' &&
      root.outcome !== 'rejected' &&
      root.outcome !== 'rate-limited' &&
      root.outcome !== 'unconfigured' &&
      root.outcome !== 'failed')
  ) {
    return undefined
  }
  return {
    accepted: root.accepted,
    relayId: root.relayId as string | null,
    relayKind: root.relayKind as EmailRelayKind | null,
    outcome: root.outcome,
  }
}

export function controlPlaneError(status: number, action: string): string {
  if (status === 400) {
    return `${action} was rejected because one or more fields are invalid.`
  }
  if (status === 403) {
    return `You do not have permission to ${action.toLowerCase()}.`
  }
  if (status === 404) {
    return `${action} could not find the requested delivery record.`
  }
  if (status === 409) {
    return `${action} conflicted with a delivery job that is currently leased or no longer eligible.`
  }
  if (status === 502) {
    return `${action} failed at the provider boundary. Check the redacted delivery log.`
  }
  if (status === 503) {
    return 'The email delivery subsystem is unavailable on this server.'
  }
  return `${action} failed. Check the server logs for the redacted diagnostic.`
}
