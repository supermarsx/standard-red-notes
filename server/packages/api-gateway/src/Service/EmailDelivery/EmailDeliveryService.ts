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
  leaseHeartbeatMs?: number
  attemptLogTimeoutMs?: number
  onAttemptLogFailure?: (reason: 'error' | 'timeout') => void
  allowSource?: (source: EmailDeliverySource) => boolean
}

export interface ProcessEmailResult {
  status: 'idle' | 'sent' | 'retry-scheduled' | 'dead-lettered' | 'quarantined' | 'stale'
  jobId?: string
}

export interface TestEmailResult {
  accepted: boolean
  relayId: string | null
  relayKind: EmailRelayKind | null
  outcome: 'sent' | 'rejected' | 'rate-limited' | 'unconfigured' | 'failed'
}

const SOURCES: EmailDeliverySource[] = ['reminder', 'published-reminder', 'account', 'backup', 'test', 'other']

export class EmailDeliveryService {
  private draining = false
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly jitterRatio: number
  private readonly clock: () => number
  private readonly random: () => number
  private readonly randomId: () => string
  private readonly leaseHeartbeatMs: number
  private readonly attemptLogTimeoutMs: number
  private readonly onAttemptLogFailure?: (reason: 'error' | 'timeout') => void
  private readonly allowSource: (source: EmailDeliverySource) => boolean

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
    this.leaseHeartbeatMs = boundedInteger(options.leaseHeartbeatMs, 30_000, 10, 5 * 60 * 1_000)
    this.attemptLogTimeoutMs = boundedInteger(options.attemptLogTimeoutMs, 1_000, 10, 30_000)
    this.onAttemptLogFailure = options.onAttemptLogFailure
    this.allowSource = options.allowSource ?? (() => true)
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

  /**
   * Prevent another provider attempt from starting while the process drains.
   * An already-started provider call remains bounded by its transport timeout;
   * the claim is then settled or returned to the ready queue before shutdown.
   */
  beginDrain(): void {
    this.draining = true
  }

  /** Re-enable provider attempts after a deliberately stopped worker restarts. */
  endDrain(): void {
    this.draining = false
  }

  async processOne(): Promise<ProcessEmailResult> {
    const claim = await this.queue.claim()
    if (!claim) {
      return { status: 'idle' }
    }
    const heartbeat = new QueueLeaseHeartbeat(this.queue, claim, this.leaseHeartbeatMs)
    if (!(await heartbeat.start())) {
      // A failed initial fence must not strand the claim for the full lease.
      // Return it atomically; a stale/superseded owner will simply reject the
      // settlement, while an infrastructure error remains retryable by expiry.
      await this.queue.retry(claim, claim.job).catch(() => 'stale' as const)
      return { status: 'stale', jobId: claim.job.id }
    }
    try {
      return await this.processClaim(claim, heartbeat)
    } finally {
      await heartbeat.stop()
    }
  }

