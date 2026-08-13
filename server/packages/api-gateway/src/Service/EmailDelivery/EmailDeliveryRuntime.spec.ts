import {
  EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
  EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
  emailQueueWorkerReadinessValue,
  emailQueueCompatibleKeyPrefix,
  emailQueueWorkerReadinessKey,
} from '@standardnotes/domain-core'

import {
  EmailDeliveryRuntime,
  EmailDeliveryRuntimeLogger,
  EmailDeliveryRuntimeRedis,
  EmailDeliveryWorkerLifecycle,
  QueuedReminderEmailProvider,
  resolveEmailDeliveryRuntimeOptions,
  supportsAdvancedEmailDeliveryRedis,
} from './EmailDeliveryRuntime'

describe('EmailDeliveryRuntime', () => {
  const stableSecret = '66'.repeat(32)
  const logger = (): jest.Mocked<EmailDeliveryRuntimeLogger> => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })
  const worker = (): jest.Mocked<EmailDeliveryWorkerLifecycle> => ({
    start: jest.fn().mockReturnValue(true),
    stop: jest.fn().mockResolvedValue(undefined),
  })
  const redis = (): jest.Mocked<EmailDeliveryRuntimeRedis> => ({
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    config: jest.fn().mockResolvedValue(['maxmemory', '0']),
    waitaof: jest.fn().mockResolvedValue([1, 0]),
  })

  it('publishes readiness only while the worker is live and a valid relay is configured', async () => {
    const cache = redis()
    const consumer = worker()
    const configured = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const runtime = new EmailDeliveryRuntime(cache, consumer, configured, {}, stableSecret, logger())

    await expect(runtime.start()).resolves.toBe(true)
    expect(runtime.isAcceptingEmails()).toBe(false)
    expect(consumer.start).not.toHaveBeenCalled()
    expect(cache.del).not.toHaveBeenCalled()

    await runtime.refreshReadiness()
    expect(runtime.isAcceptingEmails()).toBe(true)
    expect(consumer.start).toHaveBeenCalledTimes(1)
    expect(cache.set).toHaveBeenCalledWith(
      emailQueueWorkerReadinessKey(emailQueueCompatibleKeyPrefix(stableSecret)),
      emailQueueWorkerReadinessValue(stableSecret),
      'PX',
      12_000,
    )

    await runtime.refreshReadiness()
    expect(runtime.isAcceptingEmails()).toBe(false)
    expect(consumer.stop).toHaveBeenCalledTimes(1)

    await runtime.stop()
    expect(consumer.stop).toHaveBeenCalledTimes(1)
    expect(cache.del).not.toHaveBeenCalled()
  })

  it('publishes readiness in the exact configured queue compatibility namespace', async () => {
    const cache = redis()
    const compatibility = {
      retentionMs: 60_000,
      maxAttempts: 3,
      maxJobBytes: 1024 * 1024,
      maxTotalBytes: 4 * 1024 * 1024,
    }
    const runtime = new EmailDeliveryRuntime(cache, worker(), async () => true, compatibility, stableSecret, logger())

    await expect(runtime.start()).resolves.toBe(true)
    expect(cache.set).toHaveBeenCalledWith(
      emailQueueWorkerReadinessKey(emailQueueCompatibleKeyPrefix(stableSecret, undefined, compatibility)),
      emailQueueWorkerReadinessValue(stableSecret, compatibility),
      'PX',
      12_000,
    )

    await runtime.stop()
  })

  it('keeps the worker stopped when configured Redis capacity has no safety headroom', async () => {
    const cache = redis()
    cache.config.mockResolvedValue(['maxmemory', String(EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES + 64 * 1024 * 1024)])
    const consumer = worker()
    const audit = logger()
    const runtime = new EmailDeliveryRuntime(cache, consumer, async () => true, {}, stableSecret, audit)

    await expect(runtime.start()).resolves.toBe(false)
    expect(consumer.start).not.toHaveBeenCalled()
    expect(runtime.isAcceptingEmails()).toBe(false)
    expect(audit.error).toHaveBeenCalledWith(
      expect.stringContaining('capacity'),
      expect.objectContaining({ errorName: 'InsufficientCapacity' }),
    )
  })

  it('fails readiness closed and logs only the error class when relay settings cannot be read', async () => {
    const cache = redis()
    const audit = logger()
    const runtime = new EmailDeliveryRuntime(
      cache,
      worker(),
      async () => {
        throw new TypeError('secret-bearing provider failure')
      },
      {},
      stableSecret,
      audit,
    )

    await expect(runtime.start()).resolves.toBe(true)
    expect(runtime.isAcceptingEmails()).toBe(false)
    expect(cache.del).not.toHaveBeenCalled()
    expect(audit.error).toHaveBeenCalledWith('Email delivery readiness refresh failed.', {
      codeTag: 'EmailDeliveryReadiness',
      errorName: 'TypeError',
    })
    expect(JSON.stringify(audit.error.mock.calls)).not.toContain('secret-bearing')

    await runtime.stop()
  })

  it('removes readiness and drains a running worker when configuration becomes unreadable', async () => {
    const cache = redis()
    const consumer = worker()
    const configured = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockResolvedValueOnce(true)
    const runtime = new EmailDeliveryRuntime(cache, consumer, configured, {}, stableSecret, logger())

    await expect(runtime.start()).resolves.toBe(true)
    expect(runtime.isAcceptingEmails()).toBe(true)
    expect(consumer.start).toHaveBeenCalledTimes(1)

    await runtime.refreshReadiness()
    expect(runtime.isAcceptingEmails()).toBe(false)
    expect(consumer.stop).toHaveBeenCalledTimes(1)
    expect(cache.del).not.toHaveBeenCalled()

    await runtime.refreshReadiness()
    expect(runtime.isAcceptingEmails()).toBe(true)
    expect(consumer.start).toHaveBeenCalledTimes(2)

    await runtime.stop()
    expect(consumer.stop).toHaveBeenCalledTimes(2)
  })

  it('continues under managed Redis when CONFIG inspection is denied', async () => {
    const cache = redis()
    cache.config.mockRejectedValue(new Error('NOPERM'))
    const consumer = worker()
    const audit = logger()
    const runtime = new EmailDeliveryRuntime(cache, consumer, async () => true, {}, stableSecret, audit)

    await expect(runtime.start()).resolves.toBe(true)
    expect(consumer.start).toHaveBeenCalledTimes(1)
    expect(audit.warn).toHaveBeenCalledWith(
      expect.stringContaining('maxmemory'),
      expect.objectContaining({ errorName: 'Error' }),
    )
    await runtime.stop()
  })
})

