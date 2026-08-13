import { RoleName, isTrustedInsecureRelayHost, validateEmailRecipient } from '@standardnotes/domain-core'
import { Role } from '@standardnotes/security'
import { Request, Response } from 'express'

import {
  AdminEmailDeliveryService,
  AdminEmailDeliveryServiceError,
  EMAIL_DELIVERY_LOG_OUTCOMES,
  EMAIL_QUEUE_STATES,
  EmailDeliveryLogOutcome,
  EmailDeliveryLogPage,
  EmailDeliveryLogQuery,
  EmailDeliveryLogRecord,
  EmailDeliveryTestRecord,
  EmailQueuePage,
  EmailQueueQuery,
  EmailQueueRecord,
  EmailQueueState,
  EmailRelaySnapshot,
  EmailRelayUpdate,
  StoredEmailRelay,
} from '../../Service/EmailDelivery/AdminEmailDeliveryService'
import { EmailRelayWrite } from '../../Service/EmailDelivery/RelayConfiguration'
import { EMAIL_RELAY_KINDS, EmailRelayKind } from '../../Service/EmailDelivery/Types'

const MAX_RELAYS = 20
const MAX_NAME_LENGTH = 128
const MAX_ID_LENGTH = 128
const MAX_SECRET_LENGTH = 4_096
const MAX_CURSOR_LENGTH = 2_048
const MAX_PRIORITY = 100_000
const MAX_RATE_LIMIT = 1_000_000
const MAX_RATE_WINDOW_SECONDS = 2_592_000
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const AWS_REGION = /^(?:[a-z]{2}|us-gov)-[a-z]+-\d+$/

type JsonRecord = Record<string, unknown>
type ValidationResult<T> = { value: T } | { error: string }

type EmailRelayViewBase = {
  id: string
  name: string
  enabled: boolean
  priority: number
  from: string
  rateLimit: { max: number; windowSeconds: number }
  credentialsConfigured: boolean
}

export type EmailRelayView =
  | (EmailRelayViewBase & {
      kind: 'smtp'
      host: string
      port: number
      username?: string
      tlsMode: 'implicit' | 'starttls' | 'insecure'
    })
  | (EmailRelayViewBase & { kind: 'sendgrid' })
  | (EmailRelayViewBase & { kind: 'mailgun'; domain: string; baseUrl?: string })
  | (EmailRelayViewBase & { kind: 'aws-ses'; region: string })

export type EmailQueueItemView = Omit<
  EmailQueueRecord,
  | 'createdAt'
  | 'nextAttemptAt'
  | 'leaseExpiresAt'
  | 'expiresAt'
  | 'recipient'
  | 'subject'
  | 'body'
  | 'attachments'
  | 'rawProviderResponse'
> & {
  createdAt: string
  nextAttemptAt?: string
  leaseExpiresAt?: string
  expiresAt?: string
}

export type EmailDeliveryLogItemView = Omit<
  EmailDeliveryLogRecord,
  'createdAt' | 'recipient' | 'subject' | 'body' | 'attachments' | 'rawProviderResponse'
> & {
  createdAt: string
}

export type EmailDeliveryTestView = Pick<EmailDeliveryTestRecord, 'accepted' | 'relayId' | 'relayKind' | 'outcome'>

export interface AdminEmailDeliveryAuditLogger {
  info(message: string, metadata?: Record<string, unknown>): void
}

class InvalidServiceProjectionError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, allowed: readonly string[], required: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key))
}

function cleanRequiredString(value: unknown, field: string, maximum: number): ValidationResult<string> {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > maximum) {
    return { error: `${field} must be a non-empty string no longer than ${maximum} characters.` }
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return { error: `${field} must not contain control characters.` }
  }
  return { value }
}

function cleanOptionalString(value: unknown, field: string, maximum: number): ValidationResult<string | undefined> {
  if (value === undefined) {
    return { value: undefined }
  }
  return cleanRequiredString(value, field, maximum)
}

