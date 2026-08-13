import { readFileSync } from 'fs'
import * as path from 'path'

import {
  ClaimedEmail,
  EmailAttemptLog,
  EmailAttemptLogStore,
  EmailDeliveryConfig,
  EmailDeliveryQueue,
  EmailProfileRateLimiter,
  EmailRelay,
  EmailRelayFactory,
  EmailRelayProfile,
  EmailRelayResult,
  Page,
  QueuedEmail,
  QueueItemView,
  QueueSettlementResult,
  QueueState,
} from './Types'
import { EmailDeliveryService, EmailDeliveryServiceOptions } from './EmailDeliveryService'

class FakeQueue implements EmailDeliveryQueue {
  enqueued?: QueuedEmail
  claimValue: ClaimedEmail | null = null
  acknowledged = false
  retryJob?: QueuedEmail
  deadJob?: QueuedEmail
  settlement: QueueSettlementResult = 'settled'
  renew = true
  renewResults: boolean[] = []
  renewals = 0

  async enqueue(job: QueuedEmail): Promise<void> {
    this.enqueued = job
  }
  async claim(): Promise<ClaimedEmail | null> {
    return this.claimValue
  }
  async renewLease(): Promise<boolean> {
    this.renewals += 1
    return this.renewResults.shift() ?? this.renew
  }
  async acknowledge(): Promise<QueueSettlementResult> {
    this.acknowledged = true
    return this.settlement
  }
  async retry(_claim: ClaimedEmail, job: QueuedEmail): Promise<QueueSettlementResult> {
    this.retryJob = job
    return this.settlement
  }
  async deadLetter(_claim: ClaimedEmail, job: QueuedEmail): Promise<QueueSettlementResult> {
    this.deadJob = job
    return this.settlement
  }
  async list(): Promise<Page<QueueItemView>> {
    return { items: [] }
  }
  async requeue(): Promise<QueueItemView | null> {
    return null
  }
  async discard(): Promise<'not-found'> {
    return 'not-found'
  }
}

class FakeLogs implements EmailAttemptLogStore {
  entries: EmailAttemptLog[] = []
  fail = false
  hang = false

  async record(entry: EmailAttemptLog): Promise<void> {
    if (this.hang) {
      await new Promise<void>(() => undefined)
    }
    if (this.fail) {
      throw new Error('redis down')
    }
    this.entries.push(entry)
  }
  async list(): Promise<Page<EmailAttemptLog>> {
    return { items: this.entries }
  }
}

class FakeLimiter implements EmailProfileRateLimiter {
  decisions = new Map<string, { allowed: boolean; retryAfterMs: number }>()

  async reserve(profileId: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
    return this.decisions.get(profileId) ?? { allowed: true, retryAfterMs: 0 }
  }
}

class FakeFactory implements EmailRelayFactory {
  results = new Map<string, EmailRelayResult | Error | Promise<EmailRelayResult>>()
  calls: string[] = []

  create(profile: EmailRelayProfile): EmailRelay {
    return {
      send: async () => {
        this.calls.push(profile.id)
        const result = this.results.get(profile.id) ?? { outcome: 'sent' as const }
        if (result instanceof Error) {
          throw result
        }
        return await result
      },
    }
  }
}

const relay = (id: string, priority: number): EmailRelayProfile => ({
  id,
  name: id,
  kind: 'sendgrid',
  enabled: true,
  priority,
  from: 'sender@example.com',
  rateLimit: { max: 100, windowSeconds: 60 },
  apiKey: `secret-${id}`,
})

const message = {
  to: 'private-recipient@example.com',
  subject: 'Private subject',
  text: 'Private body',
}

const job = (): QueuedEmail => ({
  id: 'job-1',
  source: 'account',
  message,
  attempt: 0,
  maxAttempts: 3,
  createdAt: 100_000,
  nextAttemptAt: 100_000,
})

const config = (mode: 'next-enabled' | 'none' = 'next-enabled'): EmailDeliveryConfig => ({
  relays: [relay('second', 20), relay('first', 10)],
  fallbackPolicy: { mode },
})

