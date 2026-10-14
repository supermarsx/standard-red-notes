import 'reflect-metadata'
import { RedisEphemeralSessionRepository } from './RedisEphemeralSessionRepository'
import { EphemeralSession } from '../../Domain/Session/EphemeralSession'
import { AuthGenerationChangedError } from '../../Domain/Session/AuthSessionGenerationService'

describe('atomic Redis ephemeral refresh', () => {
  it('pages only primary cleanup keys and retains scan overflow without fetching an unbounded session batch', async () => {
    const keys = Array.from({ length: 201 }, (_, index) => `session:id${index}`)
    const redis = {
      scan: jest
        .fn()
        .mockResolvedValueOnce(['7', [...keys, 'session:id:alias']])
        .mockResolvedValue(['0', []]),
      mget: jest.fn(async (...batch: string[]) =>
        batch.map((key) => JSON.stringify({ uuid: key.slice(8), userUuid: 'user' })),
      ),
    }
    const repository = new RedisEphemeralSessionRepository(redis as never, 120)
    expect(await repository.getNextCleanupBatch(200)).toHaveLength(200)
    expect(await repository.getNextCleanupBatch(200)).toHaveLength(1)
    expect(redis.scan).toHaveBeenCalledTimes(1)
    expect(await repository.getNextCleanupBatch(200)).toEqual([])
    expect(redis.scan).toHaveBeenLastCalledWith('7', 'MATCH', 'session:*', 'COUNT', 200)
    expect(redis.mget.mock.calls.every((batch) => batch.length <= 200)).toBe(true)
  })
  it('issues one conditional atomic command, reports missing sessions and never calls insert', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1), pipeline: jest.fn() }
    const repository = new RedisEphemeralSessionRepository(redis as never, 120)
    const item = Object.assign(new EphemeralSession(), { uuid: 'a', userUuid: 'u', privateIdentifier: 'p' })
    await repository.update(item)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXISTS', KEYS[1])"),
      4,
      'session:a',
      'session:a:u',
      'session-private-id:p',
      'user-sessions:u',
      120,
      JSON.stringify(item),
      'u',
    )
    redis.eval.mockResolvedValueOnce(0)
    await expect(repository.update(item)).rejects.toBeInstanceOf(AuthGenerationChangedError)
    expect(redis.pipeline).not.toHaveBeenCalled()
    await repository.deleteOne('a', 'u')
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('SREM', KEYS[3], ARGV[2])"),
      3,
      'session:a',
      'session:a:u',
      'user-sessions:u',
      'u',
      'a',
      'session-private-id:',
    )
  })
})
