import * as IORedis from 'ioredis'

import { RedisLockRepository } from './RedisLockRepository'

describe('RedisLockRepository', () => {
  let redisClient: jest.Mocked<IORedis.Redis>
  let multiCalls: Array<Array<unknown[]>>
  const maxLoginAttempts = 6

  const createRepository = (nonCaptchaTTL = 3600, captchaTTL = 3600) =>
    new RedisLockRepository(redisClient, maxLoginAttempts, nonCaptchaTTL, captchaTTL)

  beforeEach(() => {
    multiCalls = []
    redisClient = {
      get: jest.fn(),
      ttl: jest.fn(),
      scan: jest.fn(),
      del: jest.fn(),
      setex: jest.fn(),
      pipeline: jest.fn(),
      // A MULTI recorder: every queued command lands in one array so a test can
      // assert BOTH the commands and that they were queued on the same
      // transaction (the property that makes the pair atomic).
      multi: jest.fn().mockImplementation(() => {
        const queued: Array<unknown[]> = []
        multiCalls.push(queued)
        const chain = {
          set: (...args: unknown[]) => {
            queued.push(['set', ...args])

            return chain
          },
          expire: (...args: unknown[]) => {
            queued.push(['expire', ...args])

            return chain
          },
          exec: () => Promise.resolve([]),
        }

        return chain
      }),
    } as unknown as jest.Mocked<IORedis.Redis>
  })

  describe('updateLockCounter', () => {
    it('KEEPS THE HORIZON THE FIRST FAILURE ARMED and arms one only when the key has none', async () => {
      await createRepository(20, 25).updateLockCounter('alice-uuid', 2, 'non-captcha')

      expect(multiCalls).toHaveLength(1)
      expect(multiCalls[0]).toEqual([
        ['set', 'lock:alice-uuid', 2, 'KEEPTTL'],
        ['expire', 'lock:alice-uuid', 20, 'NX'],
      ])
    })

    it('never re-arms unconditionally: SETEX, which slid the window on every increment, is gone', async () => {
      await createRepository(20, 25).updateLockCounter('alice-uuid', 3, 'non-captcha')

      expect(redisClient.setex).not.toHaveBeenCalled()
    })

    it('queues the pair on ONE transaction, so a death between them cannot strand a key with no TTL', async () => {
      await createRepository(20, 25).updateLockCounter('alice-uuid', 1, 'non-captcha')

      expect(redisClient.multi).toHaveBeenCalledTimes(1)
      expect(multiCalls[0]).toHaveLength(2)
    })

    it('writes the captcha tier under its own key and its own TTL', async () => {
      await createRepository(20, 25).updateLockCounter('alice-uuid', 1, 'captcha')

      expect(multiCalls[0]).toEqual([
        ['set', 'captcha-lock:alice-uuid', 1, 'KEEPTTL'],
        ['expire', 'captcha-lock:alice-uuid', 25, 'NX'],
      ])
    })
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