function cleanId(value: unknown, field: string): ValidationResult<string> {
  const parsed = cleanRequiredString(value, field, MAX_ID_LENGTH)
  if ('error' in parsed) {
    return parsed
  }
  if (!SAFE_ID.test(parsed.value)) {
    return { error: `${field} contains unsupported characters.` }
  }
  return parsed
}

function cleanSecret(value: unknown, field: string): ValidationResult<string | null | undefined> {
  if (value === undefined || value === null) {
    return { value }
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_LENGTH || value.includes('\u0000')) {
    return { error: `${field} must be omitted, null, or a non-empty string within the supported size limit.` }
  }
  return { value }
}

function cleanInteger(value: unknown, field: string, minimum: number, maximum: number): ValidationResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return { error: `${field} must be an integer between ${minimum} and ${maximum}.` }
  }
  return { value: value as number }
}

function cleanRelayBase(value: JsonRecord): ValidationResult<Omit<EmailRelayWrite, 'kind'> & { kind?: never }> {
  const id = cleanId(value.id, 'relay.id')
  if ('error' in id) {
    return id
  }
  const name = cleanRequiredString(value.name, 'relay.name', MAX_NAME_LENGTH)
  if ('error' in name) {
    return name
  }
  if (typeof value.enabled !== 'boolean') {
    return { error: 'relay.enabled must be a boolean.' }
  }
  const priority = cleanInteger(value.priority, 'relay.priority', 0, MAX_PRIORITY)
  if ('error' in priority) {
    return priority
  }
  const from = cleanRequiredString(value.from, 'relay.from', 998)
  if ('error' in from) {
    return from
  }
  if (!from.value.includes('@')) {
    return { error: 'relay.from must contain a valid sender identity.' }
  }
  if (
    !isRecord(value.rateLimit) ||
    !hasExactKeys(value.rateLimit, ['max', 'windowSeconds'], ['max', 'windowSeconds'])
  ) {
    return { error: 'relay.rateLimit must contain only max and windowSeconds.' }
  }
  const maximum = cleanInteger(value.rateLimit.max, 'relay.rateLimit.max', 0, MAX_RATE_LIMIT)
  if ('error' in maximum) {
    return maximum
  }
  const windowSeconds = cleanInteger(
    value.rateLimit.windowSeconds,
    'relay.rateLimit.windowSeconds',
    1,
    MAX_RATE_WINDOW_SECONDS,
  )
  if ('error' in windowSeconds) {
    return windowSeconds
  }

  return {
    value: {
      id: id.value,
      name: name.value,
      enabled: value.enabled,
      priority: priority.value,
      from: from.value,
      rateLimit: { max: maximum.value, windowSeconds: windowSeconds.value },
    } as Omit<EmailRelayWrite, 'kind'> & { kind?: never },
  }
}