describe('EmailDeliveryService', () => {
  const build = (
    configSource: () => Promise<EmailDeliveryConfig> = async () => config(),
    options: EmailDeliveryServiceOptions = {},
  ) => {
    const queue = new FakeQueue()
    const logs = new FakeLogs()
    const limiter = new FakeLimiter()
    const factory = new FakeFactory()
    let id = 0
    const service = new EmailDeliveryService(queue, logs, limiter, factory, configSource, {
      clock: () => 100_000,
      random: () => 0.5,
      randomId: () => `generated-${++id}`,
      retryBaseMs: 1_000,
      retryMaxMs: 10_000,
      jitterRatio: 0,
      ...options,
    })
    return { service, queue, logs, limiter, factory }
  }

  it('enqueues a validated message while returning a PII-free queue view', async () => {
    const { service, queue } = build()

    const view = await service.enqueue(message, 'account')

    expect(queue.enqueued?.message).toEqual(message)
    expect(view).toEqual({
      id: 'generated-1',
      state: 'ready',
      source: 'account',
      attempt: 0,
      maxAttempts: 5,
      createdAt: 100_000,
      nextAttemptAt: 100_000,
    })
    expect(JSON.stringify(view)).not.toContain('private-recipient')
    expect(JSON.stringify(view)).not.toContain('Private')
  })

  it('tries enabled relays in priority order and acknowledges after fallback succeeds', async () => {
    const { service, queue, logs, factory } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    factory.results.set('first', {
      outcome: 'transient-failure',
      failureClass: 'network',
      providerCode: 'ECONNRESET',
    })
    factory.results.set('second', { outcome: 'sent', providerCode: 'HTTP_202', httpStatus: 202 })

    await expect(service.processOne()).resolves.toEqual({ status: 'sent', jobId: 'job-1' })

    expect(factory.calls).toEqual(['first', 'second'])
    expect(queue.acknowledged).toBe(true)
    expect(logs.entries.map((entry) => entry.outcome)).toEqual(['transient-failure', 'sent'])
    const serializedLogs = JSON.stringify(logs.entries)
    expect(serializedLogs).not.toContain('private-recipient')
    expect(serializedLogs).not.toContain('Private subject')
    expect(serializedLogs).not.toContain('secret-first')
  })

  it('honors a no-fallback policy and schedules transient failures with exponential delay', async () => {
    const { service, queue, factory } = build(async () => config('none'))
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    factory.results.set('first', { outcome: 'transient-failure', failureClass: 'timeout' })

    await expect(service.processOne()).resolves.toEqual({ status: 'retry-scheduled', jobId: 'job-1' })

    expect(factory.calls).toEqual(['first'])
    expect(queue.retryJob).toEqual(
      expect.objectContaining({
        attempt: 1,
        nextAttemptAt: 101_000,
        lastRelayId: 'first',
        lastFailureClass: 'timeout',
      }),
    )
  })

  it('dead-letters after the first permanent rejection without invoking a lower-priority relay', async () => {
    const { service, queue, logs, factory } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    factory.results.set('first', { outcome: 'permanent-failure', failureClass: 'provider-rejected' })
    factory.results.set('second', { outcome: 'sent' })

    await expect(service.processOne()).resolves.toEqual({ status: 'dead-lettered', jobId: 'job-1' })

    expect(factory.calls).toEqual(['first'])
    expect(logs.entries.map((entry) => entry.outcome)).toEqual(['permanent-failure'])
    expect(queue.acknowledged).toBe(false)
    expect(queue.deadJob).toEqual(
      expect.objectContaining({
        attempt: 1,
        deadAt: 100_000,
        lastRelayId: 'first',
        lastFailureClass: 'provider-rejected',
      }),
    )
  })

  it('dead-letters expired security mail without contacting a relay', async () => {
    const { service, queue, factory } = build()
    queue.claimValue = {
      job: { ...job(), expiresAt: 99_999 },
      token: 'claim-token',
      leaseExpiresAt: 200_000,
    }

    await expect(service.processOne()).resolves.toEqual({ status: 'dead-lettered', jobId: 'job-1' })
    expect(factory.calls).toEqual([])
    expect(queue.deadJob).toEqual(expect.objectContaining({ lastFailureClass: 'expired', deadAt: 100_000 }))
  })

  it('dead-letters disabled published reminders before configuration, rate limiting, or relay delivery', async () => {
    const configSource = jest.fn(async () => config())
    const allowSource = jest.fn((source: QueuedEmail['source']) => source !== 'published-reminder')
    const { service, queue, logs, limiter, factory } = build(configSource, { allowSource })
    const reserve = jest.spyOn(limiter, 'reserve')
    queue.claimValue = {
      job: { ...job(), source: 'published-reminder' },
      token: 'claim-token',
      leaseExpiresAt: 200_000,
    }

    await expect(service.processOne()).resolves.toEqual({ status: 'dead-lettered', jobId: 'job-1' })

    expect(allowSource).toHaveBeenCalledWith('published-reminder')
    expect(configSource).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(factory.calls).toEqual([])
    expect(logs.entries).toEqual([])
    expect(queue.acknowledged).toBe(false)
    expect(queue.retryJob).toBeUndefined()
    expect(queue.deadJob).toEqual(
      expect.objectContaining({
        source: 'published-reminder',
        attempt: 0,
        nextAttemptAt: 100_000,
        lastFailureClass: 'source-disabled',
        deadAt: 100_000,
      }),
    )
  })

  it('still sends ordinary auth reminder jobs when published reminders are disabled', async () => {
    const configSource = jest.fn(async () => config('none'))
    const allowSource = jest.fn((source: QueuedEmail['source']) => source !== 'published-reminder')
    const { service, queue, limiter, factory } = build(configSource, { allowSource })
    const reserve = jest.spyOn(limiter, 'reserve')
    queue.claimValue = {
      job: { ...job(), source: 'reminder' },
      token: 'claim-token',
      leaseExpiresAt: 200_000,
    }

    await expect(service.processOne()).resolves.toEqual({ status: 'sent', jobId: 'job-1' })

    expect(allowSource).toHaveBeenCalledWith('reminder')
    expect(configSource).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(factory.calls).toEqual(['first'])
    expect(queue.acknowledged).toBe(true)
    expect(queue.deadJob).toBeUndefined()
  })

  it('keeps transiently failing critical mail retryable beyond the normal attempt cap', async () => {
    const { service, queue, factory } = build(async () => config('none'))
    queue.claimValue = {
      job: { ...job(), attempt: 3, maxAttempts: 3, retryMode: 'indefinite' },
      token: 'claim-token',
      leaseExpiresAt: 200_000,
    }
    factory.results.set('first', { outcome: 'transient-failure', failureClass: 'timeout' })

    await expect(service.processOne()).resolves.toEqual({ status: 'retry-scheduled', jobId: 'job-1' })
    expect(queue.retryJob).toEqual(expect.objectContaining({ attempt: 4, retryMode: 'indefinite' }))
    expect(queue.deadJob).toBeUndefined()
  })

  it('keeps permanently rejected critical mail retryable for operator recovery', async () => {
    const { service, queue, factory } = build(async () => config('none'))
    queue.claimValue = {
      job: { ...job(), attempt: 3, maxAttempts: 3, retryMode: 'indefinite' },
      token: 'claim-token',
      leaseExpiresAt: 200_000,
    }
    factory.results.set('first', { outcome: 'permanent-failure', failureClass: 'provider-rejected' })

    await expect(service.processOne()).resolves.toEqual({ status: 'retry-scheduled', jobId: 'job-1' })
    expect(queue.retryJob).toEqual(expect.objectContaining({ attempt: 4, retryMode: 'indefinite' }))
    expect(queue.deadJob).toBeUndefined()
  })

  it('stops failover during drain and safely returns the owned claim to ready', async () => {
    const { service, queue, factory } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    let fail!: (result: EmailRelayResult) => void
    factory.results.set('first', new Promise<EmailRelayResult>((resolve) => (fail = resolve)))

    const processing = service.processOne()
    for (let index = 0; index < 20 && factory.calls.length === 0; index++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(factory.calls).toEqual(['first'])
    service.beginDrain()
    fail({ outcome: 'transient-failure', failureClass: 'timeout' })

    await expect(processing).resolves.toEqual({ status: 'retry-scheduled', jobId: 'job-1' })
    expect(queue.retryJob).toEqual(
      expect.objectContaining({ attempt: 1, lastFailureClass: 'shutdown-drain', lastRelayId: 'first' }),
    )
  })

  it('resumes provider delivery after a deliberate drain is ended', async () => {
    const { service, queue, factory } = build(async () => config('none'))
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    factory.results.set('first', { outcome: 'sent' })

    service.beginDrain()
    service.endDrain()

    await expect(service.processOne()).resolves.toEqual({ status: 'sent', jobId: 'job-1' })
    expect(factory.calls).toEqual(['first'])
    expect(queue.acknowledged).toBe(true)
  })

  it('falls through a rate-limited relay and records no recipient in its attempt log', async () => {
    const { service, queue, logs, limiter, factory } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    limiter.decisions.set('first', { allowed: false, retryAfterMs: 8_000 })
    factory.results.set('second', { outcome: 'sent' })

    await expect(service.processOne()).resolves.toEqual({ status: 'sent', jobId: 'job-1' })

    expect(factory.calls).toEqual(['second'])
    expect(logs.entries[0]).toEqual(expect.objectContaining({ relayId: 'first', outcome: 'rate-limited' }))
    expect(JSON.stringify(logs.entries[0])).not.toContain(message.to)
  })

  it('uses the limiter retry-after when every relay is throttled', async () => {
    const { service, queue, limiter } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    limiter.decisions.set('first', { allowed: false, retryAfterMs: 10_000 })
    limiter.decisions.set('second', { allowed: false, retryAfterMs: 7_000 })

    await expect(service.processOne()).resolves.toEqual({ status: 'retry-scheduled', jobId: 'job-1' })
    expect(queue.retryJob?.nextAttemptAt).toBe(107_000)
  })

  it('keeps an accepted send acknowledged when durable attempt logging is unavailable', async () => {
    const { service, queue, logs } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    logs.fail = true

    await expect(service.processOne()).resolves.toEqual({ status: 'sent', jobId: 'job-1' })
    expect(queue.acknowledged).toBe(true)
  })

  it('acknowledges an accepted send when durable attempt logging never settles', async () => {
    jest.useFakeTimers()
    try {
      const onAttemptLogFailure = jest.fn()
      const { service, queue, logs } = build(async () => config(), {
        attemptLogTimeoutMs: 10,
        onAttemptLogFailure,
      })
      queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
      logs.hang = true

      const processing = service.processOne()
      await jest.advanceTimersByTimeAsync(11)

      await expect(processing).resolves.toEqual({ status: 'sent', jobId: 'job-1' })
      expect(queue.acknowledged).toBe(true)
      expect(onAttemptLogFailure).toHaveBeenCalledWith('timeout')
    } finally {
      jest.useRealTimers()
    }
  })

  it('returns stale when lease ownership was lost before acknowledgement', async () => {
    const { service, queue } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    queue.settlement = 'stale'

    await expect(service.processOne()).resolves.toEqual({ status: 'stale', jobId: 'job-1' })
  })

  it('returns an initially unfenceable claim to ready instead of stranding its lease', async () => {
    const { service, queue, factory } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    queue.renewResults = [false]

    await expect(service.processOne()).resolves.toEqual({ status: 'stale', jobId: 'job-1' })
    expect(factory.calls).toEqual([])
    expect(queue.retryJob).toEqual(job())
  })

  it('renews the owned queue lease throughout a slow provider send and drains the heartbeat', async () => {
    jest.useFakeTimers()
    try {
      const { service, queue, factory } = build(async () => config(), { leaseHeartbeatMs: 10 })
      queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
      let accept!: (result: EmailRelayResult) => void
      factory.results.set('first', new Promise<EmailRelayResult>((resolve) => (accept = resolve)))

      const processing = service.processOne()
      await jest.advanceTimersByTimeAsync(35)
      expect(queue.renewals).toBeGreaterThanOrEqual(4)

      accept({ outcome: 'sent' })
      await expect(processing).resolves.toEqual({ status: 'sent', jobId: 'job-1' })
      const drainedRenewals = queue.renewals
      await jest.advanceTimersByTimeAsync(50)
      expect(queue.renewals).toBe(drainedRenewals)
    } finally {
      jest.useRealTimers()
    }
  })

  it('stops failover and settlement after the ownership heartbeat loses its lease', async () => {
    jest.useFakeTimers()
    try {
      const { service, queue, factory } = build(async () => config(), { leaseHeartbeatMs: 10 })
      queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
      queue.renewResults = [true, true, false]
      let fail!: (result: EmailRelayResult) => void
      factory.results.set('first', new Promise<EmailRelayResult>((resolve) => (fail = resolve)))

      const processing = service.processOne()
      await jest.advanceTimersByTimeAsync(15)
      fail({ outcome: 'transient-failure', failureClass: 'timeout' })

      await expect(processing).resolves.toEqual({ status: 'stale', jobId: 'job-1' })
      expect(factory.calls).toEqual(['first'])
      expect(queue.retryJob).toBeUndefined()
      expect(queue.acknowledged).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('surfaces an atomic storage-budget quarantine instead of leaving the job leased', async () => {
    const { service, queue, factory } = build(async () => config('none'))
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    queue.settlement = 'quarantined'
    factory.results.set('first', { outcome: 'transient-failure', failureClass: 'timeout' })

    await expect(service.processOne()).resolves.toEqual({ status: 'quarantined', jobId: 'job-1' })
    expect(queue.retryJob).toBeDefined()
  })

  it('runs a direct test through fallback without echoing its recipient', async () => {
    const { service, factory, logs } = build()
    factory.results.set('first', { outcome: 'transient-failure', failureClass: 'network' })
    factory.results.set('second', { outcome: 'sent' })

    const result = await service.test('private-recipient@example.com')

    expect(result).toEqual({ accepted: true, relayId: 'second', relayKind: 'sendgrid', outcome: 'sent' })
    expect(JSON.stringify(result)).not.toContain('private-recipient')
    expect(JSON.stringify(logs.entries)).not.toContain('private-recipient')
  })

  it('rejects invalid message headers before queue persistence', async () => {
    const { service, queue } = build()

    await expect(service.enqueue({ ...message, subject: 'safe\r\nBcc: attacker@example.com' })).rejects.toThrow(
      'subject',
    )
    expect(queue.enqueued).toBeUndefined()
  })

  it('passes queue list arguments through for the admin projection', async () => {
    const { service, queue } = build()
    const spy = jest.spyOn(queue, 'list')

    await service.listQueue('dead' as QueueState, 12, 'cursor')

    expect(spy).toHaveBeenCalledWith('dead', 12, 'cursor')
  })

  it('wires one constant reminder master gate into the advanced worker source policy', () => {
    const containerSource = readFileSync(path.resolve(__dirname, '../../Bootstrap/Container.ts'), 'utf8')
    const gateDeclaration = containerSource.indexOf('const reminderDeliveryEnabled =')
    const serviceConstruction = containerSource.indexOf('advancedEmailDeliveryService = new EmailDeliveryService')
    const sourcePolicy = containerSource.indexOf(
      "allowSource: (source) => source !== 'published-reminder' || reminderDeliveryEnabled,",
      serviceConstruction,
    )
    const registryConstruction = containerSource.indexOf('const reminderRegistry = new ProviderRegistry')

    expect(gateDeclaration).toBeGreaterThanOrEqual(0)
    expect(gateDeclaration).toBeLessThan(serviceConstruction)
    expect(sourcePolicy).toBeGreaterThan(serviceConstruction)
    expect(sourcePolicy).toBeLessThan(registryConstruction)
    expect(containerSource.match(/env\.get\('REMINDER_DELIVERY_ENABLED'/g)).toHaveLength(1)
  })
})
