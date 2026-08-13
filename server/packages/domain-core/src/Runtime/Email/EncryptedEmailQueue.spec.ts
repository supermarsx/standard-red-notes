import {
  confirmEmailQueueAofPersistence,
  decryptEmailQueuePayload,
  EMAIL_QUEUE_DEFAULT_KEY_PREFIX,
  EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
  EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
  EMAIL_QUEUE_DEFAULT_RETENTION_MS,
  EMAIL_QUEUE_ENVELOPE_CONTEXT,
  EMAIL_QUEUE_PROTOCOL_CONTEXT,
  EMAIL_QUEUE_WORKER_READINESS_VALUE,
  EmailQueueCipher,
  EmailQueueJob,
  EmailQueueMessage,
  emailQueueCompatibilityIdentity,
  emailQueueCompatibleKeyPrefix,
  emailQueueRedisKeys,
  emailQueueWorkerReadinessKey,
  emailQueueWorkerReadinessValue,
  emailQueueSupersessionIdentity,
  encryptEmailQueuePayload,
  isRedisClusterTopology,
  RedisEncryptedEmailQueueProducer,
  RedisEncryptedEmailQueueProducerOptions,
  validateEmailQueueJob,
  validateEmailQueueMessage,
  validateEmailQueueProducerLimits,
} from './EncryptedEmailQueue'

const SECRET = 'a'.repeat(64)
const COMPAT_PREFIX = emailQueueCompatibleKeyPrefix(SECRET)
const MAX_TIMESTAMP = 8_640_000_000_000_000

function message(overrides: Partial<EmailQueueMessage> = {}): EmailQueueMessage {
  return {
    to: 'private@example.com',
    subject: 'Private subject',
    text: 'Private body',
    ...overrides,
  }
}

function job(overrides: Partial<EmailQueueJob> = {}): EmailQueueJob {
  return {
    id: 'job-1',
    source: 'account',
    message: message(),
    attempt: 0,
    maxAttempts: 5,
    createdAt: 10_000,
    nextAttemptAt: 10_000,
    ...overrides,
  }
}

function asMessage(value: unknown): EmailQueueMessage {
  return value as EmailQueueMessage
}

function asJob(value: unknown): EmailQueueJob {
  return value as EmailQueueJob
}