function cleanSmtpHost(value: unknown): ValidationResult<string> {
  const parsed = cleanRequiredString(value, 'relay.host', 253)
  if ('error' in parsed) {
    return parsed
  }
  if (/\s|[/@?#]/.test(parsed.value) || parsed.value.includes('://')) {
    return { error: 'relay.host must be a hostname or IP address without a scheme or path.' }
  }
  return parsed
}

function cleanMailgunBaseUrl(value: unknown): ValidationResult<string | undefined> {
  const parsed = cleanOptionalString(value, 'relay.baseUrl', 2_048)
  if ('error' in parsed || parsed.value === undefined) {
    return parsed
  }
  try {
    const url = new URL(parsed.value)
    const canonical = url.toString().replace(/\/$/, '')
    if (!['https://api.mailgun.net', 'https://api.eu.mailgun.net'].includes(canonical)) {
      return { error: "relay.baseUrl must use Mailgun's official US or EU API origin." }
    }
  } catch {
    return { error: 'relay.baseUrl must be a valid HTTPS URL.' }
  }
  return parsed
}

function parseRelay(value: unknown): ValidationResult<EmailRelayWrite> {
  if (!isRecord(value) || typeof value.kind !== 'string' || !EMAIL_RELAY_KINDS.includes(value.kind as EmailRelayKind)) {
    return { error: 'Each relay must be an object with a supported kind.' }
  }

  const commonKeys = ['id', 'name', 'kind', 'enabled', 'priority', 'from', 'rateLimit']
  const base = cleanRelayBase(value)
  if ('error' in base) {
    return base
  }

  if (value.kind === 'smtp') {
    if (
      !hasExactKeys(
        value,
        [...commonKeys, 'host', 'port', 'username', 'password', 'tlsMode'],
        [...commonKeys, 'host', 'port', 'tlsMode'],
      )
    ) {
      return { error: 'SMTP relay contains missing or unsupported fields.' }
    }
    const host = cleanSmtpHost(value.host)
    if ('error' in host) {
      return host
    }
    const port = cleanInteger(value.port, 'relay.port', 1, 65_535)
    if ('error' in port) {
      return port
    }
    const username = cleanOptionalString(value.username, 'relay.username', 512)
    if ('error' in username) {
      return username
    }
    const password = cleanSecret(value.password, 'relay.password')
    if ('error' in password) {
      return password
    }
    if (value.tlsMode !== 'implicit' && value.tlsMode !== 'starttls' && value.tlsMode !== 'insecure') {
      return { error: 'relay.tlsMode must be implicit, starttls, or insecure.' }
    }
    if (value.tlsMode === 'insecure' && !isTrustedInsecureRelayHost(host.value)) {
      return { error: 'Insecure SMTP is allowed only for a loopback or private relay host.' }
    }
    return {
      value: {
        ...base.value,
        kind: 'smtp',
        host: host.value,
        port: port.value,
        ...(username.value !== undefined ? { username: username.value } : {}),
        ...(password.value !== undefined ? { password: password.value } : {}),
        tlsMode: value.tlsMode,
      },
    }
  }

  if (value.kind === 'sendgrid') {
    if (!hasExactKeys(value, [...commonKeys, 'apiKey'], commonKeys)) {
      return { error: 'SendGrid relay contains missing or unsupported fields.' }
    }
    const apiKey = cleanSecret(value.apiKey, 'relay.apiKey')
    if ('error' in apiKey) {
      return apiKey
    }
    return {
      value: {
        ...base.value,
        kind: 'sendgrid',
        ...(apiKey.value !== undefined ? { apiKey: apiKey.value } : {}),
      },
    }
  }

  if (value.kind === 'mailgun') {
    if (!hasExactKeys(value, [...commonKeys, 'domain', 'baseUrl', 'apiKey'], [...commonKeys, 'domain'])) {
      return { error: 'Mailgun relay contains missing or unsupported fields.' }
    }
    const domain = cleanRequiredString(value.domain, 'relay.domain', 253)
    if ('error' in domain) {
      return domain
    }
    if (/\s|[/@?#]/.test(domain.value) || domain.value.includes('://')) {
      return { error: 'relay.domain must be a domain name without a scheme or path.' }
    }
    const baseUrl = cleanMailgunBaseUrl(value.baseUrl)
    if ('error' in baseUrl) {
      return baseUrl
    }
    const apiKey = cleanSecret(value.apiKey, 'relay.apiKey')
    if ('error' in apiKey) {
      return apiKey
    }
    return {
      value: {
        ...base.value,
        kind: 'mailgun',
        domain: domain.value,
        ...(baseUrl.value !== undefined ? { baseUrl: baseUrl.value } : {}),
        ...(apiKey.value !== undefined ? { apiKey: apiKey.value } : {}),
      },
    }
  }

  if (
    !hasExactKeys(
      value,
      [...commonKeys, 'region', 'accessKeyId', 'secretAccessKey', 'sessionToken'],
      [...commonKeys, 'region'],
    )
  ) {
    return { error: 'Amazon SES relay contains missing or unsupported fields.' }
  }
  const region = cleanRequiredString(value.region, 'relay.region', 64)
  if ('error' in region) {
    return region
  }
  if (!AWS_REGION.test(region.value)) {
    return { error: 'relay.region must be a valid AWS region identifier.' }
  }
  const accessKeyId = cleanSecret(value.accessKeyId, 'relay.accessKeyId')
  if ('error' in accessKeyId) {
    return accessKeyId
  }
  const secretAccessKey = cleanSecret(value.secretAccessKey, 'relay.secretAccessKey')
  if ('error' in secretAccessKey) {
    return secretAccessKey
  }
  const sessionToken = cleanSecret(value.sessionToken, 'relay.sessionToken')
  if ('error' in sessionToken) {
    return sessionToken
  }
  return {
    value: {
      ...base.value,
      kind: 'aws-ses',
      region: region.value,
      ...(accessKeyId.value !== undefined ? { accessKeyId: accessKeyId.value } : {}),
      ...(secretAccessKey.value !== undefined ? { secretAccessKey: secretAccessKey.value } : {}),
      ...(sessionToken.value !== undefined ? { sessionToken: sessionToken.value } : {}),
    },
  }
}

function parseRelayUpdate(value: unknown): ValidationResult<EmailRelayUpdate> {
  if (!isRecord(value) || !hasExactKeys(value, ['relays', 'fallbackPolicy'], ['relays', 'fallbackPolicy'])) {
    return { error: 'Body must contain only relays and fallbackPolicy.' }
  }
  if (!Array.isArray(value.relays) || value.relays.length > MAX_RELAYS) {
    return { error: `relays must be an array containing at most ${MAX_RELAYS} profiles.` }
  }
  if (
    !isRecord(value.fallbackPolicy) ||
    !hasExactKeys(value.fallbackPolicy, ['mode'], ['mode']) ||
    (value.fallbackPolicy.mode !== 'next-enabled' && value.fallbackPolicy.mode !== 'none')
  ) {
    return { error: 'fallbackPolicy.mode must be next-enabled or none.' }
  }

  const relays: EmailRelayWrite[] = []
  const ids = new Set<string>()
  const priorities = new Set<number>()
  for (const candidate of value.relays) {
    const relay = parseRelay(candidate)
    if ('error' in relay) {
      return relay
    }
    if (ids.has(relay.value.id)) {
      return { error: 'Relay ids must be unique.' }
    }
    if (priorities.has(relay.value.priority)) {
      return { error: 'Relay priorities must be unique.' }
    }
    ids.add(relay.value.id)
    priorities.add(relay.value.priority)
    relays.push(relay.value)
  }

  return { value: { relays, fallbackPolicy: { mode: value.fallbackPolicy.mode } } }
}

function cleanCursor(value: unknown): ValidationResult<string | undefined> {
  if (value === undefined) {
    return { value: undefined }
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return { error: 'cursor must be a non-empty opaque string within the supported size limit.' }
  }
  return { value }
}

function queryValue(value: unknown, field: string): ValidationResult<string | undefined> {
  if (value === undefined || typeof value === 'string') {
    return { value }
  }
  return { error: `${field} must be provided at most once.` }
}

function parseLimit(value: unknown): ValidationResult<number> {
  if (value === undefined) {
    return { value: DEFAULT_PAGE_LIMIT }
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return { error: `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.` }
  }
  return cleanInteger(Number(value), 'limit', 1, MAX_PAGE_LIMIT)
}

function parseQueueQuery(value: unknown): ValidationResult<EmailQueueQuery> {
  if (!isRecord(value) || !hasExactKeys(value, ['state', 'limit', 'cursor'])) {
    return { error: 'Queue query contains unsupported parameters.' }
  }
  const state = queryValue(value.state, 'state')
  if ('error' in state) {
    return state
  }
  if (!state.value || !EMAIL_QUEUE_STATES.includes(state.value as EmailQueueState)) {
    return { error: 'state must be ready, leased, or dead.' }
  }
  const limitValue = queryValue(value.limit, 'limit')
  if ('error' in limitValue) {
    return limitValue
  }
  const limit = parseLimit(limitValue.value)
  if ('error' in limit) {
    return limit
  }
  const cursorValue = queryValue(value.cursor, 'cursor')
  if ('error' in cursorValue) {
    return cursorValue
  }
  const cursor = cleanCursor(cursorValue.value)
  if ('error' in cursor) {
    return cursor
  }
  return {
    value: {
      state: state.value as EmailQueueState,
      limit: limit.value,
      ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
    },
  }
}

function parseLogsQuery(value: unknown): ValidationResult<EmailDeliveryLogQuery> {
  if (!isRecord(value) || !hasExactKeys(value, ['limit', 'cursor', 'relayId', 'outcome'])) {
    return { error: 'Logs query contains unsupported parameters.' }
  }
  const limitValue = queryValue(value.limit, 'limit')
  if ('error' in limitValue) {
    return limitValue
  }
  const limit = parseLimit(limitValue.value)
  if ('error' in limit) {
    return limit
  }
  const cursorValue = queryValue(value.cursor, 'cursor')
  if ('error' in cursorValue) {
    return cursorValue
  }
  const cursor = cleanCursor(cursorValue.value)
  if ('error' in cursor) {
    return cursor
  }
  const relayIdValue = queryValue(value.relayId, 'relayId')
  if ('error' in relayIdValue) {
    return relayIdValue
  }
  let relayId: string | undefined
  if (relayIdValue.value !== undefined) {
    const parsedRelayId = cleanId(relayIdValue.value, 'relayId')
    if ('error' in parsedRelayId) {
      return parsedRelayId
    }
    relayId = parsedRelayId.value
  }
  const outcomeValue = queryValue(value.outcome, 'outcome')
  if ('error' in outcomeValue) {
    return outcomeValue
  }
  if (
    outcomeValue.value !== undefined &&
    !EMAIL_DELIVERY_LOG_OUTCOMES.includes(outcomeValue.value as EmailDeliveryLogOutcome)
  ) {
    return { error: 'outcome is not a supported delivery log outcome.' }
  }

  return {
    value: {
      limit: limit.value,
      ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
      ...(relayId !== undefined ? { relayId } : {}),
      ...(outcomeValue.value !== undefined ? { outcome: outcomeValue.value as EmailDeliveryLogOutcome } : {}),
    },
  }
}

function parseTestBody(value: unknown): ValidationResult<{ recipient: string; relayId?: string }> {
  if (!isRecord(value) || !hasExactKeys(value, ['recipient', 'relayId'], ['recipient'])) {
    return { error: 'Body must contain recipient and may contain relayId.' }
  }
  const recipient = validateEmailRecipient(value.recipient)
  if (!recipient) {
    return { error: 'A valid test recipient email address is required.' }
  }
  if (value.relayId === undefined) {
    return { value: { recipient } }
  }
  const relayId = cleanId(value.relayId, 'relayId')
  if ('error' in relayId) {
    return relayId
  }
  return { value: { recipient, relayId: relayId.value } }
}

function parseEmptyBody(value: unknown): ValidationResult<Record<string, never>> {
  if (value === undefined || (isRecord(value) && Object.keys(value).length === 0)) {
    return { value: {} }
  }
  return { error: 'Request body must be empty.' }
}

function exactSafeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined
}

function exactSafeId(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !SAFE_ID.test(value)) {
    throw new InvalidServiceProjectionError()
  }
  return value
}

function exactInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new InvalidServiceProjectionError()
  }
  return value as number
}

function epochToIso(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidServiceProjectionError()
  }
  const date = new Date(value as number)
  if (Number.isNaN(date.getTime())) {
    throw new InvalidServiceProjectionError()
  }
  return date.toISOString()
}

function projectRelay(relay: StoredEmailRelay): EmailRelayView {
  const common = {
    id: exactSafeId(relay.id),
    name: relay.name,
    kind: relay.kind,
    enabled: relay.enabled,
    priority: exactInteger(relay.priority, 0, MAX_PRIORITY),
    from: relay.from,
    rateLimit: {
      max: exactInteger(relay.rateLimit.max, 0, MAX_RATE_LIMIT),
      windowSeconds: exactInteger(relay.rateLimit.windowSeconds, 1, MAX_RATE_WINDOW_SECONDS),
    },
    credentialsConfigured: relay.credentialsConfigured === true,
  }
  if (relay.kind === 'smtp') {
    return {
      ...common,
      kind: 'smtp',
      host: relay.host,
      port: exactInteger(relay.port, 1, 65_535),
      ...(relay.username !== undefined ? { username: relay.username } : {}),
      tlsMode: relay.tlsMode,
    }
  }
  if (relay.kind === 'mailgun') {
    return {
      ...common,
      kind: 'mailgun',
      domain: relay.domain,
      ...(relay.baseUrl !== undefined ? { baseUrl: relay.baseUrl } : {}),
    }
  }
  if (relay.kind === 'aws-ses') {
    return { ...common, kind: 'aws-ses', region: relay.region }
  }
  if (relay.kind !== 'sendgrid') {
    throw new InvalidServiceProjectionError()
  }
  return { ...common, kind: 'sendgrid' }
}

