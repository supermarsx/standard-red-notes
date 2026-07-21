import 'reflect-metadata'

import * as IORedis from 'ioredis'

import { InMemoryCrossServiceTokenCache } from './InMemory/InMemoryCrossServiceTokenCache'
import { RedisCrossServiceTokenCache } from './Redis/RedisCrossServiceTokenCache'

/**
 * Standard Red Notes: the cross-service token cache lets the gateway skip a
 * session validation round trip. Two properties matter for security rather than
 * for speed: a cached token must STOP being served once it expires, and
 * invalidating a user (logout, ban, role change) must drop every one of that
 * user's cached tokens, not just the one that happened to be looked up.
 */
describe('InMemoryCrossServiceTokenCache', () => {
  let now: number
  let timer: { getTimestampInSeconds: jest.Mock }
  let cache: InMemoryCrossServiceTokenCache

  const store = (key: string, userUuid: string, expiresAtInSeconds: number, token = `token-for-${key}`) =>
    cache.set({ key, encodedCrossServiceToken: token, expiresAtInSeconds, userUuid })

  beforeEach(() => {
    now = 1000
    timer = { getTimestampInSeconds: jest.fn(() => now) }
    cache = new InMemoryCrossServiceTokenCache(timer as never)
  })

  it('returns null for a key that was never cached', async () => {
    await expect(cache.get('absent')).resolves.toBeNull()
  })

  it('returns the token it stored under that key', async () => {
    await store('k1', 'u-1', 2000, 'encoded-token')

    await expect(cache.get('k1')).resolves.toBe('encoded-token')
  })

  it('keeps different keys of the same user separate', async () => {
    await store('k1', 'u-1', 2000, 'token-1')
    await store('k2', 'u-1', 2000, 'token-2')

    await expect(cache.get('k1')).resolves.toBe('token-1')
    await expect(cache.get('k2')).resolves.toBe('token-2')
  })

  it('stops serving a token once its expiry has passed', async () => {
    await store('k1', 'u-1', 1500)

    now = 1499
    await expect(cache.get('k1')).resolves.toBe('token-for-k1')

    now = 1500
    await expect(cache.get('k1')).resolves.toBeNull()
  })

  it('expires a token whose expiry is already in the past when it is read', async () => {
    await store('k1', 'u-1', 900)

    await expect(cache.get('k1')).resolves.toBeNull()
  })

  it('does not expire a still-valid token when a sibling expires', async () => {
    await store('expiring', 'u-1', 1500)
    await store('lasting', 'u-1', 5000)

    now = 2000

    await expect(cache.get('expiring')).resolves.toBeNull()
    await expect(cache.get('lasting')).resolves.toBe('token-for-lasting')
  })

  it('drops EVERY cached token of a user on invalidation', async () => {
    await store('k1', 'u-1', 5000)
    await store('k2', 'u-1', 5000)
    await store('k3', 'u-1', 5000)

    await cache.invalidate('u-1')

    await expect(cache.get('k1')).resolves.toBeNull()
    await expect(cache.get('k2')).resolves.toBeNull()
    await expect(cache.get('k3')).resolves.toBeNull()
  })

  it('leaves other users untouched when one user is invalidated', async () => {
    await store('mine', 'u-1', 5000)
    await store('theirs', 'u-2', 5000)

    await cache.invalidate('u-1')

    await expect(cache.get('mine')).resolves.toBeNull()
    await expect(cache.get('theirs')).resolves.toBe('token-for-theirs')
  })

  it('invalidating a user with nothing cached is a no-op', async () => {
    await store('theirs', 'u-2', 5000)

    await expect(cache.invalidate('u-1')).resolves.toBeUndefined()
    await expect(cache.get('theirs')).resolves.toBe('token-for-theirs')
  })

  it('still invalidates tokens cached after an earlier invalidation of the same user', async () => {
    await store('k1', 'u-1', 5000)
    await cache.invalidate('u-1')

    await store('k2', 'u-1', 5000)
    await cache.invalidate('u-1')

    await expect(cache.get('k2')).resolves.toBeNull()
  })
})

describe('RedisCrossServiceTokenCache', () => {
  let pipeline: { sadd: jest.Mock; expireat: jest.Mock; set: jest.Mock; del: jest.Mock; exec: jest.Mock }
  let redisClient: IORedis.Redis
  let cache: RedisCrossServiceTokenCache

  beforeEach(() => {
    pipeline = {
      sadd: jest.fn(),
      expireat: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exec: jest.fn().mockResolvedValue([]),
    }

    redisClient = {
      pipeline: jest.fn(() => pipeline),
      get: jest.fn().mockResolvedValue(null),
      smembers: jest.fn().mockResolvedValue([]),
    } as unknown as IORedis.Redis

    cache = new RedisCrossServiceTokenCache(redisClient)
  })

  it('stores the token and indexes it against the user, expiring both at the same time', async () => {
    await cache.set({
      key: 'k1',
      encodedCrossServiceToken: 'encoded',
      expiresAtInSeconds: 2000,
      userUuid: 'u-1',
    })

    expect(pipeline.set).toHaveBeenCalledWith('cst:k1', 'encoded')
    expect(pipeline.expireat).toHaveBeenCalledWith('cst:k1', 2000)
    expect(pipeline.sadd).toHaveBeenCalledWith('user-cst:u-1', 'k1')
    expect(pipeline.expireat).toHaveBeenCalledWith('user-cst:u-1', 2000)
    expect(pipeline.exec).toHaveBeenCalled()
  })

  it('reads the token under the prefixed key', async () => {
    ;(redisClient.get as jest.Mock).mockResolvedValue('encoded')

    await expect(cache.get('k1')).resolves.toBe('encoded')
    expect(redisClient.get).toHaveBeenCalledWith('cst:k1')
  })

  it('reports a cache miss as null', async () => {
    await expect(cache.get('k1')).resolves.toBeNull()
  })

  it('deletes every key indexed against the user, and the index itself', async () => {
    ;(redisClient.smembers as jest.Mock).mockResolvedValue(['k1', 'k2'])

    await cache.invalidate('u-1')

    expect(redisClient.smembers).toHaveBeenCalledWith('user-cst:u-1')
    expect(pipeline.del).toHaveBeenCalledWith('cst:k1')
    expect(pipeline.del).toHaveBeenCalledWith('cst:k2')
    expect(pipeline.del).toHaveBeenCalledWith('user-cst:u-1')
    expect(pipeline.exec).toHaveBeenCalled()
  })

  it('still clears the user index when the user has no cached tokens', async () => {
    await cache.invalidate('u-1')

    expect(pipeline.del).toHaveBeenCalledTimes(1)
    expect(pipeline.del).toHaveBeenCalledWith('user-cst:u-1')
    expect(pipeline.exec).toHaveBeenCalled()
  })
})
