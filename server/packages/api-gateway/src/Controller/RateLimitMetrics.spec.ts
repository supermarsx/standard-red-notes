import {
  RateLimitMetricsRedis,
  RateLimitMetricsStore,
  RL_METRICS_BLOCK_KEY,
  RL_METRICS_RECENT_KEY,
  RL_METRICS_TIER_KEY,
} from './RateLimitMetrics'

const buildRedis = (): {
  redis: RateLimitMetricsRedis
  hashes: Record<string, Record<string, string>>
  lists: Record<string, string[]>
} => {
  const hashes: Record<string, Record<string, string>> = {}
  const lists: Record<string, string[]> = {}
  const redis: RateLimitMetricsRedis = {
    hincrby: jest.fn((key: string, field: string, inc: number) => {
      hashes[key] = hashes[key] ?? {}
      const next = Number(hashes[key][field] ?? '0') + inc
      hashes[key][field] = String(next)
      return Promise.resolve(next)
    }),
    hgetall: jest.fn((key: string) => Promise.resolve(hashes[key] ?? {})),
    lpush: jest.fn((key: string, value: string) => {
      lists[key] = lists[key] ?? []
      lists[key].unshift(value)
      return Promise.resolve(lists[key].length)
    }),
    ltrim: jest.fn((key: string, start: number, stop: number) => {
      lists[key] = (lists[key] ?? []).slice(start, stop + 1)
      return Promise.resolve('OK')
    }),
    lrange: jest.fn((key: string, start: number, stop: number) =>
      Promise.resolve((lists[key] ?? []).slice(start, stop + 1)),
    ),
    expire: jest.fn(() => Promise.resolve(1)),
  }
  return { redis, hashes, lists }
}

describe('RateLimitMetricsStore', () => {
  it('records a throttle into the tier hash + recent ring', async () => {
    const { redis, hashes, lists } = buildRedis()
    const store = new RateLimitMetricsStore(redis)
    await store.recordThrottle({ bucket: 'auth-login', ip: '1.2.3.4', method: 'POST', path: '/v1/login', at: 42 })
    expect(hashes[RL_METRICS_TIER_KEY]).toEqual({ 'auth-login': '1' })
    expect(lists[RL_METRICS_RECENT_KEY]).toHaveLength(1)
    expect(JSON.parse(lists[RL_METRICS_RECENT_KEY][0])).toEqual({
      at: 42,
      bucket: 'auth-login',
      ip: '1.2.3.4',
      method: 'POST',
      path: '/v1/login',
    })
  })

  it('records a block into the block hash', async () => {
    const { redis, hashes } = buildRedis()
    const store = new RateLimitMetricsStore(redis)
    await store.recordBlock()
    await store.recordBlock()
    expect(hashes[RL_METRICS_BLOCK_KEY]).toEqual({ total: '2' })
  })

  it('aggregates a view and never throws on a Redis error', async () => {
    const { redis } = buildRedis()
    const store = new RateLimitMetricsStore(redis)
    await store.recordThrottle({ bucket: 'auth-login', ip: '1.2.3.4', method: 'POST', path: '/v1/login' })
    await store.recordBlock()
    const view = await store.view()
    expect(view.tierHits).toEqual({ 'auth-login': 1 })
    expect(view.blockHits).toBe(1)
    expect(view.recent).toHaveLength(1)

    const failing = new RateLimitMetricsStore({
      ...redis,
      hgetall: jest.fn(() => Promise.reject(new Error('down'))),
    })
    await expect(failing.view()).resolves.toEqual({ tierHits: {}, blockHits: 0, recent: [] })
  })
})
