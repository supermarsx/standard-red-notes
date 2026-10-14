import 'reflect-metadata'
import { RedisPKCERepository } from './RedisPKCERepository'
import { LoginGrantScope } from '../../Domain/User/LoginGrantScope'
import { User } from '../../Domain/User/User'

describe('Redis verified login grants', () => {
  let now: number
  let factor: string
  let rows: Map<string, number>
  const user = { uuid: 'one' } as User
  const scope = { key: async (challenge: string, account: User, flow: string) => `${account.uuid}:${flow}:${factor}:${challenge}` } as LoginGrantScope
  const redis = {
    setex: jest.fn(async (key: string, seconds: number) => { rows.set(key, now + seconds * 1000) }),
    del: jest.fn(async (key: string) => { const expiry = rows.get(key); const removed = rows.delete(key); return removed && expiry! > now ? 1 : 0 }),
  }
  const repository = new RedisPKCERepository(redis as never, { debug: jest.fn() } as never, scope)
  beforeEach(() => { rows = new Map(); factor = 'none'; now = Date.now(); jest.clearAllMocks() })
  it('requires the same verified account/flow/current factor and consumes atomically once', async () => {
    await repository.storeCodeChallenge('challenge', user, 'login', await repository.captureGrantScope(user, 'login'))
    expect(await repository.removeCodeChallenge('challenge', { uuid: 'another' } as User, 'login')).toBe(false)
    expect(await repository.removeCodeChallenge('challenge', user, 'recovery')).toBe(false)
    const results = await Promise.all([repository.removeCodeChallenge('challenge', user, 'login'), repository.removeCodeChallenge('challenge', user, 'login')])
    expect(results.sort()).toEqual([false, true])
  })
  it('refuses policy changes both before issuance and after issuance', async () => {
    const verified = await repository.captureGrantScope(user, 'login')
    factor = 'totp'
    await expect(repository.storeCodeChallenge('challenge', user, 'login', verified)).rejects.toThrow('policy changed')
    await repository.storeCodeChallenge('challenge', user, 'login', await repository.captureGrantScope(user, 'login'))
    factor = 'new-totp'
    expect(await repository.removeCodeChallenge('challenge', user, 'login')).toBe(false)
  })
  it('retains the one-hour expiry contract', async () => {
    await repository.storeCodeChallenge('challenge', user, 'login', await repository.captureGrantScope(user, 'login'))
    expect(redis.setex).toHaveBeenCalledWith(expect.any(String), 3600, 'verified')
    now += 3601000
    expect(await repository.removeCodeChallenge('challenge', user, 'login')).toBe(false)
  })
})
