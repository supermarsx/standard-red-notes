import {
  EmailDeliveryConfig,
  EmailFallbackMode,
  EmailRelayProfile,
  EmailRelayView,
  SmtpRelayProfile,
  toRelayView,
  validateRelayProfile,
} from './Types'

const MAX_RELAYS = 20

type SecretPatch = string | null | undefined

interface RelayWriteBase {
  id: string
  name: string
  enabled: boolean
  priority: number
  from: string
  rateLimit: { max: number; windowSeconds: number }
}

export interface SmtpRelayWrite extends RelayWriteBase {
  kind: 'smtp'
  host: string
  port: number
  username?: string
  password?: SecretPatch
  tlsMode: SmtpRelayProfile['tlsMode']
}

export interface SendGridRelayWrite extends RelayWriteBase {
  kind: 'sendgrid'
  apiKey?: SecretPatch
}

export interface MailgunRelayWrite extends RelayWriteBase {
  kind: 'mailgun'
  domain: string
  baseUrl?: string
  apiKey?: SecretPatch
}

export interface AwsSesRelayWrite extends RelayWriteBase {
  kind: 'aws-ses'
  region: string
  accessKeyId?: SecretPatch
  secretAccessKey?: SecretPatch
  sessionToken?: SecretPatch
}

export type EmailRelayWrite = SmtpRelayWrite | SendGridRelayWrite | MailgunRelayWrite | AwsSesRelayWrite

export interface EmailRelayConfigurationView {
  relays: EmailRelayView[]
  fallbackPolicy: { mode: EmailFallbackMode }
  configured: boolean
}

export function mergeRelayConfiguration(
  input: { relays: EmailRelayWrite[]; fallbackPolicy: { mode: EmailFallbackMode } },
  existing: EmailDeliveryConfig | undefined,
): EmailDeliveryConfig {
  if (!Array.isArray(input.relays) || input.relays.length > MAX_RELAYS) {
    throw new Error(`Email delivery supports at most ${MAX_RELAYS} relay profiles.`)
  }
  if (!input.fallbackPolicy || !['next-enabled', 'none'].includes(input.fallbackPolicy.mode)) {
    throw new Error('Email relay fallback policy is invalid.')
  }
  const previous = new Map((existing?.relays ?? []).map((profile) => [profile.id, profile]))
  const relays = input.relays.map((write) => mergeRelay(write, previous.get(write.id)))
  const ids = new Set<string>()
  for (const relay of relays) {
    if (ids.has(relay.id)) {
      throw new Error('Email relay ids must be unique.')
    }
    ids.add(relay.id)
    validateRelayProfile(relay)
  }

  return { relays, fallbackPolicy: { mode: input.fallbackPolicy.mode } }
}

export function relayConfigurationView(config: EmailDeliveryConfig): EmailRelayConfigurationView {
  return {
    relays: config.relays
      .slice()
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
      .map(toRelayView),
    fallbackPolicy: { ...config.fallbackPolicy },
    configured: config.relays.some((relay) => relay.enabled),
  }
}

function mergeRelay(write: EmailRelayWrite, previous?: EmailRelayProfile): EmailRelayProfile {
  const common = {
    id: write.id,
    name: write.name,
    enabled: write.enabled,
    priority: write.priority,
    from: write.from,
    rateLimit: { ...write.rateLimit },
  }
  if (write.kind === 'smtp') {
    const old = previous?.kind === 'smtp' ? previous : undefined
    const username = normalizedOptional(write.username)
    const password = mergeSecret(write.password, old?.password)
    return {
      ...common,
      kind: 'smtp',
      host: write.host,
      port: write.port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      tlsMode: write.tlsMode,
    }
  }
  if (write.kind === 'sendgrid') {
    const old = previous?.kind === 'sendgrid' ? previous : undefined
    const apiKey = mergeSecret(write.apiKey, old?.apiKey)
    return { ...common, kind: 'sendgrid', ...(apiKey ? { apiKey } : {}) }
  }
  if (write.kind === 'mailgun') {
    const old = previous?.kind === 'mailgun' ? previous : undefined
    const baseUrl = normalizedOptional(write.baseUrl)
    const apiKey = mergeSecret(write.apiKey, old?.apiKey)
    return {
      ...common,
      kind: 'mailgun',
      domain: write.domain,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    }
  }
  const old = previous?.kind === 'aws-ses' ? previous : undefined
  const accessKeyId = mergeSecret(write.accessKeyId, old?.accessKeyId)
  const secretAccessKey = mergeSecret(write.secretAccessKey, old?.secretAccessKey)
  const sessionToken = mergeSecret(write.sessionToken, old?.sessionToken)
  return {
    ...common,
    kind: 'aws-ses',
    region: write.region,
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    ...(sessionToken ? { sessionToken } : {}),
  }
}

function mergeSecret(value: SecretPatch, previous: string | undefined): string | undefined {
  if (value === undefined) {
    return previous
  }
  if (value === null) {
    return undefined
  }
  if (!value || value.length > 4_096 || value.includes('\0')) {
    throw new Error('Email relay credential is invalid.')
  }
  return value
}

function normalizedOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
