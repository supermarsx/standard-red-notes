import { ServerSettingsResolver } from '../ServerSettings/ServerSettingsResolver'
import {
  AdminEmailDeliveryService,
  AdminEmailDeliveryServiceError,
  EmailDeliveryLogPage,
  EmailDeliveryLogQuery,
  EmailDeliveryTestRecord,
  EmailDeliveryTestRequest,
  EmailQueuePage,
  EmailQueueQuery,
  EmailQueueRecord,
  EmailQueueState,
  EmailRelaySnapshot,
  EmailRelayUpdate,
  StoredEmailRelay,
} from './AdminEmailDeliveryService'
import { EmailDeliveryService } from './EmailDeliveryService'
import { mergeRelayConfiguration } from './RelayConfiguration'
import { EmailRelayView, QueueItemView } from './Types'

const CLASSIFICATION_PAGE_SIZE = 100
const MAX_CLASSIFICATION_PAGES_PER_STATE = 10
const QUEUE_STATES: EmailQueueState[] = ['leased', 'dead', 'ready']

type LocatedQueueItem = EmailQueueState | 'indeterminate' | undefined

/**
 * Concrete bridge from the admin HTTP facade to the existing settings resolver
 * and delivery runtime. It owns no persistence or lifecycle; those dependencies
 * remain constructor supplied by the parent application.
 */
export class DefaultAdminEmailDeliveryService implements AdminEmailDeliveryService {
  constructor(
    private readonly settings: ServerSettingsResolver,
    private readonly delivery: EmailDeliveryService,
  ) {}

  async getRelays(): Promise<EmailRelaySnapshot> {
    try {
      return projectRelaySnapshot(await this.settings.viewEmailRelayConfiguration())
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }
  }

  async putRelays(update: EmailRelayUpdate): Promise<EmailRelaySnapshot> {
    let current
    try {
      current = await this.settings.resolveEmailRelayConfiguration()
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }

    try {
      // Validate and resolve write-only preserve/null semantics before the
      // persistence call. A later write failure is therefore infrastructure,
      // not a client validation error.
      mergeRelayConfiguration(update, current)
    } catch {
      throw new AdminEmailDeliveryServiceError('bad-request')
    }

    try {
      return projectRelaySnapshot(await this.settings.applyEmailRelayConfiguration(update))
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }
  }

  async testDelivery(request: EmailDeliveryTestRequest): Promise<EmailDeliveryTestRecord> {
    try {
      const result = await this.delivery.test(request.recipient, request.relayId)
      return {
        accepted: result.accepted,
        relayId: result.relayId,
        relayKind: result.relayKind,
        outcome: result.outcome,
      }
    } catch (error) {
      throw preserveOr(error, 'provider-failure')
    }
  }