function projectRelaySnapshot(snapshot: EmailRelaySnapshot): {
  relays: EmailRelayView[]
  fallbackPolicy: { mode: 'next-enabled' | 'none' }
  configured: boolean
} {
  if (snapshot.fallbackPolicy.mode !== 'next-enabled' && snapshot.fallbackPolicy.mode !== 'none') {
    throw new InvalidServiceProjectionError()
  }
  return {
    relays: snapshot.relays.map(projectRelay),
    fallbackPolicy: { mode: snapshot.fallbackPolicy.mode },
    configured: snapshot.configured === true,
  }
}

function projectQueueItem(item: EmailQueueRecord): EmailQueueItemView {
  if (!EMAIL_QUEUE_STATES.includes(item.state)) {
    throw new InvalidServiceProjectionError()
  }
  if (!['reminder', 'published-reminder', 'account', 'backup', 'test', 'other'].includes(item.source)) {
    throw new InvalidServiceProjectionError()
  }
  const lastRelayId = item.lastRelayId === undefined ? undefined : exactSafeId(item.lastRelayId)
  return {
    id: exactSafeId(item.id),
    state: item.state,
    source: item.source,
    attempt: exactInteger(item.attempt, 0),
    maxAttempts: exactInteger(item.maxAttempts, 1),
    createdAt: epochToIso(item.createdAt),
    ...(item.nextAttemptAt !== undefined ? { nextAttemptAt: epochToIso(item.nextAttemptAt) } : {}),
    ...(item.leaseExpiresAt !== undefined ? { leaseExpiresAt: epochToIso(item.leaseExpiresAt) } : {}),
    ...(item.expiresAt !== undefined ? { expiresAt: epochToIso(item.expiresAt) } : {}),
    ...(item.retryMode === 'bounded' || item.retryMode === 'indefinite' ? { retryMode: item.retryMode } : {}),
    ...(lastRelayId !== undefined ? { lastRelayId } : {}),
    ...(exactSafeCode(item.lastFailureClass) !== undefined
      ? { lastFailureClass: exactSafeCode(item.lastFailureClass) }
      : {}),
  }
}