describe('encrypted email delivery queue wire contract', () => {
  it('authenticates ciphertext, supports the cipher wrapper, and rejects the wrong key', () => {
    const plaintext = JSON.stringify({ to: 'private@example.com', body: 'private body' })
    const cipher = new EmailQueueCipher(SECRET)
    const encrypted = cipher.encrypt(plaintext)

    expect(EMAIL_QUEUE_ENVELOPE_CONTEXT).toBe('standard-red-notes/email-delivery-queue/v1')
    expect(encrypted).not.toContain('private@example.com')
    expect(encrypted).not.toContain('private body')
    expect(JSON.parse(encrypted)).toEqual({
      v: 1,
      alg: 'A256GCM',
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    })
    expect(cipher.decrypt(encrypted)).toBe(plaintext)
    expect(decryptEmailQueuePayload(encrypted, SECRET)).toBe(plaintext)
    expect(() => decryptEmailQueuePayload(encrypted, 'b'.repeat(64))).toThrow(
      'Email queue payload authentication failed.',
    )
  })

  it('round trips an empty authenticated payload', () => {
    expect(decryptEmailQueuePayload(encryptEmailQueuePayload('', SECRET), SECRET)).toBe('')
  })

  it.each([undefined, null, 42, {}, 'short', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
    'rejects invalid stable encryption secret %p',
    (invalidSecret) => {
      expect(() => new EmailQueueCipher(invalidSecret as string)).toThrow(
        'A 32-byte hexadecimal stable server encryption secret is required for the email queue.',
      )
    },
  )

  it('rejects a non-string plaintext', () => {
    expect(() => encryptEmailQueuePayload(asMessage({}) as unknown as string, SECRET)).toThrow(
      'Email queue payload must be a string.',
    )
  })

  it.each([
    ['invalid JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['wrong version', JSON.stringify({ v: 2, alg: 'A256GCM', iv: '', tag: '', ciphertext: '' })],
    ['wrong algorithm', JSON.stringify({ v: 1, alg: 'AES', iv: '', tag: '', ciphertext: '' })],
    ['non-string iv', JSON.stringify({ v: 1, alg: 'A256GCM', iv: 1, tag: '', ciphertext: '' })],
    ['non-string tag', JSON.stringify({ v: 1, alg: 'A256GCM', iv: '', tag: 1, ciphertext: '' })],
    ['non-string ciphertext', JSON.stringify({ v: 1, alg: 'A256GCM', iv: '', tag: '', ciphertext: 1 })],
    ['unexpected property', JSON.stringify({ v: 1, alg: 'A256GCM', iv: '', tag: '', ciphertext: '', secret: 'leak' })],
    ['invalid iv alphabet', JSON.stringify({ v: 1, alg: 'A256GCM', iv: '+', tag: '', ciphertext: '' })],
    ['wrong iv length', JSON.stringify({ v: 1, alg: 'A256GCM', iv: '', tag: '', ciphertext: '' })],
    ['non-canonical iv', JSON.stringify({ v: 1, alg: 'A256GCM', iv: 'A', tag: '', ciphertext: '' })],
    [
      'wrong tag length',
      JSON.stringify({ v: 1, alg: 'A256GCM', iv: Buffer.alloc(12).toString('base64url'), tag: '', ciphertext: '' }),
    ],
    [
      'invalid tag alphabet',
      JSON.stringify({
        v: 1,
        alg: 'A256GCM',
        iv: Buffer.alloc(12).toString('base64url'),
        tag: '+',
        ciphertext: '',
      }),
    ],
    [
      'invalid ciphertext alphabet',
      JSON.stringify({
        v: 1,
        alg: 'A256GCM',
        iv: Buffer.alloc(12).toString('base64url'),
        tag: Buffer.alloc(16).toString('base64url'),
        ciphertext: '+',
      }),
    ],
    [
      'non-canonical ciphertext',
      JSON.stringify({
        v: 1,
        alg: 'A256GCM',
        iv: Buffer.alloc(12).toString('base64url'),
        tag: Buffer.alloc(16).toString('base64url'),
        ciphertext: 'A',
      }),
    ],
  ])('maps a malformed %s envelope to one authentication error', (_name, envelope) => {
    expect(() => decryptEmailQueuePayload(envelope, SECRET)).toThrow('Email queue payload authentication failed.')
  })

  it('rejects authenticated-envelope tampering', () => {
    const envelope = JSON.parse(encryptEmailQueuePayload('private', SECRET)) as { ciphertext: string }
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`

    expect(() => decryptEmailQueuePayload(JSON.stringify(envelope), SECRET)).toThrow(
      'Email queue payload authentication failed.',
    )
  })
})

describe('email delivery queue keys and worker readiness', () => {
  it('builds all canonical keys from the default and a custom prefix', () => {
    expect(emailQueueRedisKeys()).toEqual({
      jobs: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:jobs`,
      ready: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:ready`,
      leased: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:leased`,
      dead: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:dead`,
      expiry: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:expiry`,
      claims: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:claims`,
      bytes: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:bytes`,
      supersessions: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:supersessions`,
      jobSupersessions: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:job-supersessions`,
      idempotency: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:idempotency`,
      idempotencyExpiry: `${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:idempotency-expiry`,
    })
    expect(emailQueueRedisKeys('custom')).toEqual({
      jobs: 'custom:jobs',
      ready: 'custom:ready',
      leased: 'custom:leased',
      dead: 'custom:dead',
      expiry: 'custom:expiry',
      claims: 'custom:claims',
      bytes: 'custom:bytes',
      supersessions: 'custom:supersessions',
      jobSupersessions: 'custom:job-supersessions',
      idempotency: 'custom:idempotency',
      idempotencyExpiry: 'custom:idempotency-expiry',
    })
    expect(emailQueueWorkerReadinessKey()).toBe(`${EMAIL_QUEUE_DEFAULT_KEY_PREFIX}:ready-worker`)
    expect(emailQueueWorkerReadinessKey('custom')).toBe('custom:ready-worker')
  })

  it.each(['', 'a'.repeat(257), 'bad\rprefix', 'bad\nprefix', 'bad\0prefix'])(
    'rejects unsafe key prefix %p',
    (prefix) => {
      expect(() => emailQueueRedisKeys(prefix)).toThrow('Email delivery queue key prefix is invalid.')
      expect(() => emailQueueWorkerReadinessKey(prefix)).toThrow('Email delivery queue key prefix is invalid.')
    },
  )

  it('derives a non-secret readiness identity from the stable key and queue schema', () => {
    const readiness = emailQueueWorkerReadinessValue(SECRET)

    expect(readiness).toMatch(/^v1:[A-Za-z0-9_-]{43}$/)
    expect(readiness).toBe(emailQueueWorkerReadinessValue(SECRET))
    expect(readiness).not.toContain(SECRET)
    expect(readiness).not.toBe(emailQueueWorkerReadinessValue('b'.repeat(64)))
  })

  it('versions the published-reminder source as an incompatible queue protocol change', () => {
    expect(EMAIL_QUEUE_PROTOCOL_CONTEXT).toBe('standard-red-notes/email-delivery-queue-protocol/v3')
  })

  it('partitions queue keys by compatibility without losing the Redis hash tag', () => {
    const compatible = emailQueueCompatibleKeyPrefix(SECRET)
    const incompatible = emailQueueCompatibleKeyPrefix('b'.repeat(64))

    expect(compatible).toBe(COMPAT_PREFIX)
    expect(compatible).toContain('{delivery}')
    expect(compatible).not.toBe(incompatible)
    expect(emailQueueRedisKeys(compatible).jobs).not.toBe(emailQueueRedisKeys(incompatible).jobs)
  })

  it('binds readiness to every safety limit without abandoning the durable queue namespace', () => {
    const defaults = validateEmailQueueProducerLimits({})
    const defaultIdentity = emailQueueCompatibilityIdentity(SECRET)
    const variants = [
      { ...defaults, retentionMs: 1_000 },
      { ...defaults, maxAttempts: defaults.maxAttempts + 1 },
      { ...defaults, maxJobBytes: defaults.maxJobBytes + 1 },
      { ...defaults, maxTotalBytes: defaults.maxTotalBytes + 1 },
    ]

    expect(emailQueueCompatibilityIdentity(SECRET, defaults)).toBe(defaultIdentity)
    expect(emailQueueWorkerReadinessValue(SECRET, defaults)).toBe(emailQueueWorkerReadinessValue(SECRET))
    for (const variant of variants) {
      expect(emailQueueCompatibilityIdentity(SECRET, variant)).not.toBe(defaultIdentity)
      expect(emailQueueCompatibleKeyPrefix(SECRET, EMAIL_QUEUE_DEFAULT_KEY_PREFIX, variant)).toBe(COMPAT_PREFIX)
      expect(emailQueueWorkerReadinessValue(SECRET, variant)).not.toBe(emailQueueWorkerReadinessValue(SECRET))
    }
  })

  it('keys supersession identities without persisting caller correlation material', () => {
    const callerKey = 'private-user-email-digest'
    const identity = emailQueueSupersessionIdentity(SECRET, callerKey)

    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(identity).not.toContain(callerKey)
    expect(identity).not.toBe(emailQueueSupersessionIdentity('b'.repeat(64), callerKey))
  })

  it.each(['', '../private', 'private key', 'a'.repeat(129)])(
    'rejects unsafe supersession identity %p before deriving or persisting it',
    (callerKey) => {
      expect(() => emailQueueSupersessionIdentity(SECRET, callerKey)).toThrow('supersession key is invalid')
    },
  )

  it('detects Redis Cluster clients by capability rather than calling the topology API', () => {
    const nodes = jest.fn()

    expect(isRedisClusterTopology({ nodes })).toBe(true)
    expect(isRedisClusterTopology({})).toBe(false)
    expect(nodes).not.toHaveBeenCalled()
  })

  it.each([
    [emailQueueWorkerReadinessValue(SECRET), true],
    [EMAIL_QUEUE_WORKER_READINESS_VALUE, false],
    [emailQueueWorkerReadinessValue('b'.repeat(64)), false],
    [undefined, false],
    [null, false],
    ['', false],
    ['v2', false],
    ['v1 ', false],
    [Buffer.from('v1'), false],
  ])('accepts only the exact versioned readiness value %p', async (readiness, expected) => {
    const get = jest.fn().mockResolvedValue(readiness)
    const producer = new RedisEncryptedEmailQueueProducer({ eval: jest.fn(), get }, SECRET, {
      keyPrefix: 'custom',
    })

    await expect(producer.isReady()).resolves.toBe(expected)
    expect(get).toHaveBeenCalledWith(`${emailQueueCompatibleKeyPrefix(SECRET, 'custom')}:ready-worker`)
  })

  it('is not ready when the Redis client cannot read readiness', async () => {
    const producerWithoutGet = new RedisEncryptedEmailQueueProducer({ eval: jest.fn() }, SECRET)
    const producerWithFailedGet = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn(), get: jest.fn().mockRejectedValue(new Error('Redis unavailable')) },
      SECRET,
    )

    await expect(producerWithoutGet.isReady()).resolves.toBe(false)
    await expect(producerWithFailedGet.isReady()).resolves.toBe(false)
  })

  it('fails readiness closed for Redis Cluster because WAITAOF is keyless', async () => {
    const get = jest.fn().mockResolvedValue(emailQueueWorkerReadinessValue(SECRET))
    const producer = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn(), get, nodes: jest.fn().mockReturnValue([]) },
      SECRET,
    )

    await expect(producer.isReady()).resolves.toBe(false)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('email queue AOF persistence confirmation', () => {
  it('accepts a bounded custom timeout', async () => {
    const call = jest.fn().mockResolvedValue([1, 0])

    await expect(confirmEmailQueueAofPersistence({ call }, 2_500)).resolves.toBeUndefined()
    expect(call).toHaveBeenCalledWith('WAITAOF', 1, 0, 2_500)
  })

  it.each([0, 60_001, 1.5, Number.NaN])('rejects invalid timeout %p before calling Redis', async (timeoutMs) => {
    const call = jest.fn()

    await expect(confirmEmailQueueAofPersistence({ call }, timeoutMs)).rejects.toThrow(
      'The email delivery queue AOF persistence timeout is invalid.',
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects Redis Cluster before invoking its ambiguous keyless persistence command', async () => {
    const waitaof = jest.fn()

    await expect(confirmEmailQueueAofPersistence({ waitaof, nodes: jest.fn().mockReturnValue([]) })).rejects.toThrow(
      'cannot safely confirm AOF persistence in Redis Cluster mode',
    )
    expect(waitaof).not.toHaveBeenCalled()
  })
})

describe('encrypted Redis email queue producer', () => {
  it('exposes canonical validated producer defaults for startup wiring', () => {
    expect(validateEmailQueueProducerLimits({})).toEqual({
      retentionMs: EMAIL_QUEUE_DEFAULT_RETENTION_MS,
      maxAttempts: 5,
      maxJobBytes: EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
      maxTotalBytes: EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
    })
  })

  it('atomically writes an encrypted consumer-compatible job with a private idempotency sidecar', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, {
      clock: () => 10_000,
      randomId: () => 'job-1',
    })

    const queuedJob = await producer.enqueue(
      {
        to: 'private@example.com',
        subject: 'Private subject',
        html: '<p>Private body</p>',
        attachments: [
          {
            filename: 'backup.json',
            contentType: 'application/json',
            contentBase64: Buffer.from('private attachment').toString('base64'),
          },
        ],
      },
      'backup',
    )

    const [script, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(keyCount).toBe(11)
    expect(args.slice(0, 11)).toEqual(Object.values(emailQueueRedisKeys(COMPAT_PREFIX)))
    expect(script).toContain("redis.call('HSET', KEYS[1]")
    expect(script).toContain("redis.call('ZADD', KEYS[2]")
    expect(script).toContain("redis.call('HSET', KEYS[10]")
    expect(script).toContain("redis.call('SET', KEYS[7]")
    const encrypted = String(args[12])
    expect(encrypted).not.toContain('private@example.com')
    expect(encrypted).not.toContain('Private')
    expect(encrypted).not.toContain('backup.json')
    expect(JSON.parse(decryptEmailQueuePayload(encrypted, SECRET))).toEqual(queuedJob)
    expect(args.slice(13, 17)).toEqual([
      10_000,
      10_000 + EMAIL_QUEUE_DEFAULT_RETENTION_MS,
      EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
      EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
    ])
    expect(args[17]).toMatch(/^[0-9a-f]{64}$/)
    expect(String(args[17])).not.toContain('private')
    expect(args[18]).toBe('')
    expect(args[19]).toBe(10_000 + EMAIL_QUEUE_DEFAULT_RETENTION_MS)
    expect(EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024)
    expect(redis.waitaof).toHaveBeenCalledTimes(2)
  })

  it('uses bounded custom queue options for an explicitly supplied job', async () => {
    const redis = { eval: jest.fn().mockResolvedValue('1'), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, {
      keyPrefix: 'custom',
      retentionMs: 1_000,
      maxAttempts: 1,
      maxJobBytes: 1_024,
      maxTotalBytes: 2_048,
      clock: () => 1,
      randomId: () => 'unused',
    })
    const queuedJob = job({ maxAttempts: 9, nextAttemptAt: 11_000 })

    await expect(producer.enqueueJob(queuedJob)).resolves.toBeUndefined()
    const [, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(keyCount).toBe(11)
    const prefix = emailQueueCompatibleKeyPrefix(SECRET, 'custom', {
      retentionMs: 1_000,
      maxAttempts: 1,
      maxJobBytes: 1_024,
      maxTotalBytes: 2_048,
    })
    expect(args.slice(0, 11)).toEqual(Object.values(emailQueueRedisKeys(prefix)))
    expect(args.slice(13, 17)).toEqual([11_000, 12_000, 1_024, 2_048])
  })

  it.each([
    ['a', 'pending'],
    ['s', 'provider-accepted'],
    ['f', 'dead'],
    ['q', 'quarantined'],
    ['d', 'discarded'],
    ['x', 'superseded'],
  ] as const)('reads the durable %s delivery tombstone as %s without queue mutation', async (state, status) => {
    const hget = jest.fn().mockResolvedValue(`${state}:${'a'.repeat(64)}`)
    const producer = new RedisEncryptedEmailQueueProducer({ eval: jest.fn(), hget }, SECRET)

    await expect(producer.getDeliveryStatus('job-1')).resolves.toBe(status)
    expect(hget).toHaveBeenCalledWith(emailQueueRedisKeys(COMPAT_PREFIX).idempotency, 'job-1')
  })

  it('recognizes a cancellation fence without treating it as a malformed status', async () => {
    const hget = jest.fn().mockResolvedValue('d:*')
    const producer = new RedisEncryptedEmailQueueProducer({ eval: jest.fn(), hget }, SECRET)

    await expect(producer.getDeliveryStatus('job-1')).resolves.toBe('discarded')
  })

  it.each([
    [1, 'cancelled', 2],
    [2, 'provider-accepted', 1],
    [-1, 'in-flight', 1],
  ] as const)('durably cancels with Redis result %s as %s', async (redisResult, expected, aofCalls) => {
    const redis = { eval: jest.fn().mockResolvedValue(redisResult), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000, retentionMs: 1_000 })

    await expect(producer.cancelDelivery('job-1')).resolves.toBe(expected)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(keyCount).toBe(11)
    expect(args.slice(0, 11)).toEqual(Object.values(emailQueueRedisKeys(COMPAT_PREFIX)))
    expect(args.slice(11)).toEqual(['job-1', 11_000, EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES])
    expect(script).toContain("local cancellation_record = 'd:*'")
    expect(script).toContain("redis.call('HSET', KEYS[10], ARGV[1], cancellation_record)")
    expect(script).toContain("redis.call('ZSCORE', KEYS[3], ARGV[1])")
    expect(script).toContain("local valid_wildcard = (state == 'd' or state == 'x') and fingerprint == '*'")
    expect(script).toContain('previous_record_bytes')
    expect(script).toContain('local remaining_bytes = total_bytes - payload_bytes - previous_record_bytes')
    expect(script).toContain('local projected_total = remaining_bytes + cancellation_record_bytes')
    expect(script).toContain('projected_total > tonumber(ARGV[3]) and projected_total > total_bytes')
    expect(redis.waitaof).toHaveBeenCalledTimes(aofCalls)
  })

  it.each([Number.NaN, -1, MAX_TIMESTAMP])(
    'rejects an invalid cancellation clock %p before persistence or mutation',
    async (now) => {
      const redis = { eval: jest.fn(), waitaof: jest.fn() }
      const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => now })

      await expect(producer.cancelDelivery('job-1')).rejects.toThrow('clock is invalid')
      expect(redis.waitaof).not.toHaveBeenCalled()
      expect(redis.eval).not.toHaveBeenCalled()
    },
  )

  it.each(['', '../job', 'job with spaces', 'a'.repeat(129)])(
    'rejects unsafe cancellation delivery id %p before persistence or mutation',
    async (deliveryId) => {
      const redis = { eval: jest.fn(), waitaof: jest.fn() }
      const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)

      await expect(producer.cancelDelivery(deliveryId)).rejects.toThrow('job is invalid')
      expect(redis.waitaof).not.toHaveBeenCalled()
      expect(redis.eval).not.toHaveBeenCalled()
    },
  )

  it('rejects cancellation in Redis Cluster before persistence or mutation', async () => {
    const redis = { eval: jest.fn(), waitaof: jest.fn(), nodes: jest.fn().mockReturnValue([]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)

    await expect(producer.cancelDelivery('job-1')).rejects.toThrow(
      'cannot safely confirm AOF persistence in Redis Cluster mode',
    )
    expect(redis.waitaof).not.toHaveBeenCalled()
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('fails closed when Redis cannot reserve an exactly-accounted cancellation fence', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(-2), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)

    await expect(producer.cancelDelivery('job-1')).rejects.toThrow('no capacity for the cancellation fence')
    expect(redis.waitaof).toHaveBeenCalledTimes(1)
  })

  it('fails closed when cancellation encounters a malformed durable state', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(-3), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)

    await expect(producer.cancelDelivery('job-1')).rejects.toThrow('invalid cancellation state')
    expect(redis.waitaof).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Redis returns an unknown cancellation result', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(0), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)

    await expect(producer.cancelDelivery('job-1')).rejects.toThrow('invalid cancellation result')
    expect(redis.waitaof).toHaveBeenCalledTimes(1)
  })

  it('reports missing delivery status and fails closed on malformed or unavailable status data', async () => {
    const missing = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn(), hget: jest.fn().mockResolvedValue(null) },
      SECRET,
    )
    const malformed = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn(), hget: jest.fn().mockResolvedValue('a:not-a-fingerprint') },
      SECRET,
    )
    const malformedWildcard = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn(), hget: jest.fn().mockResolvedValue('s:*') },
      SECRET,
    )
    const failed = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn(), hget: jest.fn().mockRejectedValue(new Error('Redis unavailable')) },
      SECRET,
    )
    const unsupported = new RedisEncryptedEmailQueueProducer({ eval: jest.fn() }, SECRET)

    await expect(missing.getDeliveryStatus('job-1')).resolves.toBe('missing')
    await expect(malformed.getDeliveryStatus('job-1')).rejects.toThrow('returned an invalid status')
    await expect(malformedWildcard.getDeliveryStatus('job-1')).rejects.toThrow('returned an invalid status')
    await expect(failed.getDeliveryStatus('job-1')).rejects.toThrow('status is unavailable')
    await expect(unsupported.getDeliveryStatus('job-1')).rejects.toThrow('status is unavailable')
    await expect(missing.getDeliveryStatus('../unsafe')).rejects.toThrow('job is invalid')
  })

  it('rejects envelope upper-bound overflow before Redis mutation', async () => {
    const redis = { eval: jest.fn(), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, {
      maxJobBytes: 1_024,
      maxTotalBytes: 2_048,
    })

    await expect(producer.enqueue(message({ text: 'x'.repeat(900) }))).rejects.toThrow('per-job storage limit')
    expect(redis.eval).not.toHaveBeenCalled()
    expect(redis.waitaof).not.toHaveBeenCalled()
  })

  it('uses secure runtime defaults for generated ids, timestamps, source, and attempts', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const before = Date.now()
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)
    const queuedJob = await producer.enqueue(message())
    const after = Date.now()

    expect(queuedJob.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(queuedJob.source).toBe('other')
    expect(queuedJob.attempt).toBe(0)
    expect(queuedJob.maxAttempts).toBe(5)
    expect(queuedJob.createdAt).toBeGreaterThanOrEqual(before)
    expect(queuedJob.createdAt).toBeLessThanOrEqual(after)
    expect(queuedJob.nextAttemptAt).toBe(queuedJob.createdAt)
    expect(queuedJob.expiresAt).toBeUndefined()
    expect(queuedJob.retryMode).toBeUndefined()
  })

  it('persists and fingerprints explicit expiry and retry semantics', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(-3),
      waitaof: jest.fn().mockResolvedValue([1, 0]),
    }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000 })

    const queued = await producer.enqueue(message(), 'account', 'stable-job', {
      expiresAt: 20_000,
      retryMode: 'indefinite',
    })

    expect(queued).toMatchObject({ expiresAt: 20_000, retryMode: 'indefinite' })
    const [, , ...firstArgs] = redis.eval.mock.calls[0]
    const encrypted = String(firstArgs[12])
    expect(JSON.parse(decryptEmailQueuePayload(encrypted, SECRET))).toMatchObject({
      expiresAt: 20_000,
      retryMode: 'indefinite',
    })
    await expect(
      producer.enqueue(message(), 'account', 'stable-job', { expiresAt: 20_001, retryMode: 'indefinite' }),
    ).rejects.toThrow('already bound to a different message')
    const [, , ...secondArgs] = redis.eval.mock.calls[1]
    expect(firstArgs[17]).not.toBe(secondArgs[17])
  })

  it('atomically supersedes only after net-capacity preflight and persists only a keyed identity', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000 })
    const callerKey = 'private-user-email-digest'

    await producer.enqueue(message(), 'account', 'replacement', { supersessionKey: callerKey })

    const [script, , ...args] = redis.eval.mock.calls[0]
    expect(args[18]).toBe(emailQueueSupersessionIdentity(SECRET, callerKey))
    expect(JSON.stringify(args.slice(0, 11))).not.toContain(callerKey)
    expect(script.indexOf('projected_total > tonumber(ARGV[6])')).toBeLessThan(
      script.indexOf("redis.call('HDEL', KEYS[1], previous_id)"),
    )
  })

  it('omits retention expiry for indefinite delivery', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000 })

    await producer.enqueue(message(), 'account', 'indefinite', { retryMode: 'indefinite' })

    const args = redis.eval.mock.calls[0].slice(2)
    expect(args[14]).toBe(0)
    expect(args[19]).toBe(0)
  })

  it('accepts the same deterministic id and logical payload idempotently', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      waitaof: jest.fn().mockResolvedValue([1, 0]),
    }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, {
      clock: () => 10_000,
    })

    await expect(producer.enqueue(message(), 'account', 'stable-job')).resolves.toMatchObject({ id: 'stable-job' })
    await expect(producer.enqueue(message(), 'account', 'stable-job')).resolves.toMatchObject({ id: 'stable-job' })
    const firstArgs = redis.eval.mock.calls[0].slice(2)
    const secondArgs = redis.eval.mock.calls[1].slice(2)
    expect(firstArgs[17]).toBe(secondArgs[17])
    expect(redis.waitaof).toHaveBeenCalledTimes(4)
  })

  it('keeps idempotency stable across retry policy changes', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      waitaof: jest.fn().mockResolvedValue([1, 0]),
    }
    const oldPolicy = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000, maxAttempts: 5 })
    const newPolicy = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 20_000, maxAttempts: 8 })

    await oldPolicy.enqueue(message(), 'account', 'stable-job')
    await newPolicy.enqueue(message(), 'account', 'stable-job')

    expect(redis.eval.mock.calls[0].slice(2)[17]).toBe(redis.eval.mock.calls[1].slice(2)[17])
  })

  it('rejects a deterministic id already bound to a different logical payload', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(-3), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000 })

    await expect(producer.enqueue(message(), 'account', 'stable-job')).rejects.toThrow(
      'The email delivery id is already bound to a different message.',
    )
    expect(redis.waitaof).toHaveBeenCalledTimes(1)
  })

  it.each(['', '../job', 'a'.repeat(129), 'job with spaces'])(
    'rejects unsafe deterministic delivery id %p before writing',
    async (deliveryId) => {
      const redis = { eval: jest.fn(), waitaof: jest.fn() }
      const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000 })

      await expect(producer.enqueue(message(), 'account', deliveryId)).rejects.toThrow(
        'Email delivery queue job is invalid.',
      )
      expect(redis.eval).not.toHaveBeenCalled()
    },
  )

  it('preflights local AOF persistence without mutating and safely retries', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValueOnce(1),
      waitaof: jest.fn().mockResolvedValueOnce([0, 0]).mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([1, 0]),
    }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, { clock: () => 10_000 })

    await expect(producer.enqueue(message(), 'account', 'stable-job')).rejects.toThrow(
      'The email delivery queue could not confirm local AOF persistence.',
    )
    expect(redis.eval).not.toHaveBeenCalled()
    await expect(producer.enqueue(message(), 'account', 'stable-job')).resolves.toMatchObject({ id: 'stable-job' })
  })

  it('fails closed when WAITAOF is unsupported or errors', async () => {
    const unsupported = new RedisEncryptedEmailQueueProducer({ eval: jest.fn().mockResolvedValue(1) }, SECRET)
    const failed = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockRejectedValue(new Error('Redis unavailable')) },
      SECRET,
    )

    await expect(unsupported.enqueue(message())).rejects.toThrow(
      'The email delivery queue cannot confirm local AOF persistence.',
    )
    await expect(failed.enqueue(message())).rejects.toThrow(
      'The email delivery queue could not confirm local AOF persistence.',
    )
  })

  it('uses the generic Redis command API when the client has no typed WAITAOF helper', async () => {
    const call = jest.fn().mockResolvedValue([1, 0])
    const producer = new RedisEncryptedEmailQueueProducer({ eval: jest.fn().mockResolvedValue(1), call }, SECRET)

    await expect(producer.enqueue(message())).resolves.toBeDefined()
    expect(call).toHaveBeenCalledWith('WAITAOF', 1, 0, 5_000)
  })

  it.each([1, '1', [], [1], [0, 0], [-1, 0], [1, -1], [1.5, 0], [1, 0.5], ['invalid', 0]])(
    'fails closed for invalid WAITAOF result %p',
    async (waitaofResult) => {
      const producer = new RedisEncryptedEmailQueueProducer(
        { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockResolvedValue(waitaofResult) },
        SECRET,
      )

      await expect(producer.enqueue(message())).rejects.toThrow(
        'The email delivery queue could not confirm local AOF persistence.',
      )
    },
  )

  it('accepts integer-like string elements returned by Redis clients', async () => {
    const producer = new RedisEncryptedEmailQueueProducer(
      { eval: jest.fn().mockResolvedValue(1), waitaof: jest.fn().mockResolvedValue(['1', '0']) },
      SECRET,
    )

    await expect(producer.enqueue(message())).resolves.toBeDefined()
  })

  it('never writes in Redis Cluster mode because keyless WAITAOF could target the wrong node', async () => {
    const redis = {
      eval: jest.fn(),
      waitaof: jest.fn(),
      nodes: jest.fn().mockReturnValue([]),
    }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET)

    await expect(producer.enqueue(message(), 'account', 'stable-job')).rejects.toThrow(
      'The email delivery queue cannot safely confirm AOF persistence in Redis Cluster mode.',
    )
    expect(redis.eval).not.toHaveBeenCalled()
    expect(redis.waitaof).not.toHaveBeenCalled()
  })

  it.each([
    [-1, 'The encrypted email delivery job exceeds the per-job storage limit.'],
    [-2, 'The email delivery queue has reached its encrypted storage budget.'],
    [-3, 'The email delivery id is already bound to a different message.'],
    [-4, 'The email delivery id was cancelled or superseded and cannot be replayed.'],
    [3, 'The email delivery queue returned an invalid enqueue result.'],
    ['invalid', 'The email delivery queue returned an invalid enqueue result.'],
  ])('maps queue storage result %p to a non-sensitive error', async (result, expectedMessage) => {
    const redis = { eval: jest.fn().mockResolvedValue(result), waitaof: jest.fn().mockResolvedValue([1, 0]) }
    const producer = new RedisEncryptedEmailQueueProducer(redis, SECRET, {
      clock: () => 10_000,
      randomId: () => 'job-1',
    })

    await expect(producer.enqueue(message())).rejects.toThrow(expectedMessage)
  })

  it.each<[string, RedisEncryptedEmailQueueProducerOptions]>([
    ['retention below minimum', { retentionMs: 999 }],
    ['retention above maximum', { retentionMs: 90 * 24 * 60 * 60 * 1_000 + 1 }],
    ['fractional retention', { retentionMs: 1_000.5 }],
    ['attempts below minimum', { maxAttempts: 0 }],
    ['attempts above maximum', { maxAttempts: 101 }],
    ['fractional attempts', { maxAttempts: 1.5 }],
    ['job bytes below minimum', { maxJobBytes: 1_023 }],
    ['job bytes above maximum', { maxJobBytes: 1024 * 1024 * 1024 + 1 }],
    ['fractional job bytes', { maxJobBytes: 1_024.5 }],
    ['total bytes below job limit', { maxJobBytes: 2_048, maxTotalBytes: 1_024 }],
    ['total bytes above maximum', { maxTotalBytes: 10 * 1024 * 1024 * 1024 + 1 }],
    ['fractional total bytes', { maxTotalBytes: 256 * 1024 * 1024 + 0.5 }],
  ])('rejects invalid producer option: %s', (_name, options) => {
    expect(() => new RedisEncryptedEmailQueueProducer({ eval: jest.fn() }, SECRET, options)).toThrow(
      'Email delivery queue options are invalid.',
    )
  })
})

describe('email delivery queue job validation', () => {
  it('accepts a valid live or dead job and validates its nested message', () => {
    expect(() => validateEmailQueueJob(job())).not.toThrow()
    expect(() => validateEmailQueueJob(job({ source: 'published-reminder' }))).not.toThrow()
    expect(() => validateEmailQueueJob(job({ deadAt: 20_000 }))).not.toThrow()
    expect(() => validateEmailQueueJob(job({ attempt: 6, retryMode: 'indefinite' }))).not.toThrow()
  })

  it.each<[string, (validJob: EmailQueueJob) => unknown]>([
    ['missing job', () => undefined],
    ['empty id', (validJob) => ({ ...validJob, id: '' })],
    ['unsafe id', (validJob) => ({ ...validJob, id: '../job' })],
    ['oversized id', (validJob) => ({ ...validJob, id: 'a'.repeat(129) })],
    ['unknown source', (validJob) => ({ ...validJob, source: 'unknown' })],
    ['fractional attempt', (validJob) => ({ ...validJob, attempt: 0.5 })],
    ['negative attempt', (validJob) => ({ ...validJob, attempt: -1 })],
    ['fractional max attempts', (validJob) => ({ ...validJob, maxAttempts: 1.5 })],
    ['zero max attempts', (validJob) => ({ ...validJob, maxAttempts: 0 })],
    ['max attempts above queue contract', (validJob) => ({ ...validJob, maxAttempts: 101 })],
    ['attempt beyond maximum', (validJob) => ({ ...validJob, attempt: 6 })],
    ['fractional created timestamp', (validJob) => ({ ...validJob, createdAt: 0.5 })],
    ['negative created timestamp', (validJob) => ({ ...validJob, createdAt: -1 })],
    ['oversized created timestamp', (validJob) => ({ ...validJob, createdAt: MAX_TIMESTAMP + 1 })],
    ['invalid next timestamp', (validJob) => ({ ...validJob, nextAttemptAt: -1 })],
    ['invalid dead timestamp', (validJob) => ({ ...validJob, deadAt: -1 })],
    ['expiry before creation', (validJob) => ({ ...validJob, expiresAt: validJob.createdAt - 1 })],
    ['invalid expiry', (validJob) => ({ ...validJob, expiresAt: 0.5 })],
    ['invalid retry mode', (validJob) => ({ ...validJob, retryMode: 'forever' })],
  ])('rejects an invalid job with %s', (_name, mutate) => {
    expect(() => validateEmailQueueJob(asJob(mutate(job())))).toThrow('Email delivery queue job is invalid.')
  })

  it('rejects an otherwise valid job containing an invalid message', () => {
    expect(() => validateEmailQueueJob(job({ message: message({ subject: '' }) }))).toThrow(
      'The email subject is invalid.',
    )
  })
})

describe('email delivery queue message validation', () => {
  it.each([null, 'message', [], 42])('rejects a non-object message %p', (invalidMessage) => {
    expect(() => validateEmailQueueMessage(asMessage(invalidMessage))).toThrow(
      'Email delivery queue message is invalid.',
    )
  })

  it.each([
    ['missing recipient', message({ to: '' })],
    ['header-injected recipient', message({ to: 'private@example.com\r' })],
  ])('rejects a message with %s', (_name, invalidMessage) => {
    expect(() => validateEmailQueueMessage(invalidMessage)).toThrow('A valid recipient email address is required.')
  })

  it.each([
    ['non-string subject', { ...message(), subject: 42 }],
    ['empty subject', message({ subject: '' })],
    ['oversized subject', message({ subject: 's'.repeat(999) })],
    ['header-injected subject', message({ subject: 'subject\nBcc: private@example.com' })],
  ])('rejects a message with %s', (_name, invalidMessage) => {
    expect(() => validateEmailQueueMessage(asMessage(invalidMessage))).toThrow('The email subject is invalid.')
  })

  it('requires at least one body representation', () => {
    expect(() => validateEmailQueueMessage(message({ text: undefined, html: undefined }))).toThrow(
      'An email text or HTML body is required.',
    )
  })

  it.each([
    ['non-string text', { ...message(), text: 42 }],
    ['non-string HTML', { ...message({ text: undefined, html: '<p>body</p>' }), html: 42 }],
  ])('rejects a message with %s', (_name, invalidMessage) => {
    expect(() => validateEmailQueueMessage(asMessage(invalidMessage))).toThrow('The email body is invalid.')
  })

  it.each([
    ['oversized text', message({ text: 't'.repeat(5_000_001) })],
    ['oversized HTML', message({ text: undefined, html: 'h'.repeat(5_000_001) })],
  ])('rejects a message with %s', (_name, invalidMessage) => {
    expect(() => validateEmailQueueMessage(invalidMessage)).toThrow('The email body is too large.')
  })

  it('enforces the aggregate UTF-8 byte budget across otherwise bounded text and HTML bodies', () => {
    const multibyteBody = '€'.repeat(3_500_000)

    expect(() => validateEmailQueueMessage(message({ text: multibyteBody, html: multibyteBody }))).toThrow(
      'aggregate content limit',
    )
  })

  it('rejects a non-array or oversized attachment collection', () => {
    expect(() => validateEmailQueueMessage(asMessage({ ...message(), attachments: {} }))).toThrow(
      'Email attachments are invalid.',
    )
    expect(() =>
      validateEmailQueueMessage(
        message({
          attachments: Array.from({ length: 21 }, (_, index) => ({
            filename: `attachment-${index}.txt`,
            contentBase64: '',
          })),
        }),
      ),
    ).toThrow('The email has too many attachments.')
  })

  it.each([
    ['null attachment', null],
    ['primitive attachment', 'attachment'],
    ['non-string filename', { filename: 42, contentBase64: '' }],
    ['empty filename', { filename: '', contentBase64: '' }],
    ['oversized filename', { filename: 'a'.repeat(256), contentBase64: '' }],
    ['unsafe filename', { filename: '../private.txt', contentBase64: '' }],
    ['invalid content type', { filename: 'private.txt', contentType: 'text plain', contentBase64: '' }],
    ['oversized content type', { filename: 'private.txt', contentType: `a/${'b'.repeat(126)}`, contentBase64: '' }],
  ])('rejects %s metadata', (_name, attachment) => {
    expect(() => validateEmailQueueMessage(asMessage({ ...message(), attachments: [attachment] }))).toThrow(
      'An email attachment has invalid metadata.',
    )
  })

  it.each([
    ['non-string', 42],
    ['malformed base64', '*'],
    ['non-canonical base64', 'A'],
  ])('rejects %s attachment content', (_name, contentBase64) => {
    expect(() =>
      validateEmailQueueMessage(asMessage({ ...message(), attachments: [{ filename: 'private.txt', contentBase64 }] })),
    ).toThrow('An email attachment has invalid or oversized content.')
  })

  it('rejects an attachment above the decoded byte limit', () => {
    expect(() =>
      validateEmailQueueMessage(
        message({
          attachments: [
            {
              filename: 'private.bin',
              contentBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64'),
            },
          ],
        }),
      ),
    ).toThrow('An email attachment has invalid or oversized content.')
  })

  it('rejects aggregate attachment content above the message budget', () => {
    expect(() =>
      validateEmailQueueMessage(
        message({
          attachments: [
            { filename: 'one.bin', contentBase64: Buffer.alloc(11 * 1024 * 1024).toString('base64') },
            { filename: 'two.bin', contentBase64: Buffer.alloc(10 * 1024 * 1024).toString('base64') },
          ],
        }),
      ),
    ).toThrow('aggregate content limit')
  })

  it('rechecks aggregate size after decoding a mutable attachment input', () => {
    const decodedContent = Buffer.alloc(6 * 1024 * 1024)
    const largeBase64 = decodedContent.toString('base64')
    let contentReads = 0
    const attachment = {
      filename: 'mutable.bin',
      get contentBase64(): string {
        contentReads += 1
        return contentReads <= 4 ? '' : largeBase64
      },
    }

    expect(() =>
      validateEmailQueueMessage(
        message({
          text: '€'.repeat(5_000_000),
          attachments: [attachment],
        }),
      ),
    ).toThrow('aggregate content limit')
    expect(contentReads).toBe(6)
  })

  it('normalizes the recipient and returns defensive attachment copies', () => {
    const attachment = {
      filename: 'private.txt',
      contentBase64: Buffer.from('private').toString('base64'),
    }
    const input = message({ to: ' private@example.com ', html: '<p>Private</p>', attachments: [attachment] })
    const normalized = validateEmailQueueMessage(input)

    expect(normalized.to).toBe('private@example.com')
    expect(normalized.text).toBe('Private body')
    expect(normalized.html).toBe('<p>Private</p>')
    expect(normalized.attachments).toEqual([attachment])
    expect(normalized.attachments).not.toBe(input.attachments)
    expect(normalized.attachments?.[0]).not.toBe(attachment)
    expect(validateEmailQueueMessage(message({ attachments: [] })).attachments).toEqual([])
  })
})
