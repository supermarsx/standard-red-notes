import * as IORedis from 'ioredis'

import { RedisIpEscalationChecker } from './RedisIpEscalationChecker'

describe('RedisIpEscalationChecker', () => {
  let redisClient: jest.Mocked<IORedis.Redis>

  beforeEach(() => {
    redisClient = {
      exists: jest.fn(),
    } as unknown as jest.Mocked<IORedis.Redis>
  })

  it('reports escalated when adaptive escalation is on and the flag key exists', async () => {
    redisClient.exists.mockResolvedValue(1)
    const checker = new RedisIpEscalationChecker(redisClient, async () => true)

    expect(await checker.isEscalated('1.2.3.4')).toBe(true)
    expect(redisClient.exists).toHaveBeenCalledWith('rl:escalate:1.2.3.4')
  })

  it('reports NOT escalated when the flag key is absent', async () => {
    redisClient.exists.mockResolvedValue(0)
    const checker = new RedisIpEscalationChecker(redisClient, async () => true)

    expect(await checker.isEscalated('1.2.3.4')).toBe(false)
  })

  it('is config-gated: does not even read Redis when adaptive escalation is off', async () => {
    const checker = new RedisIpEscalationChecker(redisClient, async () => false)

    expect(await checker.isEscalated('1.2.3.4')).toBe(false)
    expect(redisClient.exists).not.toHaveBeenCalled()
  })

  it('fails open (false) when Redis throws', async () => {
    redisClient.exists.mockRejectedValue(new Error('redis down'))
    const checker = new RedisIpEscalationChecker(redisClient, async () => true)

    expect(await checker.isEscalated('1.2.3.4')).toBe(false)
  })

  it('returns false for an empty IP without touching Redis', async () => {
    const checker = new RedisIpEscalationChecker(redisClient, async () => true)

    expect(await checker.isEscalated('')).toBe(false)
    expect(redisClient.exists).not.toHaveBeenCalled()
  })
})