  private async processClaim(claim: ClaimedEmail, heartbeat: QueueLeaseHeartbeat): Promise<ProcessEmailResult> {
    if (!this.allowSource(claim.job.source)) {
      return this.deadLetterDisabledSource(claim)
    }
    if (this.isExpired(claim.job)) {
      return this.expireClaim(claim)
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
      if (this.draining) {
        return this.scheduleFailure(claim, attempt, 'shutdown-drain', true, lastRelayId)
      }
      if (!heartbeat.isOwned()) {
        return { status: 'stale', jobId: claim.job.id }
      }
      lastRelayId = profile.id
      let decision
      try {
        decision = await this.rateLimiter.reserve(profile.id, profile.rateLimit)
      } catch {
        retryable = true
        lastFailureClass = 'rate-limit-unavailable'
        continue
      }
      if (!heartbeat.isOwned()) {
        return { status: 'stale', jobId: claim.job.id }
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

      if (this.isExpired(claim.job)) {
        return this.expireClaim(claim, attempt)
      }
      if (this.draining) {
        return this.scheduleFailure(claim, attempt, 'shutdown-drain', true, lastRelayId)
      }
      // Recheck the token directly at the provider boundary. Besides lease
      // ownership, Redis uses this fence to reject a security message that a
      // newer message in the same supersession stream replaced.
      if (!(await this.queue.renewLease(claim))) {
        return { status: 'stale', jobId: claim.job.id }
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
        return {
          status: acknowledged === 'settled' ? 'sent' : acknowledged === 'quarantined' ? 'quarantined' : 'stale',
          jobId: claim.job.id,
        }
      }
      if (result.outcome === 'permanent-failure') {
        // A permanent provider/recipient decision can represent suppression,
        // policy, or mailbox rejection. Trying another relay would bypass that
        // decision and damage sender reputation; fallback is for transient
        // transport/provider failures only.
        lastFailureClass = result.failureClass
        break
      }
      if (!heartbeat.isOwned()) {
        return { status: 'stale', jobId: claim.job.id }
      }
      lastFailureClass = result.failureClass
      retryable = true
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
      if (this.draining) {
        break
      }
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

  discard(id: string): ReturnType<EmailDeliveryQueue['discard']> {
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
    if (updated.retryMode === 'indefinite' || (retryable && attempt < updated.maxAttempts)) {
      updated.nextAttemptAt = now + Math.max(this.retryDelay(attempt), minimumDelayMs ?? 0)
      const scheduled = await this.queue.retry(claim, updated)
      return {
        status: scheduled === 'settled' ? 'retry-scheduled' : scheduled === 'quarantined' ? 'quarantined' : 'stale',
        jobId: updated.id,
      }
    }

    updated.deadAt = now
    const dead = await this.queue.deadLetter(claim, updated)
    return {
      status: dead === 'settled' ? 'dead-lettered' : dead === 'quarantined' ? 'quarantined' : 'stale',
      jobId: updated.id,
    }
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(30, Math.max(0, attempt - 1)))
    const centered = Math.max(0, Math.min(1, this.random())) * 2 - 1
    return Math.max(1_000, Math.round(exponential * (1 + centered * this.jitterRatio)))
  }

  private isExpired(job: QueuedEmail): boolean {
    return job.expiresAt !== undefined && job.expiresAt <= this.clock()
  }

  private async deadLetterDisabledSource(claim: ClaimedEmail): Promise<ProcessEmailResult> {
    const now = this.clock()
    const disabled = await this.queue.deadLetter(claim, {
      ...claim.job,
      nextAttemptAt: now,
      lastFailureClass: 'source-disabled',
      deadAt: now,
    })
    return {
      status: disabled === 'settled' ? 'dead-lettered' : disabled === 'quarantined' ? 'quarantined' : 'stale',
      jobId: claim.job.id,
    }
  }

  private async expireClaim(claim: ClaimedEmail, attempt = claim.job.attempt): Promise<ProcessEmailResult> {
    const now = this.clock()
    const expired = await this.queue.deadLetter(claim, {
      ...claim.job,
      attempt,
      nextAttemptAt: now,
      lastFailureClass: 'expired',
      deadAt: now,
    })
    return {
      status: expired === 'settled' ? 'dead-lettered' : expired === 'quarantined' ? 'quarantined' : 'stale',
      jobId: claim.job.id,
    }
  }

  private async record(entry: EmailAttemptLog): Promise<void> {
    let settled = false
    let reported = false
    const report = (reason: 'error' | 'timeout') => {
      if (reported) {
        return
      }
      reported = true
      try {
        this.onAttemptLogFailure?.(reason)
      } catch {
        // Operator telemetry must remain isolated from queue settlement.
      }
    }
    const write = this.attemptLogs.record(entry).then(
      () => {
        settled = true
      },
      () => {
        settled = true
        report('error')
      },
    )
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (!settled) {
          report('timeout')
        }
        resolve()
      }, this.attemptLogTimeoutMs)
      timer.unref?.()
    })

    // A rejected or stalled telemetry write must never delay acknowledgement
    // long enough for an accepted provider delivery to be leased and resent.
    await Promise.race([write, deadline])
    if (timer) {
      clearTimeout(timer)
    }
  }
}

class QueueLeaseHeartbeat {
  private timer: NodeJS.Timeout | undefined
  private owned = true
  private stopping = false
  private renewal: Promise<void> = Promise.resolve()

  constructor(
    private readonly queue: EmailDeliveryQueue,
    private readonly claim: ClaimedEmail,
    private readonly intervalMs: number,
  ) {}

  async start(): Promise<boolean> {
    this.owned = await this.renewOwned()
    if (!this.owned) {
      return false
    }
    this.timer = setInterval(() => {
      this.renewal = this.renewal.then(async () => {
        if (this.stopping || !this.owned) {
          return
        }
        this.owned = await this.renewOwned()
      })
    }, this.intervalMs)
    this.timer.unref?.()
    return true
  }

  isOwned(): boolean {
    return this.owned
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.renewal
  }

  private async renewOwned(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const timeoutMs = Math.max(10, Math.min(5_000, this.intervalMs))
    try {
      return await Promise.race([
        this.queue.renewLease(this.claim).catch(() => false),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
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
    ...(job.expiresAt !== undefined ? { expiresAt: job.expiresAt } : {}),
    ...(job.retryMode !== undefined ? { retryMode: job.retryMode } : {}),
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
