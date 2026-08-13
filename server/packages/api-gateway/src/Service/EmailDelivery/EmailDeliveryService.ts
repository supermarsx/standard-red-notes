import { randomUUID } from 'crypto'

import {
  ClaimedEmail,
  EmailAttemptLog,
  EmailAttemptLogStore,
  EmailAttemptOutcome,
  EmailDeliveryConfig,
  EmailDeliveryQueue,
  EmailDeliverySource,
  EmailMessage,
  EmailProfileRateLimiter,
  EmailRelayFactory,
  EmailRelayKind,
  EmailRelayProfile,
  Page,
  QueuedEmail,
  QueueItemView,
  QueueState,
  orderedEnabledRelays,
  sanitizedProviderCode,
  validateEmailMessage,
} from './Types'

export interface EmailDeliveryServiceOptions {
  maxAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
  jitterRatio?: number
  clock?: () => number
  random?: () => number
  randomId?: () => string
}

export interface ProcessEmailResult {
  status: 'idle' | 'sent' | 'retry-scheduled' | 'dead-lettered' | 'stale'
  jobId?: string
}

export interface TestEmailResult {
  accepted: boolean
  relayId: string | null
  relayKind: EmailRelayKind | null
  outcome: 'sent' | 'rejected' | 'rate-limited' | 'unconfigured' | 'failed'
}

const SOURCES: EmailDeliverySource[] = ['reminder', 'account', 'backup', 'test', 'other']

export class EmailDeliveryService {
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly jitterRatio: number
  private readonly clock: () => number
  private readonly random: () => number
  private readonly randomId: () => string

