import { MutableLevelLogger, RuntimeLogLevelApplier } from './RuntimeLogLevelApplier'

describe('RuntimeLogLevelApplier', () => {
  const makeLogger = (level = 'info'): MutableLevelLogger => ({
    level,
    transports: [{ level }, { level }],
  })

  it('applies the resolved level to the logger and every transport on applyOnce', async () => {
    const logger = makeLogger('info')
    const applier = new RuntimeLogLevelApplier(logger, async () => 'debug')

    await applier.applyOnce()

    expect(logger.level).toBe('debug')
    expect(logger.transports.map((t) => t.level)).toEqual(['debug', 'debug'])
  })

  it('ignores an invalid resolved level (leaves the logger untouched)', async () => {
    const logger = makeLogger('info')
    const applier = new RuntimeLogLevelApplier(logger, async () => 'bogus')

    await applier.applyOnce()

    expect(logger.level).toBe('info')
    expect(logger.transports.map((t) => t.level)).toEqual(['info', 'info'])
  })

  it('swallows a rejected resolver — never throws — and leaves the logger untouched', async () => {
    const logger = makeLogger('warn')
    const applier = new RuntimeLogLevelApplier(logger, async () => {
      throw new Error('overlay unreadable')
    })

    await expect(applier.applyOnce()).resolves.toBeUndefined()
    expect(logger.level).toBe('warn')
  })

  it('start() applies once immediately at boot and does not throw, then can be stopped', async () => {
    const logger = makeLogger('info')
    const resolve = jest.fn(async () => 'error')
    const applier = new RuntimeLogLevelApplier(logger, resolve, 30_000)

    expect(() => applier.start()).not.toThrow()
    // The boot apply is scheduled as a microtask; let it flush.
    await Promise.resolve()
    await Promise.resolve()

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(logger.level).toBe('error')

    applier.stop()
  })

  it('start() is idempotent (a second call does not start a second interval)', () => {
    const logger = makeLogger('info')
    const setInterval = jest.spyOn(global, 'setInterval')
    const applier = new RuntimeLogLevelApplier(logger, async () => 'info')

    applier.start()
    applier.start()

    expect(setInterval).toHaveBeenCalledTimes(1)

    applier.stop()
    setInterval.mockRestore()
  })
})
