import * as IORedis from 'ioredis'

import { RedisLockRepository } from './RedisLockRepository'

describe('RedisLockRepository', () => {
  let redisClient: jest.Mocked<IORedis.Redis>
  const maxLoginAttempts = 6

  const createRepository = () => new RedisLockRepository(redisClient, maxLoginAttempts, 3600, 3600)

  beforeEach(() => {
    redisClient = {
      get: jest.fn(),
      ttl: jest.fn(),
      scan: jest.fn(),
      del: jest.fn(),
      pipeline: jest.fn(),
    } as unknown as jest.Mocked<IORedis.Redis>
  })

  describe('listLockedAccounts', () => {
    it('SCANs both lock tiers and merges by identifier, flagging accounts over the threshold as locked', async () => {
      // First SCAN call is the non-captcha 'lock:*' tier, second is 'captcha-lock:*'.
      ;(redisClient.scan as jest.Mock)
        .mockResolvedValueOnce(['0', ['lock:alice@example.com', 'lock:bob-uuid']])
        .mockResolvedValueOnce(['0', ['captcha-lock:alice@example.com']])

      ;(redisClient.get as unknown as jest.Mock).mockImplementation((key: string) => {
        const values: Record<string, string> = {
          'lock:alice@example.com': '4',
          'lock:bob-uuid': '2',
          'captcha-lock:alice@example.com': '7',
        }
        return Promise.resolve(values[key] ?? null)
      })
      redisClient.ttl.mockResolvedValue(1800)

      const accounts = await createRepository().listLockedAccounts()

      const alice = accounts.find((account) => account.identifier === 'alice@example.com')
      const bob = accounts.find((account) => account.identifier === 'bob-uuid')

      expect(alice).toEqual({
        identifier: 'alice@example.com',
        counter: 4,
        captchaCounter: 7,
        ttlSeconds: 1800,
        locked: true, // captcha 7 >= max 6
      })
      expect(bob).toEqual({
        identifier: 'bob-uuid',
        counter: 2,
        captchaCounter: 0,
        ttlSeconds: 1800,
        locked: false, // captcha 0 < max 6
      })
      // SCAN, not KEYS.
      expect(redisClient.scan).toHaveBeenCalledWith('0', 'MATCH', 'lock:*', 'COUNT', 200)
      expect(redisClient.scan).toHaveBeenCalledWith('0', 'MATCH', 'captcha-lock:*', 'COUNT', 200)
    })

    it('follows the SCAN cursor across multiple pages', async () => {
      ;(redisClient.scan as jest.Mock)
        // non-captcha tier paginated
        .mockResolvedValueOnce(['42', ['lock:a']])
        .mockResolvedValueOnce(['0', ['lock:b']])
        // captcha tier empty
        .mockResolvedValueOnce(['0', []])

      redisClient.get.mockResolvedValue('1')
      redisClient.ttl.mockResolvedValue(10)

      const accounts = await createRepository().listLockedAccounts()

      expect(accounts.map((account) => account.identifier).sort()).toEqual(['a', 'b'])
      expect(redisClient.scan).toHaveBeenCalledWith('42', 'MATCH', 'lock:*', 'COUNT', 200)
    })

    it('returns an empty list when nothing is locked', async () => {
      ;(redisClient.scan as jest.Mock).mockResolvedValueOnce(['0', []]).mockResolvedValueOnce(['0', []])

      const accounts = await createRepository().listLockedAccounts()

      expect(accounts).toEqual([])
    })
  })
})
