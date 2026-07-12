import { Logger } from 'winston'

import { RuntimeLogLevelApplier } from './RuntimeLogLevelApplier'

type FakeLogger = { level: string; transports: Array<{ level: string }> }

const makeLogger = (initialLevel = 'info'): FakeLogger => ({
  level: initialLevel,
  transports: [{ level: initialLevel }, { level: initialLevel }],
})

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('RuntimeLogLevelApplier', () => {
  it('applies a valid resolved level to the logger AND every transport', async () => {
    const logger = makeLogger('info')
    const applier = new RuntimeLogLevelApplier(logger as unknown as Logger, () => Promise.resolve('debug'), 'info')

    await applier.applyOnce()

    expect(logger.level).toBe('debug')
    expect(logger.transports.every((transport) => transport.level === 'debug')).toBe(true)
  })

  it('falls back to the fallback level when the resolved value is unknown', async () => {
    const logger = makeLogger('info')
    const applier = new RuntimeLogLevelApplier(logger as unknown as Logger, () => Promise.resolve('nonsense'), 'warn')

    await applier.applyOnce()

    expect(logger.level).toBe('warn')
  })

  it('falls back to the fallback level when nothing is persisted (undefined)', async () => {
    const logger = makeLogger('info')
    const applier = new RuntimeLogLevelApplier(logger as unknown as Logger, () => Promise.resolve(undefined), 'error')

    await applier.applyOnce()

    expect(logger.level).toBe('error')
  })

  it('falls back to "info" when even the fallback is invalid', async () => {
    const logger = makeLogger('debug')
    const applier = new RuntimeLogLevelApplier(logger as unknown as Logger, () => Promise.resolve(undefined), 'bogus')

    await applier.applyOnce()

    expect(logger.level).toBe('info')
  })

  it('SWALLOWS a getter error and leaves the current level untouched', async () => {
    const logger = makeLogger('info')
    const applier = new RuntimeLogLevelApplier(
      logger as unknown as Logger,
      () => Promise.reject(new Error('overlay unreadable')),
      'warn',
    )

    await expect(applier.applyOnce()).resolves.toBeUndefined()
    expect(logger.level).toBe('info')
  })

  it('start() applies once without throwing and stop() clears the poll', async () => {
    const logger = makeLogger('info')
    const getter = jest.fn().mockResolvedValue('error')
    const applier = new RuntimeLogLevelApplier(logger as unknown as Logger, getter, 'info', 30_000)

    expect(() => applier.start()).not.toThrow()
    await flush()
    applier.stop()

    expect(getter).toHaveBeenCalled()
    expect(logger.level).toBe('error')
  })
})