describe('supportsAdvancedEmailDeliveryRedis', () => {
  it('accepts a direct Redis client and rejects Cluster topology', () => {
    expect(supportsAdvancedEmailDeliveryRedis({ eval: jest.fn() })).toBe(true)
    expect(supportsAdvancedEmailDeliveryRedis({ nodes: jest.fn(), eval: jest.fn() })).toBe(false)
    expect(supportsAdvancedEmailDeliveryRedis(undefined)).toBe(false)
  })
})

describe('resolveEmailDeliveryRuntimeOptions', () => {
  it('uses producer-compatible queue defaults', () => {
    const options = resolveEmailDeliveryRuntimeOptions(() => undefined)

    expect(options.queue).toMatchObject({
      leaseMs: 120_000,
      retentionMs: 2_592_000_000,
      deadLetterRetentionMs: 2_592_000_000,
      maxJobBytes: EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
      maxTotalBytes: EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
    })
    expect(options.delivery).toMatchObject({ maxAttempts: 5, retryBaseMs: 30_000, retryMaxMs: 21_600_000 })
    expect(options.worker).toEqual({ intervalMs: 5_000, batchSize: 25 })
    expect(options.logs).toEqual({ retentionMs: 2_592_000_000, maximumEntries: 10_000 })
  })

  it('rejects malformed values and inconsistent capacity or retry bounds', () => {
    expect(() =>
      resolveEmailDeliveryRuntimeOptions((name) => (name === 'EMAIL_QUEUE_MAX_ATTEMPTS' ? '5.5' : undefined)),
    ).toThrow('EMAIL_QUEUE_MAX_ATTEMPTS')
    expect(() =>
      resolveEmailDeliveryRuntimeOptions((name) => {
        return name === 'EMAIL_QUEUE_MAX_JOB_BYTES'
          ? '2000'
          : name === 'EMAIL_QUEUE_MAX_TOTAL_BYTES'
            ? '1000'
            : undefined
      }),
    ).toThrow('EMAIL_QUEUE_MAX_TOTAL_BYTES')
    expect(() =>
      resolveEmailDeliveryRuntimeOptions((name) => {
        return name === 'EMAIL_DELIVERY_RETRY_BASE_MS'
          ? '5000'
          : name === 'EMAIL_DELIVERY_RETRY_MAX_MS'
            ? '1000'
            : undefined
      }),
    ).toThrow('EMAIL_DELIVERY_RETRY_MAX_MS')
    expect(() =>
      resolveEmailDeliveryRuntimeOptions((name) => {
        return name === 'EMAIL_QUEUE_RETENTION_MS'
          ? '5000'
          : name === 'EMAIL_DELIVERY_RETRY_BASE_MS'
            ? '1000'
            : name === 'EMAIL_DELIVERY_RETRY_MAX_MS'
              ? '5000'
              : undefined
      }),
    ).toThrow('EMAIL_QUEUE_RETENTION_MS')
  })
})

