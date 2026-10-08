import {
  createIpEscalationRecorder,
  ESCALATE_KEY_PREFIX,
  ESCALATE_WINDOW_MULTIPLE,
  IpEscalationWriter,
  recordIpEscalation,
} from './IpEscalationSignal'

describe('recordIpEscalation', () => {
  const IP = '203.0.113.7'
  const KEY = `${ESCALATE_KEY_PREFIX}:${IP}`

  let resolveConfig: jest.Mock
  let redisSet: jest.Mock
  let store: jest.Mocked<IpEscalationWriter>

  beforeEach(() => {
    resolveConfig = jest.fn().mockResolvedValue({ adaptiveEscalation: true, windowSeconds: 60 })
    redisSet = jest.fn().mockResolvedValue('OK')
    store = { escalate: jest.fn().mockResolvedValue(undefined) }
  })

  describe('with a shared Redis cache', () => {
    it('writes the flag with SET ... EX, which is what every Redis topology already did', async () => {
      await recordIpEscalation({ resolveConfig, redis: { set: redisSet }, resolveStore: () => store }, IP)

      expect(redisSet).toHaveBeenCalledWith(KEY, '1', 'EX', 60 * ESCALATE_WINDOW_MULTIPLE)
    })

    it('PREFERS the cache client, so a Redis deployment keeps the exact path it had', async () => {
      await recordIpEscalation({ resolveConfig, redis: { set: redisSet }, resolveStore: () => store }, IP)

      expect(store.escalate).not.toHaveBeenCalled()
    })
  })

  describe('with no cache client', () => {
    it('writes through the table-backed store instead, which is what auth reads', async () => {
      await recordIpEscalation({ resolveConfig, resolveStore: () => store }, IP)

      expect(store.escalate).toHaveBeenCalledWith(IP, 60 * ESCALATE_WINDOW_MULTIPLE)
    })

    it('resolves the store PER REFUSAL, because the container that holds it is loaded later', async () => {
      const resolveStore = jest.fn().mockReturnValue(store)

      await recordIpEscalation({ resolveConfig, resolveStore }, IP)
      await recordIpEscalation({ resolveConfig, resolveStore }, IP)

      expect(resolveStore).toHaveBeenCalledTimes(2)
    })

    it('does nothing at all when neither backend is there, rather than throwing into the refusal branch', async () => {
      await expect(recordIpEscalation({ resolveConfig }, IP)).resolves.toBeUndefined()
      await expect(recordIpEscalation({ resolveConfig, resolveStore: () => undefined }, IP)).resolves.toBeUndefined()
    })

    it('treats a client WITHOUT a callable set as no client, instead of dereferencing it', async () => {
      await recordIpEscalation({ resolveConfig, redis: {} as { set?: never }, resolveStore: () => store }, IP)

      expect(store.escalate).toHaveBeenCalledWith(IP, 60 * ESCALATE_WINDOW_MULTIPLE)
    })
  })

  describe('the config gate', () => {
    it('writes nothing when adaptive escalation is off', async () => {
      resolveConfig.mockResolvedValue({ adaptiveEscalation: false, windowSeconds: 60 })

      await recordIpEscalation({ resolveConfig, redis: { set: redisSet }, resolveStore: () => store }, IP)

      expect(redisSet).not.toHaveBeenCalled()
      expect(store.escalate).not.toHaveBeenCalled()
    })

    it('re-reads the config on every refusal, so an admin toggle applies without a restart', async () => {
      resolveConfig
        .mockResolvedValueOnce({ adaptiveEscalation: false, windowSeconds: 60 })
        .mockResolvedValueOnce({ adaptiveEscalation: true, windowSeconds: 60 })

      await recordIpEscalation({ resolveConfig, resolveStore: () => store }, IP)
      await recordIpEscalation({ resolveConfig, resolveStore: () => store }, IP)

      expect(store.escalate).toHaveBeenCalledTimes(1)
    })

    it('REFUSES TO WRITE A FLAG IT COULD NOT EXPIRE, because a permanent demand locks out the address', async () => {
      for (const windowSeconds of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
        resolveConfig.mockResolvedValue({ adaptiveEscalation: true, windowSeconds })
        await recordIpEscalation({ resolveConfig, redis: { set: redisSet }, resolveStore: () => store }, IP)
      }

      expect(redisSet).not.toHaveBeenCalled()
      expect(store.escalate).not.toHaveBeenCalled()
    })

    it('ignores an empty address without consulting anything', async () => {
      await recordIpEscalation({ resolveConfig, redis: { set: redisSet }, resolveStore: () => store }, '')

      expect(resolveConfig).not.toHaveBeenCalled()
      expect(redisSet).not.toHaveBeenCalled()
    })
  })

  describe('it never reaches the limiter', () => {
    it('swallows a config-resolution failure', async () => {
      resolveConfig.mockRejectedValue(new Error('overlay unreadable'))

      await expect(
        recordIpEscalation({ resolveConfig, redis: { set: redisSet }, resolveStore: () => store }, IP),
      ).resolves.toBeUndefined()
    })

    it('swallows a cache write failure', async () => {
      redisSet.mockRejectedValue(new Error('cache down'))

      await expect(recordIpEscalation({ resolveConfig, redis: { set: redisSet } }, IP)).resolves.toBeUndefined()
    })

    it('swallows a store write failure', async () => {
      store.escalate.mockRejectedValue(new Error('database busy'))

      await expect(recordIpEscalation({ resolveConfig, resolveStore: () => store }, IP)).resolves.toBeUndefined()
    })

    it('swallows a store RESOLUTION failure, which is what an unbound symbol throws', async () => {
      const resolveStore = jest.fn().mockImplementation(() => {
        throw new Error('No matching bindings found')
      })

      await expect(recordIpEscalation({ resolveConfig, resolveStore }, IP)).resolves.toBeUndefined()
    })
  })
})

describe('createIpEscalationRecorder', () => {
  it('hands back a SYNCHRONOUS hook, because that is the shape onThrottle takes', async () => {
    const store: IpEscalationWriter = { escalate: jest.fn().mockResolvedValue(undefined) }
    const recorder = createIpEscalationRecorder({
      resolveConfig: jest.fn().mockResolvedValue({ adaptiveEscalation: true, windowSeconds: 10 }),
      resolveStore: () => store,
    })

    expect(recorder('203.0.113.7')).toBeUndefined()

    await new Promise((resolve) => setImmediate(resolve))
    expect(store.escalate).toHaveBeenCalledWith('203.0.113.7', 50)
  })

  it('does not throw out of the refusal branch when everything underneath fails', async () => {
    const recorder = createIpEscalationRecorder({
      resolveConfig: jest.fn().mockRejectedValue(new Error('nope')),
    })

    expect(() => recorder('203.0.113.7')).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
  })
})