function projectQueuePage(page: EmailQueuePage): { items: EmailQueueItemView[]; nextCursor?: string } {
  const cursor = cleanCursor(page.nextCursor)
  if ('error' in cursor) {
    throw new InvalidServiceProjectionError()
  }
  return {
    items: page.items.map(projectQueueItem),
    ...(cursor.value !== undefined ? { nextCursor: cursor.value } : {}),
  }
}

function projectLogItem(item: EmailDeliveryLogRecord): EmailDeliveryLogItemView {
  if (!EMAIL_RELAY_KINDS.includes(item.relayKind) || !EMAIL_DELIVERY_LOG_OUTCOMES.includes(item.outcome)) {
    throw new InvalidServiceProjectionError()
  }
  const failureClass = exactSafeCode(item.failureClass)
  const providerCode = exactSafeCode(item.providerCode)
  return {
    id: exactSafeId(item.id),
    jobId: exactSafeId(item.jobId),
    relayId: exactSafeId(item.relayId),
    relayKind: item.relayKind,
    attempt: exactInteger(item.attempt, 0),
    outcome: item.outcome,
    ...(failureClass !== undefined ? { failureClass } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(item.httpStatus !== undefined ? { httpStatus: exactInteger(item.httpStatus, 100, 599) } : {}),
    durationMs: exactInteger(item.durationMs, 0),
    createdAt: epochToIso(item.createdAt),
  }
}

function projectLogPage(page: EmailDeliveryLogPage): { items: EmailDeliveryLogItemView[]; nextCursor?: string } {
  const cursor = cleanCursor(page.nextCursor)
  if ('error' in cursor) {
    throw new InvalidServiceProjectionError()
  }
  return {
    items: page.items.map(projectLogItem),
    ...(cursor.value !== undefined ? { nextCursor: cursor.value } : {}),
  }
}

function projectTestResult(result: EmailDeliveryTestRecord): EmailDeliveryTestView {
  const outcomes = ['sent', 'rejected', 'rate-limited', 'unconfigured', 'failed'] as const
  if (
    !outcomes.includes(result.outcome) ||
    (result.relayKind !== null && !EMAIL_RELAY_KINDS.includes(result.relayKind))
  ) {
    throw new InvalidServiceProjectionError()
  }
  const relayId = result.relayId === null ? null : exactSafeId(result.relayId)
  return {
    accepted: result.accepted === true,
    relayId,
    relayKind: result.relayKind,
    outcome: result.outcome,
  }
}

/** HTTP-only boundary over a constructor-injected email delivery facade. */
export class AdminEmailDeliveryController {
  constructor(
    private readonly service?: AdminEmailDeliveryService,
    private readonly auditLogger?: AdminEmailDeliveryAuditLogger,
  ) {}

  async getRelays(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    if (Object.keys(request.query).length > 0) {
      return this.badRequest(response, 'Relay query must be empty.')
    }
    await this.execute(response, async () => response.json(projectRelaySnapshot(await service.getRelays())))
  }

  async putRelays(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    if (Object.keys(request.query).length > 0) {
      return this.badRequest(response, 'Relay query must be empty.')
    }
    const update = parseRelayUpdate(request.body)
    if ('error' in update) {
      return this.badRequest(response, update.error)
    }
    await this.execute(
      response,
      async () => response.json(projectRelaySnapshot(await service.putRelays(update.value))),
      'relays.update',
    )
  }

  async testDelivery(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    if (Object.keys(request.query).length > 0) {
      return this.badRequest(response, 'Test query must be empty.')
    }
    const test = parseTestBody(request.body)
    if ('error' in test) {
      return this.badRequest(response, test.error)
    }
    await this.execute(
      response,
      async () => response.json(projectTestResult(await service.testDelivery(test.value))),
      'test.send',
    )
  }

  async listQueue(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    const query = parseQueueQuery(request.query)
    if ('error' in query) {
      return this.badRequest(response, query.error)
    }
    await this.execute(response, async () => response.json(projectQueuePage(await service.listQueue(query.value))))
  }

  async listLogs(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    const query = parseLogsQuery(request.query)
    if ('error' in query) {
      return this.badRequest(response, query.error)
    }
    await this.execute(response, async () => response.json(projectLogPage(await service.listLogs(query.value))))
  }

  async retryQueueItem(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    const id = cleanId(request.params.id, 'id')
    if ('error' in id) {
      return this.badRequest(response, id.error)
    }
    if (Object.keys(request.query).length > 0) {
      return this.badRequest(response, 'Retry query must be empty.')
    }
    const body = parseEmptyBody(request.body)
    if ('error' in body) {
      return this.badRequest(response, body.error)
    }
    await this.execute(
      response,
      async () => response.status(202).json(projectQueueItem(await service.retryQueueItem(id.value))),
      'queue.retry',
    )
  }

  async discardQueueItem(request: Request, response: Response): Promise<void> {
    if (!this.authorize(response)) {
      return
    }
    const service = this.requireService(response)
    if (!service) {
      return
    }
    const id = cleanId(request.params.id, 'id')
    if ('error' in id) {
      return this.badRequest(response, id.error)
    }
    if (Object.keys(request.query).length > 0) {
      return this.badRequest(response, 'Discard query must be empty.')
    }
    const body = parseEmptyBody(request.body)
    if ('error' in body) {
      return this.badRequest(response, body.error)
    }
    await this.execute(
      response,
      async () => {
        await service.discardQueueItem(id.value)
        response.status(204).send()
      },
      'queue.discard',
    )
  }

  private authorize(response: Response): boolean {
    const locals = response.locals as { user?: { uuid?: unknown }; roles?: Role[] }
    if (typeof locals.user?.uuid !== 'string' || locals.user.uuid.length === 0) {
      response.status(401).json({ error: { message: 'Authentication required.' } })
      return false
    }
    if (!(locals.roles ?? []).some((role) => role.name === RoleName.NAMES.AdminUser)) {
      response.status(403).json({ error: { message: 'Admin role required.' } })
      return false
    }
    return true
  }

  private requireService(response: Response): AdminEmailDeliveryService | undefined {
    if (!this.service) {
      response.status(501).json({ error: { message: 'Advanced email delivery is not available in this topology.' } })
      return undefined
    }
    return this.service
  }

  private badRequest(response: Response, message: string): void {
    response.status(400).json({ error: { message } })
  }

  private async execute(
    response: Response,
    operation: () => Promise<unknown>,
    auditAction?: 'relays.update' | 'test.send' | 'queue.retry' | 'queue.discard',
  ): Promise<void> {
    try {
      await operation()
      this.audit(response, auditAction, 'accepted')
    } catch (error) {
      if (error instanceof AdminEmailDeliveryServiceError) {
        const mapping = {
          'bad-request': [400, 'The email delivery request was rejected.'],
          'not-found': [404, 'The requested email delivery record was not found.'],
          conflict: [409, 'The email delivery record is currently leased or no longer eligible.'],
          'rate-limited': [429, 'The email delivery operation is rate limited.'],
          'provider-failure': [502, 'The provider test failed. Check the redacted delivery log.'],
          unavailable: [503, 'The email delivery subsystem is unavailable.'],
        } as const
        const [status, message] = mapping[error.code]
        if (
          status === 429 &&
          Number.isSafeInteger(error.retryAfterSeconds) &&
          (error.retryAfterSeconds as number) > 0 &&
          (error.retryAfterSeconds as number) <= MAX_RATE_WINDOW_SECONDS
        ) {
          response.setHeader('Retry-After', String(error.retryAfterSeconds))
        }
        this.audit(response, auditAction, error.code)
        response.status(status).json({ error: { message } })
        return
      }
      this.audit(response, auditAction, 'unavailable')
      response.status(503).json({ error: { message: 'The email delivery subsystem is unavailable.' } })
    }
  }

  private audit(
    response: Response,
    action: 'relays.update' | 'test.send' | 'queue.retry' | 'queue.discard' | undefined,
    outcome: string,
  ): void {
    if (!action) {
      return
    }
    const adminUuid = (response.locals as { user?: { uuid?: unknown } }).user?.uuid
    this.auditLogger?.info('admin email delivery operation completed', {
      audit: 'admin.email-delivery.operation',
      adminUuid: typeof adminUuid === 'string' ? adminUuid : null,
      action,
      outcome,
    })
  }
}
