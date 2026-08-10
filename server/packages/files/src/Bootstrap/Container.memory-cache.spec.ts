import 'reflect-metadata'

import { ContainerConfigLoader } from './Container'
import TYPES from './Types'
import { InMemoryValetTokenRepository } from '../Infra/InMemory/InMemoryValetTokenRepository'
import { RedisValetTokenRepository } from '../Infra/Redis/RedisValetTokenRepository'

describe('files cache topology', () => {
  it('boots the advertised memory-cache profile without binding or requiring Redis', async () => {
    const container = await new ContainerConfigLoader().load({
      environmentOverrides: {
        CACHE_TYPE: 'memory',
        MODE: 'home-server',
        VALET_TOKEN_SECRET: 'test-valet-token-secret',
      },
    })

    expect(container.isBound(TYPES.Files_Redis)).toBe(false)
    expect(container.isBound(TYPES.Files_REDIS_URL)).toBe(false)
    expect(container.get(TYPES.Files_ValetTokenRepository)).toBeInstanceOf(InMemoryValetTokenRepository)
  })

  it('preserves the Redis-backed valet repository in the production Redis profile', async () => {
    const container = await new ContainerConfigLoader().load({
      environmentOverrides: {
        CACHE_TYPE: 'redis',
        MODE: 'home-server',
        REDIS_URL: 'redis://127.0.0.1:1',
        VALET_TOKEN_SECRET: 'test-valet-token-secret',
      },
    })

    const redis = container.get<{ disconnect(): void }>(TYPES.Files_Redis)
    try {
      expect(container.get(TYPES.Files_ValetTokenRepository)).toBeInstanceOf(RedisValetTokenRepository)
    } finally {
      redis.disconnect()
    }
  })
})
