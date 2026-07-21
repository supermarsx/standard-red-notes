import * as IORedis from 'ioredis'

import { RedisValetTokenRepository } from './RedisValetTokenRepository'

describe('RedisValetTokenRepository', () => {
  let redisClient: IORedis.Redis

  const createRepository = () => new RedisValetTokenRepository(redisClient)

  beforeEach(() => {
    redisClient = {} as jest.Mocked<IORedis.Redis>
    redisClient.setex = jest.fn()
    redisClient.get = jest.fn().mockResolvedValue(null)
  })

  it('marks a valet token as used for a day under a namespaced key', async () => {
    await createRepository().markAsUsed('valet-token')

    expect(redisClient.setex).toHaveBeenCalledWith('vt:valet-token', 86400, 'used')
  })

  it('reports a token that redis still holds as used', async () => {
    redisClient.get = jest.fn().mockResolvedValue('used')

    expect(await createRepository().isUsed('valet-token')).toBe(true)
    expect(redisClient.get).toHaveBeenCalledWith('vt:valet-token')
  })

  it('reports a token redis has never seen as unused', async () => {
    expect(await createRepository().isUsed('valet-token')).toBe(false)
  })

  it('reports a token whose key holds some other value as unused', async () => {
    redisClient.get = jest.fn().mockResolvedValue('something-else')

    expect(await createRepository().isUsed('valet-token')).toBe(false)
  })
})
