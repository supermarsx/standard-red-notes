import * as IORedis from 'ioredis'

import { RedisProofOfWorkChallengeRepository } from './RedisProofOfWorkChallengeRepository'

describe('RedisProofOfWorkChallengeRepository', () => {
  let redisClient: jest.Mocked<IORedis.Redis>
  let repository: RedisProofOfWorkChallengeRepository

  beforeEach(() => {
    redisClient = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
    } as unknown as jest.Mocked<IORedis.Redis>

    repository = new RedisProofOfWorkChallengeRepository(redisClient)
  })

  describe('storeChallenge', () => {
    it('stores the difficulty under a scoped key with the TTL via SETEX', async () => {
      await repository.storeChallenge('seed-1', 'register', 12, 600)

      expect(redisClient.setex).toHaveBeenCalledWith('pow:register:seed-1', 600, '12')
    })

    it('floors and enforces a minimum 1s TTL so SETEX never gets a zero/negative expiry', async () => {
      await repository.storeChallenge('seed-2', 'signIn', 16, 0.4)

      expect(redisClient.setex).toHaveBeenCalledWith('pow:signIn:seed-2', 1, '16')
    })
  })

  describe('getChallengeDifficulty', () => {
    it('returns the stored numeric difficulty', async () => {
      redisClient.get.mockResolvedValue('12')

      const result = await repository.getChallengeDifficulty('seed-1', 'register')

      expect(result).toBe(12)
      expect(redisClient.get).toHaveBeenCalledWith('pow:register:seed-1')
    })

    it('returns null when the challenge is missing/expired', async () => {
      redisClient.get.mockResolvedValue(null)

      const result = await repository.getChallengeDifficulty('seed-1', 'register')

      expect(result).toBeNull()
    })

    it('returns null when the stored value is not a number (NaN guard)', async () => {
      redisClient.get.mockResolvedValue('NaN')

      const result = await repository.getChallengeDifficulty('seed-1', 'register')

      expect(result).toBeNull()
    })
  })

  describe('consumeChallenge', () => {
    it('returns true exactly once for a live key and false on repeat (atomic single-use)', async () => {
      redisClient.del.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

      const first = await repository.consumeChallenge('seed-1', 'register')
      const second = await repository.consumeChallenge('seed-1', 'register')

      expect(first).toBe(true)
      expect(second).toBe(false)
      expect(redisClient.del).toHaveBeenCalledWith('pow:register:seed-1')
    })

    it('returns false when nothing was removed', async () => {
      redisClient.del.mockResolvedValue(0)

      const result = await repository.consumeChallenge('unknown', 'signIn')

      expect(result).toBe(false)
    })
  })
})
