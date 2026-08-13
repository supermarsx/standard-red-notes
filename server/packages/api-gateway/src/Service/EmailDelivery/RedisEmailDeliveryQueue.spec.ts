import { EmailQueueRedis, RedisEmailAttemptLog, RedisEmailDeliveryQueue } from './RedisEmailDeliveryQueue'
import { RedisEmailProfileRateLimiter } from './RedisEmailProfileRateLimiter'
import { EmailAttemptLog, QueuedEmail } from './Types'

const job: QueuedEmail = {
  id: 'job-1',
  source: 'backup',
  message: {
    to: 'private@example.com',
    subject: 'Private subject',
    text: 'Private body',
    attachments: [{ filename: 'backup.zip', contentBase64: Buffer.from('private file').toString('base64') }],
  },
  attempt: 0,
  maxAttempts: 5,
  createdAt: 10_000,
  nextAttemptAt: 10_000,
}

const redisMock = (): jest.Mocked<EmailQueueRedis> =>
  ({
    eval: jest.fn(),
    zrange: jest.fn(),
    zrevrange: jest.fn(),
    hmget: jest.fn(),
    hget: jest.fn(),
    zscore: jest.fn(),
  }) as jest.Mocked<EmailQueueRedis>

describe('RedisEmailDeliveryQueue', () => {
  it('atomically persists a new job and keeps every script key in one cluster slot', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { clock: () => 10_000 })

    await queue.enqueue(job)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(keyCount).toBe(6)
    const keys = args.slice(0, 6).map(String)
    expect(keys).toHaveLength(6)
    expect(keys.every((key) => key.includes('{delivery}'))).toBe(true)
    expect(script).toContain("redis.call('HSET', KEYS[1]")
    expect(script).toContain("redis.call('ZADD', KEYS[2]")
    expect(args).toContain(JSON.stringify(job))
  })

  it('claims with an expiring token and rejects stale settlements inside Lua', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(['job-1', JSON.stringify(job)]).mockResolvedValueOnce(1)
    const queue = new RedisEmailDeliveryQueue(redis, {
      clock: () => 10_000,
      randomId: () => 'claim-token',
      leaseMs: 5_000,
    })

    const claim = await queue.claim()
    expect(claim).toEqual({ job, token: 'claim-token', leaseExpiresAt: 15_000 })
    const claimScript = redis.eval.mock.calls[0][0]
    expect(claimScript).toContain("redis.call('ZRANGEBYSCORE', KEYS[3]")
    expect(claimScript).toContain("redis.call('HSET', KEYS[6], id, ARGV[3])")

    await expect(queue.acknowledge(claim!)).resolves.toBe(true)
    const settleScript = redis.eval.mock.calls[1][0]
    expect(settleScript).toContain("redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2]")
    expect(redis.eval.mock.calls[1]).toContain('claim-token')
  })

  it('uses token-checked atomic retry and dead-letter transitions', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { clock: () => 20_000 })
    const claim = { job, token: 'claim-token', leaseExpiresAt: 15_000 }
    const retry = { ...job, attempt: 1, nextAttemptAt: 30_000, lastFailureClass: 'network' }

    await expect(queue.retry(claim, retry)).resolves.toBe(true)
    await expect(queue.deadLetter(claim, { ...retry, deadAt: 20_000 })).resolves.toBe(true)

    expect(redis.eval.mock.calls[0][0]).toContain("ARGV[3] == 'retry'")
    expect(redis.eval.mock.calls[0]).toContain('retry')
    expect(redis.eval.mock.calls[1]).toContain('dead')
    expect(redis.eval.mock.calls[1]).toContain(20_000 + 30 * 24 * 60 * 60 * 1_000)
  })

  it('returns only a redacted queue projection for ready and leased jobs', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(0)
    redis.zrange.mockResolvedValue(['job-1', '12000'])
    redis.hmget.mockResolvedValue([JSON.stringify(job)])
    const queue = new RedisEmailDeliveryQueue(redis, { clock: () => 10_000 })

    const page = await queue.list('ready')

    expect(page.items).toEqual([
      {
        id: 'job-1',
        state: 'ready',
        source: 'backup',
        attempt: 0,
        maxAttempts: 5,
        createdAt: 10_000,
        nextAttemptAt: 12_000,
      },
    ])
    const output = JSON.stringify(page)
    expect(output).not.toContain('private@example.com')
    expect(output).not.toContain('Private')
    expect(output).not.toContain('backup.zip')
  })

  it('requeues an existing non-leased job without exposing or returning its message', async () => {
    const redis = redisMock()
    redis.hget.mockResolvedValue(JSON.stringify({ ...job, attempt: 5, deadAt: 11_000 }))
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { clock: () => 20_000 })

    const view = await queue.requeue('job-1')

    expect(view).toEqual({
      id: 'job-1',
      state: 'ready',
      source: 'backup',
      attempt: 0,
      maxAttempts: 5,
      createdAt: 10_000,
      nextAttemptAt: 20_000,
    })
    expect(JSON.stringify(view)).not.toContain('private')
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('ZSCORE', KEYS[3]")
  })

  it('rejects malformed cursors before reading queue contents', async () => {
    const redis = redisMock()
    const queue = new RedisEmailDeliveryQueue(redis)

    await expect(queue.list('ready', 50, Buffer.from('-1').toString('base64url'))).rejects.toThrow('cursor')
    expect(redis.eval).not.toHaveBeenCalled()
  })
})