describe('QueuedReminderEmailProvider', () => {
  it('queues published reminders only while the advanced runtime is accepting mail', async () => {
    const enqueue = jest.fn().mockResolvedValue({ id: 'job' })
    const isReady = jest.fn().mockResolvedValue(true)
    const getDeliveryStatus = jest.fn().mockResolvedValue('missing')
    const runtime = { isAcceptingEmails: jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true) }
    const provider = new QueuedReminderEmailProvider(
      { enqueue, isReady, getDeliveryStatus, cancelDelivery: jest.fn() } as never,
      runtime,
    )

    await expect(
      provider.send('person@example.com', 'First', { deliveryId: 'published-reminder-first' }),
    ).resolves.toMatchObject({
      ok: false,
      notConfigured: true,
    })
    await expect(
      provider.send('person@example.com', 'Second', { deliveryId: 'published-reminder-stable' }),
    ).resolves.toEqual({
      ok: false,
      pending: true,
      reason: 'The reminder is awaiting provider acceptance.',
    })
    expect(enqueue).toHaveBeenCalledWith(
      { to: 'person@example.com', subject: 'Reminder', text: 'Second' },
      'published-reminder',
      'published-reminder-stable',
    )
  })

  it('refuses a reminder without a stable durable identity', async () => {
    const enqueue = jest.fn()
    const provider = new QueuedReminderEmailProvider(
      {
        enqueue,
        isReady: jest.fn().mockResolvedValue(true),
        getDeliveryStatus: jest.fn().mockResolvedValue('missing'),
        cancelDelivery: jest.fn(),
      } as never,
      { isAcceptingEmails: () => true },
    )

    await expect(provider.send('person@example.com', 'Missing identity')).resolves.toMatchObject({ ok: false })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('reports success only after the durable status records provider acceptance', async () => {
    const enqueue = jest.fn()
    const getDeliveryStatus = jest
      .fn()
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('provider-accepted')
      .mockResolvedValueOnce('dead')
    const provider = new QueuedReminderEmailProvider(
      { enqueue, isReady: jest.fn(), getDeliveryStatus, cancelDelivery: jest.fn() } as never,
      { isAcceptingEmails: () => false },
    )
    const context = { deliveryId: 'published-reminder-stable' }

    await expect(provider.send('person@example.com', 'Pending', context)).resolves.toMatchObject({
      ok: false,
      pending: true,
    })
    await expect(provider.send('person@example.com', 'Accepted', context)).resolves.toEqual({ ok: true })
    await expect(provider.send('person@example.com', 'Dead', context)).resolves.toEqual({
      ok: false,
      reason: 'The reminder email reached terminal queue state dead.',
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('maps durable cancellation without claiming an in-flight send was cancelled', async () => {
    const cancelDelivery = jest
      .fn()
      .mockResolvedValueOnce('cancelled')
      .mockResolvedValueOnce('provider-accepted')
      .mockResolvedValueOnce('in-flight')
    const provider = new QueuedReminderEmailProvider(
      { enqueue: jest.fn(), isReady: jest.fn(), getDeliveryStatus: jest.fn(), cancelDelivery } as never,
      { isAcceptingEmails: () => true },
    )
    const context = { deliveryId: 'published-reminder-stable' }

    await expect(provider.cancel(context)).resolves.toEqual({ ok: true })
    await expect(provider.cancel(context)).resolves.toEqual({ ok: true, providerAccepted: true })
    await expect(provider.cancel(context)).resolves.toEqual({
      ok: false,
      inFlight: true,
      reason: 'The reminder email is already in flight and cannot be cancelled safely.',
    })
  })
})