  constructor(
    private readonly queue: EmailDeliveryQueue,
    private readonly attemptLogs: EmailAttemptLogStore,
    private readonly rateLimiter: EmailProfileRateLimiter,
    private readonly relayFactory: EmailRelayFactory,
    private readonly configSource: () => Promise<EmailDeliveryConfig>,
    options: EmailDeliveryServiceOptions = {},
  ) {
    this.maxAttempts = boundedInteger(options.maxAttempts, 5, 1, 100)
    this.retryBaseMs = boundedInteger(options.retryBaseMs, 30_000, 1_000, 24 * 60 * 60 * 1_000)
    this.retryMaxMs = boundedInteger(options.retryMaxMs, 6 * 60 * 60 * 1_000, 1_000, 7 * 24 * 60 * 60 * 1_000)
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new Error('Email retry maximum must be greater than or equal to its base.')
    }
    this.jitterRatio = options.jitterRatio ?? 0.2
    if (!Number.isFinite(this.jitterRatio) || this.jitterRatio < 0 || this.jitterRatio > 1) {
      throw new Error('Email retry jitter is invalid.')
    }
    this.clock = options.clock ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.randomId = options.randomId ?? (() => randomUUID())
  }

  async enqueue(message: EmailMessage, source: EmailDeliverySource = 'other'): Promise<QueueItemView> {
    if (!SOURCES.includes(source)) {
      throw new Error('Email delivery source is invalid.')
    }
    const now = this.clock()
    const job: QueuedEmail = {
      id: this.randomId(),
      source,
      message: validateEmailMessage(message),
      attempt: 0,
      maxAttempts: this.maxAttempts,
      createdAt: now,
      nextAttemptAt: now,
    }
    await this.queue.enqueue(job)

    return publicJob(job, 'ready')
  }

  async processOne(): Promise<ProcessEmailResult> {
    const claim = await this.queue.claim()
    if (!claim) {
      return { status: 'idle' }
    }
    const attempt = claim.job.attempt + 1
    let config: EmailDeliveryConfig
    try {
      config = await this.configSource()
    } catch {
      return this.scheduleFailure(claim, attempt, 'configuration-unavailable', true)
    }

    let profiles: EmailRelayProfile[]
    try {
      profiles = orderedEnabledRelays(config)
    } catch {
      return this.scheduleFailure(claim, attempt, 'configuration-invalid', false)
    }
    if (profiles.length === 0) {
      return this.scheduleFailure(claim, attempt, 'unconfigured', true)
    }
    if (config.fallbackPolicy.mode === 'none') {
      profiles = profiles.slice(0, 1)
    }

    let retryable = false
    let lastRelayId: string | undefined
    let lastFailureClass = 'provider-rejected'
    let minimumRateDelay = Number.POSITIVE_INFINITY
    for (const profile of profiles) {
      lastRelayId = profile.id
      let decision
      try {
        decision = await this.rateLimiter.reserve(profile.id, profile.rateLimit)
      } catch {
        retryable = true
        lastFailureClass = 'rate-limit-unavailable'
        continue
      }
      if (!decision.allowed) {
        retryable = true
        lastFailureClass = 'rate-limited'
        minimumRateDelay = Math.min(minimumRateDelay, decision.retryAfterMs)
        await this.record({
          id: this.randomId(),
          jobId: claim.job.id,
          relayId: profile.id,
          relayKind: profile.kind,
          attempt,
          outcome: 'rate-limited',
          failureClass: 'profile-rate-limit',
          durationMs: 0,
          createdAt: this.clock(),
        })
        continue
      }

      const startedAt = this.clock()
      let result
      try {
        result = await this.relayFactory.create(profile).send(claim.job.message)
      } catch {
        result = { outcome: 'transient-failure' as const, failureClass: 'adapter-failure' }
      }
      const completedAt = this.clock()
      const outcome: EmailAttemptOutcome = result.outcome
      await this.record({
        id: this.randomId(),
        jobId: claim.job.id,
        relayId: profile.id,
        relayKind: profile.kind,
        attempt,
        outcome,
        ...(result.outcome !== 'sent' ? { failureClass: result.failureClass } : {}),
        ...(sanitizedProviderCode(result.providerCode)
          ? { providerCode: sanitizedProviderCode(result.providerCode) }
          : {}),
        ...(validHttpStatus(result.httpStatus) ? { httpStatus: result.httpStatus } : {}),
        durationMs: Math.max(0, completedAt - startedAt),
        createdAt: completedAt,
      })

      if (result.outcome === 'sent') {
        const acknowledged = await this.queue.acknowledge(claim)
        return { status: acknowledged ? 'sent' : 'stale', jobId: claim.job.id }
      }
      lastFailureClass = result.failureClass
      retryable ||= result.outcome === 'transient-failure'
    }

    return this.scheduleFailure(
      claim,
      attempt,
      lastFailureClass,
      retryable,
      lastRelayId,
      Number.isFinite(minimumRateDelay) ? minimumRateDelay : undefined,
    )
  }

  async test(recipient: string, relayId?: string): Promise<TestEmailResult> {
    const message = validateEmailMessage({
      to: recipient,
      subject: 'Standard Red Notes email delivery test',
      text: 'This message confirms that your Standard Red Notes server can deliver email using its configured relay.',
    })
    let profiles: EmailRelayProfile[]
    let config: EmailDeliveryConfig
    try {
      config = await this.configSource()
      profiles = orderedEnabledRelays(config)
    } catch {
      return { accepted: false, relayId: null, relayKind: null, outcome: 'unconfigured' }
    }
    if (relayId) {
      profiles = profiles.filter((profile) => profile.id === relayId)
    } else if (config.fallbackPolicy.mode === 'none') {
      profiles = profiles.slice(0, 1)
    }
    if (profiles.length === 0) {
      return { accepted: false, relayId: null, relayKind: null, outcome: 'unconfigured' }
    }

    const jobId = `test-${this.randomId()}`
    let last: EmailRelayProfile | undefined
    let finalOutcome: TestEmailResult['outcome'] = 'failed'
    for (const profile of profiles) {
      last = profile
      let decision
      try {
        decision = await this.rateLimiter.reserve(profile.id, profile.rateLimit)
      } catch {
        finalOutcome = 'failed'
        continue
      }
      if (!decision.allowed) {
        finalOutcome = 'rate-limited'
        await this.record({
          id: this.randomId(),
          jobId,
          relayId: profile.id,
          relayKind: profile.kind,
          attempt: 1,
          outcome: 'rate-limited',
          failureClass: 'profile-rate-limit',
          durationMs: 0,
          createdAt: this.clock(),
        })
        continue
      }

      const startedAt = this.clock()
      let result
      try {
        result = await this.relayFactory.create(profile).send(message)
      } catch {
        result = { outcome: 'transient-failure' as const, failureClass: 'adapter-failure' }
      }
      const completedAt = this.clock()
      await this.record({
        id: this.randomId(),
        jobId,
        relayId: profile.id,
        relayKind: profile.kind,
        attempt: 1,
        outcome: result.outcome,
        ...(result.outcome !== 'sent' ? { failureClass: result.failureClass } : {}),
        ...(sanitizedProviderCode(result.providerCode)
          ? { providerCode: sanitizedProviderCode(result.providerCode) }
          : {}),
        ...(validHttpStatus(result.httpStatus) ? { httpStatus: result.httpStatus } : {}),
        durationMs: Math.max(0, completedAt - startedAt),
        createdAt: completedAt,
      })
      if (result.outcome === 'sent') {
        return { accepted: true, relayId: profile.id, relayKind: profile.kind, outcome: 'sent' }
      }
      finalOutcome = result.outcome === 'permanent-failure' ? 'rejected' : 'failed'
    }

    return {
      accepted: false,
      relayId: last?.id ?? null,
      relayKind: last?.kind ?? null,
      outcome: finalOutcome,
    }
  }

  listQueue(state: QueueState, limit?: number, cursor?: string): Promise<Page<QueueItemView>> {
    return this.queue.list(state, limit, cursor)
  }

  listLogs(
    limit?: number,
    cursor?: string,
    query?: { relayId?: string; outcome?: EmailAttemptOutcome },
  ): ReturnType<EmailAttemptLogStore['list']> {
    return this.attemptLogs.list(limit, cursor, query)
  }

  requeue(id: string): Promise<QueueItemView | null> {
    return this.queue.requeue(id)
  }

  discard(id: string): Promise<boolean> {
    return this.queue.discard(id)
  }

  private async scheduleFailure(
    claim: ClaimedEmail,
    attempt: number,
    failureClass: string,
    retryable: boolean,
    lastRelayId?: string,
    minimumDelayMs?: number,
  ): Promise<ProcessEmailResult> {
    const now = this.clock()
    const updated: QueuedEmail = {
      ...claim.job,
      attempt,
      lastFailureClass: failureClass,
      ...(lastRelayId ? { lastRelayId } : {}),
      nextAttemptAt: now,
    }
    if (retryable && attempt < updated.maxAttempts) {
      updated.nextAttemptAt = now + Math.max(this.retryDelay(attempt), minimumDelayMs ?? 0)
      const scheduled = await this.queue.retry(claim, updated)
      return { status: scheduled ? 'retry-scheduled' : 'stale', jobId: updated.id }
    }

    updated.deadAt = now
    const dead = await this.queue.deadLetter(claim, updated)
    return { status: dead ? 'dead-lettered' : 'stale', jobId: updated.id }
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, attempt - 1))
    const centered = Math.max(0, Math.min(1, this.random())) * 2 - 1
    return Math.max(1_000, Math.round(exponential * (1 + centered * this.jitterRatio)))
  }

  private async record(entry: EmailAttemptLog): Promise<void> {
    try {
      await this.attemptLogs.record(entry)
    } catch {
      // Attempt telemetry must never turn an accepted email into a duplicate.
    }
  }
}

function publicJob(job: QueuedEmail, state: QueueState): QueueItemView {
  return {
    id: job.id,
    state,
    source: job.source,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    ...(state === 'ready' ? { nextAttemptAt: job.nextAttemptAt } : {}),
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Email delivery service options are invalid.')
  }
  return value
}

function validHttpStatus(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 100 && value <= 599
}
