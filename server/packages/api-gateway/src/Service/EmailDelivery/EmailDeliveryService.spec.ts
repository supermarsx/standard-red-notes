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
  QueueState,
} from './Types'
import { EmailDeliveryService } from './EmailDeliveryService'

class FakeQueue implements EmailDeliveryQueue {
  enqueued?: QueuedEmail
  claimValue: ClaimedEmail | null = null
  acknowledged = false
  retryJob?: QueuedEmail
  deadJob?: QueuedEmail
  settle = true

  async enqueue(job: QueuedEmail): Promise<void> {
    this.enqueued = job
  }
  async claim(): Promise<ClaimedEmail | null> {
    return this.claimValue
  }
  async acknowledge(): Promise<boolean> {
    this.acknowledged = true
    return this.settle
  }
  async retry(_claim: ClaimedEmail, job: QueuedEmail): Promise<boolean> {
    this.retryJob = job
    return this.settle
  }
  async deadLetter(_claim: ClaimedEmail, job: QueuedEmail): Promise<boolean> {
    this.deadJob = job
    return this.settle
  }
  async list(): Promise<Page<QueueItemView>> {
    return { items: [] }
  }
  async requeue(): Promise<QueueItemView | null> {
    return null
  }
  async discard(): Promise<boolean> {
    return false
  }
}

class FakeLogs implements EmailAttemptLogStore {
  entries: EmailAttemptLog[] = []
  fail = false

  async record(entry: EmailAttemptLog): Promise<void> {
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
  results = new Map<string, EmailRelayResult | Error>()
  calls: string[] = []

  create(profile: EmailRelayProfile): EmailRelay {
    return {
      send: async () => {
        this.calls.push(profile.id)
        const result = this.results.get(profile.id) ?? { outcome: 'sent' as const }
        if (result instanceof Error) {
          throw result
        }
        return result
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
  const build = (configSource: () => Promise<EmailDeliveryConfig> = async () => config()) => {
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

  it('dead-letters immediately after all relays permanently reject', async () => {
    const { service, queue, factory } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    factory.results.set('first', { outcome: 'permanent-failure', failureClass: 'provider-rejected' })
    factory.results.set('second', { outcome: 'permanent-failure', failureClass: 'recipient-rejected' })

    await expect(service.processOne()).resolves.toEqual({ status: 'dead-lettered', jobId: 'job-1' })

    expect(queue.deadJob).toEqual(
      expect.objectContaining({ attempt: 1, deadAt: 100_000, lastFailureClass: 'recipient-rejected' }),
    )
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

  it('returns stale when lease ownership was lost before acknowledgement', async () => {
    const { service, queue } = build()
    queue.claimValue = { job: job(), token: 'claim-token', leaseExpiresAt: 200_000 }
    queue.settle = false

    await expect(service.processOne()).resolves.toEqual({ status: 'stale', jobId: 'job-1' })
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
})
