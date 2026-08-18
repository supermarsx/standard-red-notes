import { describe, expect, it, vi } from 'vitest'

import { createRedisSqsEventDedupStore, type RedisSqsEventDedupClient } from '../src/sqsConsumer.js'

class FakeRedisDedupClient implements RedisSqsEventDedupClient {
  status = 'ready'
  readonly values = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async set(key: string, value: string, _mode: 'PX', _ttl: number, _condition: 'NX'): Promise<'OK' | null> {
    if (this.values.has(key)) {
      return null
    }
    this.values.set(key, value)
    return 'OK'
  }

  async eval(script: string, _numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0])
    const claimToken = String(args[1])
    if (this.values.get(key) !== claimToken) {
      return 0
    }
    if (script.includes('SRN_WS_SQS_EVENT_DEDUP_COMPLETE_V1')) {
      this.values.set(key, String(args[2]))
      return 1
    }
    if (script.includes('SRN_WS_SQS_EVENT_DEDUP_RELEASE_V1')) {
      this.values.delete(key)
      return 1
    }
    throw new Error('unexpected script')
  }
}

describe('Redis SQS event deduplication', () => {
  it('suppresses a completed event across store instances and process reconstruction', async () => {
    const redis = new FakeRedisDedupClient()
    const operation = vi.fn()

    expect(await createRedisSqsEventDedupStore(redis).executeOnce('event-1', operation)).toBe('executed')
    expect(await createRedisSqsEventDedupStore(redis).executeOnce('event-1', operation)).toBe('duplicate')

    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('fails closed while another instance owns the processing lease, then recognizes completion', async () => {
    const redis = new FakeRedisDedupClient()
    const firstStore = createRedisSqsEventDedupStore(redis)
    const secondStore = createRedisSqsEventDedupStore(redis)
    let release!: () => void
    const first = firstStore.executeOnce(
      'event-1',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await Promise.resolve()

    await expect(secondStore.executeOnce('event-1', vi.fn())).rejects.toThrow('still in progress')
    release()
    await first
    expect(await secondStore.executeOnce('event-1', vi.fn())).toBe('duplicate')
  })

  it('releases a failed operation so SQS redelivery can execute it again', async () => {
    const redis = new FakeRedisDedupClient()
    const store = createRedisSqsEventDedupStore(redis)
    const operation = vi.fn().mockRejectedValueOnce(new Error('dispatch failed')).mockResolvedValue(undefined)

    await expect(store.executeOnce('event-1', operation)).rejects.toThrow('dispatch failed')
    expect(await store.executeOnce('event-1', operation)).toBe('executed')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('fails closed without invoking the operation while shared Redis is unavailable', async () => {
    const redis = new FakeRedisDedupClient()
    redis.status = 'reconnecting'
    const operation = vi.fn()

    await expect(createRedisSqsEventDedupStore(redis).executeOnce('event-1', operation)).rejects.toThrow('not ready')
    expect(operation).not.toHaveBeenCalled()
  })
})
