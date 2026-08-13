import { EmailQueueRedis, RedisEmailAttemptLog, RedisEmailDeliveryQueue } from './RedisEmailDeliveryQueue'
import { RedisEmailProfileRateLimiter } from './RedisEmailProfileRateLimiter'
import { EmailAttemptLog, QueuedEmail } from './Types'
import { EmailQueueCipher } from '@standardnotes/domain-core'

const ENCRYPTION_KEY = '33'.repeat(32)
const cipher = new EmailQueueCipher(ENCRYPTION_KEY)
const queueOptions = { encryptionKey: ENCRYPTION_KEY }

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

const encryptedJob = (value: QueuedEmail = job): string => cipher.encrypt(JSON.stringify(value))

const redisMock = (): jest.Mocked<EmailQueueRedis> =>
  ({
    eval: jest.fn(),
    zrange: jest.fn(),
    zrevrange: jest.fn(),
    hmget: jest.fn(),
    hget: jest.fn(),
    zscore: jest.fn(),
    waitaof: jest.fn().mockResolvedValue([1, 0]),
  }) as jest.Mocked<EmailQueueRedis>

describe('RedisEmailDeliveryQueue', () => {
  it('atomically persists a new job and keeps every script key in one cluster slot', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 10_000 })

    await queue.enqueue(job)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(keyCount).toBe(11)
    const keys = args.slice(0, 11).map(String)
    expect(keys).toHaveLength(11)
    expect(keys.every((key) => key.includes('{delivery}'))).toBe(true)
    expect(script).toContain("redis.call('HSET', KEYS[1]")
    expect(script).toContain("redis.call('ZADD', KEYS[2]")
    expect(keys[6]).toContain(':bytes')
    const serializedEnvelope = String(args[12])
    expect(JSON.parse(serializedEnvelope)).toEqual(
      expect.objectContaining({ v: 1, alg: 'A256GCM', ciphertext: expect.any(String) }),
    )
    expect(cipher.decrypt(serializedEnvelope)).toBe(JSON.stringify(job))
    expect(serializedEnvelope).not.toContain(job.message.to)
    expect(script).toContain("redis.call('SET', KEYS[7]")
    expect(script).toContain('projected_total > tonumber(ARGV[6])')
    expect(script.indexOf('projected_total > tonumber(ARGV[6])')).toBeLessThan(
      script.indexOf("redis.call('HDEL', KEYS[1], previous_id)"),
    )
  })

  it('accepts the canonical published-reminder queue source', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, queueOptions)
    const publishedReminderJob: QueuedEmail = { ...job, source: 'published-reminder' }

    await queue.enqueue(publishedReminderJob)

    const serializedEnvelope = String(redis.eval.mock.calls[0][14])
    expect(JSON.parse(cipher.decrypt(serializedEnvelope))).toEqual(publishedReminderJob)
  })

  it('claims with an expiring token and rejects stale settlements inside Lua', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(['job-1', encryptedJob()]).mockResolvedValueOnce(1)
    const queue = new RedisEmailDeliveryQueue(redis, {
      clock: () => 10_000,
      randomId: () => 'claim-token',
      leaseMs: 5_000,
      encryptionKey: ENCRYPTION_KEY,
    })

    const claim = await queue.claim()
    expect(claim).toEqual({ job, token: 'claim-token', leaseExpiresAt: 15_000 })
    const claimScript = redis.eval.mock.calls[0][0]
    expect(claimScript).toContain("redis.call('ZRANGEBYSCORE', KEYS[3]")
    expect(claimScript).toContain("redis.call('HSET', KEYS[6], id, ARGV[3])")

    await expect(queue.acknowledge(claim!)).resolves.toBe('settled')
    const settleScript = redis.eval.mock.calls[1][0]
    expect(settleScript).toContain("redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2]")
    expect(redis.eval.mock.calls[1]).toContain('claim-token')
  })

  it('purges expired payloads and tombstones with exact accounting even when cleanup batches are backlogged', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce([0]).mockResolvedValueOnce([500, 100, 500])
    redis.zrange.mockResolvedValueOnce([])
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000 })

    await expect(queue.claim()).resolves.toBeNull()
    await expect(queue.list('ready')).resolves.toEqual({ items: [] })

    const claimScript = redis.eval.mock.calls[0][0]
    const maintenanceScript = redis.eval.mock.calls[1][0]
    for (const script of [claimScript, maintenanceScript]) {
      expect(script).toContain('string.len(id) + string.len(record) + 128')
      expect(script).toContain("redis.call('HDEL', KEYS[9], id)")
      expect(script).toContain("redis.call('HDEL', KEYS[10], id)")
      expect(script).toContain("redis.call('ZREM', KEYS[11], id)")
      expect(script).toContain("if redis.call('HEXISTS', KEYS[1], id) == 0 then")
      expect(script).toContain('removed_bytes = removed_bytes + purge(id)')
    }
    expect(claimScript).toContain("local expires_at = redis.call('ZSCORE', KEYS[5], id)")
    expect(claimScript).toContain('tonumber(expires_at) <= tonumber(ARGV[1])')
    expect(claimScript).toContain("local payload = redis.call('HGET', KEYS[1], id)")
    expect(maintenanceScript).toContain("'LIMIT', 0, 500")
  })

  it('uses token-checked atomic retry and dead-letter transitions', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000 })
    const claim = { job, token: 'claim-token', leaseExpiresAt: 15_000 }
    const retry = { ...job, attempt: 1, nextAttemptAt: 30_000, lastFailureClass: 'network' }

    await expect(queue.retry(claim, retry)).resolves.toBe('settled')
    await expect(queue.deadLetter(claim, { ...retry, deadAt: 20_000 })).resolves.toBe('settled')

    expect(redis.eval.mock.calls[0][0]).toContain("ARGV[3] == 'retry'")
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('HSTRLEN', KEYS[1], ARGV[1])")
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('SET', KEYS[7], next_total)")
    expect(redis.eval.mock.calls[0]).toContain('retry')
    expect(redis.eval.mock.calls[1]).toContain('dead')
    expect(redis.eval.mock.calls[1]).toContain(20_000 + 30 * 24 * 60 * 60 * 1_000)
    expect(redis.eval.mock.calls[1][0]).toContain("redis.call('HSET', KEYS[10], ARGV[1], 'f:' .. fingerprint)")
  })

  it('keeps indefinite retries past max attempts and outside retention expiry', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000, retentionMs: 1_000 })
    const indefinite = { ...job, attempt: 6, maxAttempts: 5, retryMode: 'indefinite' as const, nextAttemptAt: 30_000 }
    const claim = { job: indefinite, token: 'claim-token', leaseExpiresAt: 25_000 }

    await expect(queue.retry(claim, indefinite)).resolves.toBe('settled')

    const retryCall = redis.eval.mock.calls[0]
    expect(retryCall).toContain('retry')
    expect(retryCall).toContain(0)
    expect(retryCall[0]).toContain('if tonumber(ARGV[6]) > 0 then')
    expect(retryCall[0]).toMatch(/redis\.call\('ZREM', KEYS\[5\], ARGV\[1\]\)/)
  })

  it('keeps bounded retry retention strictly after its next attempt', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000, retentionMs: 1_000 })
    const retry = { ...job, attempt: 1, nextAttemptAt: 30_000 }
    const claim = { job, token: 'claim-token', leaseExpiresAt: 25_000 }

    await queue.retry(claim, retry)

    expect(redis.eval.mock.calls[0]).toContain(31_000)
  })

  it('returns only a redacted queue projection for ready and leased jobs', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(0)
    redis.zrange.mockResolvedValue(['job-1', '12000'])
    redis.hmget.mockResolvedValue([encryptedJob()])
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 10_000 })

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

  it('keeps existing jobs visible when mutable queue policy changes', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    redis.zrange.mockResolvedValue(['job-1', '12000'])
    redis.hmget.mockResolvedValue([encryptedJob()])
    const oldPolicy = new RedisEmailDeliveryQueue(redis, { ...queueOptions, maxAttempts: 5, clock: () => 10_000 })
    const newPolicy = new RedisEmailDeliveryQueue(redis, { ...queueOptions, maxAttempts: 8, clock: () => 11_000 })

    await oldPolicy.enqueue(job)
    await expect(newPolicy.list('ready')).resolves.toEqual({
      items: [expect.objectContaining({ id: 'job-1', maxAttempts: 5, state: 'ready' })],
    })

    const enqueueKeys = redis.eval.mock.calls[0].slice(2, 13)
    const maintenanceKeys = redis.eval.mock.calls[1].slice(2, 13)
    expect(maintenanceKeys).toEqual(enqueueKeys)
  })

  it('keeps queue administration available with a redacted marker for an unreadable payload', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(0)
    redis.zrevrange.mockResolvedValue(['job-1', '12000'])
    redis.hmget.mockResolvedValue([encryptedJob()])
    const queue = new RedisEmailDeliveryQueue(redis, { encryptionKey: '44'.repeat(32) })

    await expect(queue.list('dead')).resolves.toEqual({
      items: [
        {
          id: 'job-1',
          state: 'dead',
          source: 'other',
          attempt: 0,
          maxAttempts: 1,
          createdAt: 0,
          lastFailureClass: 'payload-invalid',
        },
      ],
    })
  })

  it('requeues an existing non-leased job without exposing or returning its message', async () => {
    const redis = redisMock()
    redis.hget.mockResolvedValue(encryptedJob({ ...job, attempt: 5, deadAt: 11_000 }))
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000 })

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
    expect(redis.eval.mock.calls[0][0]).toContain('next_total > tonumber(ARGV[6])')
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('HSET', KEYS[10], ARGV[1], 'a:' .. fingerprint)")
  })

  it('rejects malformed cursors before reading queue contents', async () => {
    const redis = redisMock()
    const queue = new RedisEmailDeliveryQueue(redis, queueOptions)

    await expect(queue.list('ready', 50, Buffer.from('-1').toString('base64url'))).rejects.toThrow('cursor')
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it.each([
    [0, 'already exists'],
    [-1, 'per-job storage limit'],
    [-2, 'storage budget'],
  ] as const)('maps atomic enqueue rejection %s without changing a second key', async (code, reason) => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(code)
    const queue = new RedisEmailDeliveryQueue(redis, {
      ...queueOptions,
      maxJobBytes: 1_024,
      maxTotalBytes: 2_048,
    })

    await expect(queue.enqueue(job)).rejects.toThrow(reason)
    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(redis.eval.mock.calls[0][0]).toContain('return -1')
    expect(redis.eval.mock.calls[0][0]).toContain('return -2')
  })

  it('rejects aggregate content and envelope overflow before Redis access', async () => {
    const aggregateRedis = redisMock()
    const aggregateQueue = new RedisEmailDeliveryQueue(aggregateRedis, queueOptions)
    const aggregateJob = {
      ...job,
      message: {
        ...job.message,
        attachments: [
          { filename: 'one.bin', contentBase64: Buffer.alloc(11 * 1024 * 1024).toString('base64') },
          { filename: 'two.bin', contentBase64: Buffer.alloc(10 * 1024 * 1024).toString('base64') },
        ],
      },
    }

    await expect(aggregateQueue.enqueue(aggregateJob)).rejects.toThrow('aggregate content limit')
    expect(aggregateRedis.eval).not.toHaveBeenCalled()
    expect(aggregateRedis.waitaof).not.toHaveBeenCalled()

    const envelopeRedis = redisMock()
    const envelopeQueue = new RedisEmailDeliveryQueue(envelopeRedis, {
      ...queueOptions,
      maxJobBytes: 1_024,
      maxTotalBytes: 2_048,
    })
    await expect(envelopeQueue.enqueue({ ...job, message: { ...job.message, text: 'x'.repeat(900) } })).rejects.toThrow(
      'per-job storage limit',
    )
    expect(envelopeRedis.eval).not.toHaveBeenCalled()
    expect(envelopeRedis.waitaof).not.toHaveBeenCalled()
  })

  it('keeps budget accounting atomic across expiry, acknowledge, and discard without underflow', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, queueOptions)
    const claim = { job, token: 'claim-token', leaseExpiresAt: 15_000 }

    await queue.acknowledge(claim)
    await queue.discard(job.id)
    redis.eval.mockResolvedValueOnce(0)
    redis.zrange.mockResolvedValueOnce([])
    await queue.list('ready')

    const acknowledgeScript = redis.eval.mock.calls[0][0]
    const discardScript = redis.eval.mock.calls[1][0]
    const expiryScript = redis.eval.mock.calls[2][0]
    for (const script of [acknowledgeScript, discardScript, expiryScript]) {
      expect(script).toContain("redis.call('HSTRLEN', KEYS[1]")
      expect(script).toContain('if total_bytes < 0 then total_bytes = 0 end')
      expect(script).toContain("redis.call('SET', KEYS[7]")
    }
    expect(acknowledgeScript).toContain("redis.call('HSET', KEYS[10], ARGV[1], 's:' .. fingerprint)")
    expect(acknowledgeScript).toContain("redis.call('HDEL', KEYS[1], ARGV[1])")
    expect(acknowledgeScript).not.toContain("redis.call('HDEL', KEYS[10], ARGV[1])")
    expect(expiryScript).toContain('string.len(id) + string.len(record) + 128')
    expect(expiryScript).toContain("redis.call('HDEL', KEYS[10], id)")
  })

  it('atomically quarantines settlement growth that exceeds the budget instead of leaving a poison lease', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(2)
    const queue = new RedisEmailDeliveryQueue(redis, queueOptions)
    const claim = { job, token: 'claim-token', leaseExpiresAt: 15_000 }

    await expect(queue.retry(claim, { ...job, attempt: 1 })).resolves.toBe('quarantined')
    const retryScript = redis.eval.mock.calls[0][0]
    expect(retryScript).toContain("redis.call('ZADD', KEYS[4], ARGV[9], ARGV[1])")
    expect(retryScript).toContain("redis.call('HSET', KEYS[10], ARGV[1], 'q:' .. fingerprint)")
    expect(retryScript).toContain('return 2')

    redis.hget.mockResolvedValue(encryptedJob(job))
    redis.eval.mockResolvedValueOnce(-1)
    await expect(queue.requeue(job.id)).rejects.toThrow('per-job storage limit')
    const requeueScript = redis.eval.mock.calls[1][0]
    expect(requeueScript.indexOf('return -1')).toBeLessThan(requeueScript.indexOf("redis.call('HSET', KEYS[1]"))
  })

  it('fails closed on a wrong key or tampered encrypted queue payload', async () => {
    const redis = redisMock()
    const envelope = encryptedJob()
    redis.eval.mockResolvedValueOnce(['job-1', envelope]).mockResolvedValueOnce(1)
    const wrongKeyQueue = new RedisEmailDeliveryQueue(redis, { encryptionKey: '44'.repeat(32) })
    await expect(wrongKeyQueue.claim()).rejects.toThrow('payload was quarantined')

    const parsed = JSON.parse(envelope) as { ciphertext: string }
    parsed.ciphertext = (parsed.ciphertext[0] === 'A' ? 'B' : 'A') + parsed.ciphertext.slice(1)
    redis.eval.mockResolvedValueOnce(['job-1', JSON.stringify(parsed)]).mockResolvedValueOnce(1)
    const queue = new RedisEmailDeliveryQueue(redis, queueOptions)
    await expect(queue.claim()).rejects.toThrow('payload was quarantined')

    const quarantineCalls = redis.eval.mock.calls.filter(([script]) => String(script).includes('replacement_bytes'))
    expect(quarantineCalls).toHaveLength(0)
    const exactPreservationCalls = redis.eval.mock.calls.filter(([script]) =>
      String(script).includes('Keep the exact encrypted-at-rest value'),
    )
    expect(exactPreservationCalls).toHaveLength(2)
    for (const call of exactPreservationCalls) {
      expect(call[0]).toContain("redis.call('ZADD', KEYS[4]")
      expect(call[0]).toContain("redis.call('HSET', KEYS[10], ARGV[1], 'q:' .. fingerprint)")
      expect(call[0]).not.toContain("redis.call('HSET', KEYS[1]")
      expect(call[0]).not.toContain("redis.call('HDEL', KEYS[1]")
      expect(JSON.stringify(call)).not.toContain(job.message.to)
    }
  })

  it('renews only the current token owner and updates the claim expiry after atomic success', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000, leaseMs: 5_000 })
    const claim = { job, token: 'claim-token', leaseExpiresAt: 15_000 }

    await expect(queue.renewLease(claim)).resolves.toBe(true)
    expect(claim.leaseExpiresAt).toBe(25_000)
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2]")
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])")
    await expect(queue.renewLease({ ...claim, token: 'stale-token' })).resolves.toBe(false)
  })

  it('fences superseded claims and preserves a non-replayable status tombstone', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(2).mockResolvedValueOnce(3)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000 })
    const claim = { job, token: 'claim-token', leaseExpiresAt: 15_000 }

    await expect(queue.renewLease(claim)).resolves.toBe(false)
    await expect(queue.acknowledge(claim)).resolves.toBe('stale')

    for (const [script] of redis.eval.mock.calls) {
      expect(script).toContain("redis.call('HSET', KEYS[10], ARGV[1], 'x:' .. fingerprint)")
      expect(script).toContain("redis.call('HGET', KEYS[8], supersession_key) ~= ARGV[1]")
    }
  })

  it('atomically refuses admin discard while a worker owns the lease', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValueOnce(-1).mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const queue = new RedisEmailDeliveryQueue(redis, queueOptions)

    await expect(queue.discard('job-1')).resolves.toBe('leased')
    await expect(queue.discard('missing')).resolves.toBe('not-found')
    await expect(queue.discard('job-1')).resolves.toBe('discarded')
    expect(redis.eval.mock.calls[0][0].indexOf("redis.call('ZSCORE', KEYS[3]")).toBeLessThan(
      redis.eval.mock.calls[0][0].indexOf("redis.call('HDEL', KEYS[1]"),
    )
  })

  it('marks an operator-discarded delivery id as a non-replayable tombstone', async () => {
    const redis = redisMock()
    redis.eval.mockResolvedValue(1)
    const queue = new RedisEmailDeliveryQueue(redis, { ...queueOptions, clock: () => 20_000 })

    await expect(queue.discard('job-1')).resolves.toBe('discarded')

    const script = redis.eval.mock.calls[0][0]
    expect(script).toContain("redis.call('HSET', KEYS[10], ARGV[1], 'd:' .. fingerprint)")
    expect(script).toContain("redis.call('ZADD', KEYS[11], ARGV[2], ARGV[1])")
  })

  it('fails at construction without the existing stable encryption key', () => {
    expect(() => new RedisEmailDeliveryQueue(redisMock())).toThrow('32-byte hexadecimal')
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

  it('advances a filtered cursor only past records actually inspected', async () => {
    const redis = redisMock()
    const other = (id: string): EmailAttemptLog => ({
      ...entry,
      id,
      relayId: 'other-relay',
      outcome: 'permanent-failure',
    })
    const matching = (id: string): EmailAttemptLog => ({ ...entry, id })
    redis.zrevrange
      .mockResolvedValueOnce(['log-4', '10004', 'log-3', '10003', 'log-2', '10002'])
      .mockResolvedValueOnce(['log-2', '10002', 'log-1', '10001'])
      .mockResolvedValueOnce(['log-1', '10001'])
    redis.hmget
      .mockResolvedValueOnce([JSON.stringify(other('log-4')), JSON.stringify(matching('log-3'))])
      .mockResolvedValueOnce([JSON.stringify(matching('log-2')), JSON.stringify(matching('log-1'))])
      .mockResolvedValueOnce([JSON.stringify(matching('log-1'))])
    const logs = new RedisEmailAttemptLog(redis)

    const first = await logs.list(2, undefined, { relayId: 'relay-1', outcome: 'sent' })

    expect(first.items.map(({ id }) => id)).toEqual(['log-3', 'log-2'])
    expect(Buffer.from(first.nextCursor as string, 'base64url').toString('utf8')).toBe('3')
    const second = await logs.list(2, first.nextCursor, { relayId: 'relay-1', outcome: 'sent' })
    expect(second.items.map(({ id }) => id)).toEqual(['log-1'])
    expect(redis.zrevrange.mock.calls[2].slice(1, 3)).toEqual([3, 5])
  })

  it('skips a malformed log record without leaking or blocking later entries', async () => {
    const redis = redisMock()
    redis.zrevrange.mockResolvedValue(['corrupt', '10001', 'log-1', '10000'])
    redis.hmget.mockResolvedValue(['{"recipient":"private@example.com"}', JSON.stringify(entry)])
    const logs = new RedisEmailAttemptLog(redis)

    const page = await logs.list(10)

    expect(page.items).toEqual([entry])
    expect(JSON.stringify(page)).not.toContain('private@example.com')
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

  it('uses independent counters when an operator changes a profile policy', async () => {
    const redis = { eval: jest.fn().mockResolvedValue([1, 0]) }
    const limiter = new RedisEmailProfileRateLimiter(redis)

    await limiter.reserve('relay-1', { max: 100, windowSeconds: 86_400 })
    await limiter.reserve('relay-1', { max: 10, windowSeconds: 60 })

    expect(redis.eval.mock.calls[0][2]).not.toBe(redis.eval.mock.calls[1][2])
    expect(redis.eval.mock.calls[0][2]).toContain('{relay-1}')
    expect(redis.eval.mock.calls[1][2]).toContain('{relay-1}')
  })
})