  async listQueue(query: EmailQueueQuery): Promise<EmailQueuePage> {
    validateCursor(query.cursor, 'bad-request')
    try {
      const page = await this.delivery.listQueue(query.state, query.limit, query.cursor)
      validateCursor(page.nextCursor, 'unavailable')
      return {
        items: page.items.map(projectQueueItem),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }
  }

  async listLogs(query: EmailDeliveryLogQuery): Promise<EmailDeliveryLogPage> {
    validateCursor(query.cursor, 'bad-request')
    try {
      const page = await this.delivery.listLogs(query.limit, query.cursor, {
        ...(query.relayId !== undefined ? { relayId: query.relayId } : {}),
        ...(query.outcome !== undefined ? { outcome: query.outcome } : {}),
      })
      validateCursor(page.nextCursor, 'unavailable')
      return {
        items: page.items.map((entry) => ({
          id: entry.id,
          jobId: entry.jobId,
          relayId: entry.relayId,
          relayKind: entry.relayKind,
          attempt: entry.attempt,
          outcome: entry.outcome,
          ...(entry.failureClass !== undefined ? { failureClass: entry.failureClass } : {}),
          ...(entry.providerCode !== undefined ? { providerCode: entry.providerCode } : {}),
          ...(entry.httpStatus !== undefined ? { httpStatus: entry.httpStatus } : {}),
          durationMs: entry.durationMs,
          createdAt: entry.createdAt,
        })),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }
  }

  async retryQueueItem(id: string): Promise<EmailQueueRecord> {
    try {
      const retried = await this.delivery.requeue(id)
      if (retried) {
        return projectQueueItem(retried)
      }

      const state = await this.locateQueueItem(id)
      if (state === undefined) {
        throw new AdminEmailDeliveryServiceError('not-found')
      }
      throw new AdminEmailDeliveryServiceError('conflict')
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }
  }

  async discardQueueItem(id: string): Promise<void> {
    try {
      const result = await this.delivery.discard(id)
      if (result === 'not-found') {
        throw new AdminEmailDeliveryServiceError('not-found')
      }
      if (result === 'leased') {
        throw new AdminEmailDeliveryServiceError('conflict')
      }
    } catch (error) {
      throw preserveOr(error, 'unavailable')
    }
  }

  private async locateQueueItem(id: string): Promise<LocatedQueueItem> {
    for (const state of QUEUE_STATES) {
      let cursor: string | undefined
      for (let pageNumber = 0; pageNumber < MAX_CLASSIFICATION_PAGES_PER_STATE; pageNumber++) {
        const page = await this.delivery.listQueue(state, CLASSIFICATION_PAGE_SIZE, cursor)
        if (page.items.some((item) => item.id === id)) {
          return state
        }
        if (!page.nextCursor) {
          break
        }
        validateCursor(page.nextCursor, 'unavailable')
        cursor = page.nextCursor
        if (pageNumber === MAX_CLASSIFICATION_PAGES_PER_STATE - 1) {
          // Fail closed rather than falsely reporting 404 or mutating a job
          // beyond the bounded admin lookup window.
          return 'indeterminate'
        }
      }
    }
    return undefined
  }
}

function projectRelaySnapshot(view: {
  relays: EmailRelayView[]
  fallbackPolicy: { mode: 'next-enabled' | 'none' }
  configured: boolean
}): EmailRelaySnapshot {
  return {
    relays: view.relays.map(projectRelay),
    fallbackPolicy: { mode: view.fallbackPolicy.mode },
    configured: view.configured,
  }
}

function projectRelay(relay: EmailRelayView): StoredEmailRelay {
  const common = {
    id: relay.id,
    name: relay.name,
    enabled: relay.enabled,
    priority: relay.priority,
    from: relay.from,
    rateLimit: { max: relay.rateLimit.max, windowSeconds: relay.rateLimit.windowSeconds },
    credentialsConfigured: relay.credentialsConfigured,
  }
  if (relay.kind === 'smtp') {
    if (
      typeof relay.host !== 'string' ||
      typeof relay.port !== 'number' ||
      (relay.tlsMode !== 'implicit' && relay.tlsMode !== 'starttls' && relay.tlsMode !== 'insecure')
    ) {
      throw new AdminEmailDeliveryServiceError('unavailable')
    }
    return {
      ...common,
      kind: 'smtp',
      host: relay.host,
      port: relay.port,
      ...(relay.username !== undefined ? { username: relay.username } : {}),
      tlsMode: relay.tlsMode,
    }
  }
  if (relay.kind === 'mailgun') {
    if (typeof relay.domain !== 'string') {
      throw new AdminEmailDeliveryServiceError('unavailable')
    }
    return {
      ...common,
      kind: 'mailgun',
      domain: relay.domain,
      ...(relay.baseUrl !== undefined ? { baseUrl: relay.baseUrl } : {}),
    }
  }
  if (relay.kind === 'aws-ses') {
    if (typeof relay.region !== 'string') {
      throw new AdminEmailDeliveryServiceError('unavailable')
    }
    return { ...common, kind: 'aws-ses', region: relay.region }
  }
  return { ...common, kind: 'sendgrid' }
}

function projectQueueItem(item: QueueItemView): EmailQueueRecord {
  return {
    id: item.id,
    state: item.state,
    source: item.source,
    attempt: item.attempt,
    maxAttempts: item.maxAttempts,
    createdAt: item.createdAt,
    ...(item.nextAttemptAt !== undefined ? { nextAttemptAt: item.nextAttemptAt } : {}),
    ...(item.leaseExpiresAt !== undefined ? { leaseExpiresAt: item.leaseExpiresAt } : {}),
    ...(item.lastRelayId !== undefined ? { lastRelayId: item.lastRelayId } : {}),
    ...(item.lastFailureClass !== undefined ? { lastFailureClass: item.lastFailureClass } : {}),
    ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
    ...(item.retryMode !== undefined ? { retryMode: item.retryMode } : {}),
  }
}

function validateCursor(cursor: string | undefined, code: 'bad-request' | 'unavailable'): void {
  if (cursor === undefined) {
    return
  }
  let offset: number
  try {
    offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new AdminEmailDeliveryServiceError(code)
  }
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    Buffer.from(String(offset), 'utf8').toString('base64url') !== cursor
  ) {
    throw new AdminEmailDeliveryServiceError(code)
  }
}

function preserveOr(error: unknown, fallback: 'provider-failure' | 'unavailable'): AdminEmailDeliveryServiceError {
  return error instanceof AdminEmailDeliveryServiceError ? error : new AdminEmailDeliveryServiceError(fallback)
}
