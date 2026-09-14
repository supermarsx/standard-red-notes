import { EventEmitter } from 'node:events'

import { RedisReadinessClient, waitForRedisReady } from './WaitForRedisReady'

class RedisDouble extends EventEmitter implements RedisReadinessClient {
  constructor(public status: string) {
    super()
  }
}

describe('waitForRedisReady', () => {
  it('resolves "none" immediately when no client is bound', async () => {
    await expect(waitForRedisReady(undefined, 10)).resolves.toBe('none')
  })

  it('resolves "ready" without waiting when the client already reports ready', async () => {
    const redis = new RedisDouble('ready')

    await expect(waitForRedisReady(redis, 10)).resolves.toBe('ready')
    expect(redis.listenerCount('ready')).toBe(0)
  })

  // C15: readiness must not go green before the client connects; the sync lane
  // evaluates its store preconditions per call, so a client racing a restart
  // negotiated HTTP-only for the whole session while readiness said ready.
  it('waits for the ready event and then detaches its listeners', async () => {
    const redis = new RedisDouble('connecting')
    const outcome = waitForRedisReady(redis, 1_000)
    expect(redis.listenerCount('ready')).toBe(1)

    redis.emit('ready')

    await expect(outcome).resolves.toBe('ready')
    expect(redis.listenerCount('ready')).toBe(0)
    expect(redis.listenerCount('end')).toBe(0)
  })

  it('gives up with "timeout" after the bound instead of holding readiness forever', async () => {
    const redis = new RedisDouble('reconnecting')

    await expect(waitForRedisReady(redis, 5)).resolves.toBe('timeout')
    expect(redis.listenerCount('ready')).toBe(0)
  })

  it('stops waiting when the client ends for good', async () => {
    const redis = new RedisDouble('connecting')
    const outcome = waitForRedisReady(redis, 1_000)

    redis.emit('end')

    await expect(outcome).resolves.toBe('ended')
    expect(redis.listenerCount('ready')).toBe(0)
  })
})