describe('RedisEmailAttemptLog', () => {
  const entry: EmailAttemptLog = {
    id: 'log-1',
    jobId: 'job-1',
    relayId: 'relay-1',
    relayKind: 'smtp',
    attempt: 1,
    outcome: 'sent',
    providerCode: 'SMTP_ACCEPTED',
    durationMs: 25,
    createdAt: 10_000,
  }

  it('atomically prunes retention and count bounds while storing only a redacted entry', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const logs = new RedisEmailAttemptLog(redis, { retentionMs: 1_000, maximumEntries: 100 })

    await logs.record(entry)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(keyCount).toBe(2)
    expect(script).toContain("redis.call('ZRANGEBYSCORE'")
    expect(script).toContain("redis.call('ZCARD'")
    expect(args).toContain(JSON.stringify(entry))
    expect(JSON.stringify(args)).not.toContain('private@example.com')
  })

  it('filters bounded log pages without adding any message fields', async () => {
    const redis = redisMock()
    const rejected = { ...entry, id: 'log-2', relayId: 'relay-2', outcome: 'permanent-failure' as const }
    redis.zrevrange.mockResolvedValueOnce(['log-2', '10001', 'log-1', '10000'])
    redis.hmget.mockResolvedValueOnce([JSON.stringify(rejected), JSON.stringify(entry)])
    const logs = new RedisEmailAttemptLog(redis)

    const page = await logs.list(10, undefined, { relayId: 'relay-1', outcome: 'sent' })

    expect(page.items).toEqual([entry])
    expect(JSON.stringify(page)).not.toContain('subject')
    expect(JSON.stringify(page)).not.toContain('recipient')
  })
})

describe('RedisEmailProfileRateLimiter', () => {
  it('uses one atomic reservation script and surfaces retry-after without over-counting', async () => {
    const redis = { eval: jest.fn().mockResolvedValue([0, 4_321]) }
    const limiter = new RedisEmailProfileRateLimiter(redis)

    await expect(limiter.reserve('relay-1', { max: 10, windowSeconds: 60 })).resolves.toEqual({
      allowed: false,
      retryAfterMs: 4_321,
    })
    const script = redis.eval.mock.calls[0][0]
    expect(script).toContain("redis.call('INCR'")
    expect(script).toContain("redis.call('DECR'")
    expect(redis.eval.mock.calls[0]).toContain(60_000)
  })

  it('bypasses Redis for an explicitly unlimited profile', async () => {
    const redis = { eval: jest.fn() }
    const limiter = new RedisEmailProfileRateLimiter(redis)

    await expect(limiter.reserve('relay-1', { max: 0, windowSeconds: 60 })).resolves.toEqual({
      allowed: true,
      retryAfterMs: 0,
    })
    expect(redis.eval).not.toHaveBeenCalled()
  })
})
