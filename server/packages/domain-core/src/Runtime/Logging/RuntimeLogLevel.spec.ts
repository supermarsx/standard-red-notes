import {
  MutableRuntimeLogLevelLogger,
  RuntimeLogLevelApplier,
  ServerSettingsLogLevelResolver,
  normalizeRuntimeLogLevel,
} from './RuntimeLogLevel'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('runtime log level', () => {
  it('normalizes only supported Winston levels', () => {
    expect(normalizeRuntimeLogLevel(' WARN ')).toBe('warn')
    expect(normalizeRuntimeLogLevel('chatty')).toBeUndefined()
    expect(normalizeRuntimeLogLevel(1)).toBeUndefined()
  })

  it('gives a valid persisted overlay precedence over the environment baseline', async () => {
    const readTextFile = jest.fn().mockResolvedValue(JSON.stringify({ logging: { level: 'DEBUG' } }))
    const resolver = new ServerSettingsLogLevelResolver('/data/server-settings.json', 'warn', readTextFile)

    await expect(resolver.resolve()).resolves.toBe('debug')
    expect(readTextFile).toHaveBeenCalledWith('/data/server-settings.json')
  })

  it.each([
    ['missing file', () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))],
    ['unreadable file', () => Promise.reject(new Error('denied'))],
    ['malformed JSON', () => Promise.resolve('{')],
    ['invalid overlay level', () => Promise.resolve(JSON.stringify({ logging: { level: 'chatty' } }))],
    ['invalid overlay shape', () => Promise.resolve(JSON.stringify({ logging: [] }))],
  ])('falls back to the environment baseline for a %s', async (_description, readTextFile) => {
    const resolver = new ServerSettingsLogLevelResolver('/data/server-settings.json', 'error', readTextFile)

    await expect(resolver.resolve()).resolves.toBe('error')
  })

  it('uses info when no valid path or environment baseline exists', async () => {
    const readTextFile = jest.fn()
    const resolver = new ServerSettingsLogLevelResolver(' ', 'chatty', readTextFile)

    await expect(resolver.resolve()).resolves.toBe('info')
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('bounds the real overlay file and rejects non-regular paths', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-runtime-log-'))
    const oversizedPath = path.join(directory, 'oversized.json')
    try {
      await fs.writeFile(
        oversizedPath,
        JSON.stringify({ logging: { level: 'debug' }, padding: 'x'.repeat(1024 * 1024) }),
        'utf8',
      )

      await expect(new ServerSettingsLogLevelResolver(oversizedPath, 'warn').resolve()).resolves.toBe('warn')
      await expect(new ServerSettingsLogLevelResolver(directory, 'error').resolve()).resolves.toBe('error')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('updates every logger and transport and deduplicates repeated logger references', async () => {
    const first = makeLogger('info', ['info', 'error'])
    const second = makeLogger('warn', ['warn'])
    const resolver = { resolve: jest.fn().mockResolvedValue('debug' as const) }
    const applier = new RuntimeLogLevelApplier([first, second, first], resolver)

    await applier.applyOnce()

    expect(first.level).toBe('debug')
    expect(first.transports.map((transport) => transport.level)).toEqual(['debug', 'debug'])
    expect(second.level).toBe('debug')
    expect(second.transports[0].level).toBe('debug')
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it('leaves current levels intact when a custom resolver fails or returns an invalid value', async () => {
    const logger = makeLogger('warn', ['error'])
    const resolver = { resolve: jest.fn<Promise<string>, []>().mockRejectedValue(new Error('read failed')) }
    const applier = new RuntimeLogLevelApplier(logger, resolver)

    await expect(applier.applyOnce()).resolves.toBeUndefined()
    expect(logger.level).toBe('warn')
    expect(logger.transports[0].level).toBe('error')

    resolver.resolve.mockResolvedValue('chatty')
    await expect(applier.applyOnce()).resolves.toBeUndefined()
    expect(logger.level).toBe('warn')
    expect(logger.transports[0].level).toBe('error')
  })

  it('starts one unrefed poller, applies immediately, and supports stop plus restart', async () => {
    jest.useFakeTimers()
    try {
      const logger = makeLogger('info', ['info'])
      const resolver = { resolve: jest.fn().mockResolvedValue('debug' as const) }
      const applier = new RuntimeLogLevelApplier(logger, resolver, 1_000)

      applier.start()
      applier.start()
      await Promise.resolve()
      expect(resolver.resolve).toHaveBeenCalledTimes(1)

      await jest.advanceTimersByTimeAsync(2_000)
      expect(resolver.resolve).toHaveBeenCalledTimes(3)

      applier.stop()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(resolver.resolve).toHaveBeenCalledTimes(3)

      applier.start()
      await Promise.resolve()
      expect(resolver.resolve).toHaveBeenCalledTimes(4)
      applier.stop()
    } finally {
      jest.useRealTimers()
    }
  })

  it('serializes slow polls and coalesces any number of overlapping interval ticks', async () => {
    jest.useFakeTimers()
    try {
      const logger = makeLogger('info', ['info'])
      const first = deferred<'debug'>()
      const second = deferred<'warn'>()
      const resolver = {
        resolve: jest
          .fn()
          .mockImplementationOnce(() => first.promise)
          .mockImplementationOnce(() => second.promise),
      }
      const applier = new RuntimeLogLevelApplier(logger, resolver, 1_000)

      applier.start()
      await jest.advanceTimersByTimeAsync(5_000)
      expect(resolver.resolve).toHaveBeenCalledTimes(1)

      first.resolve('debug')
      await flushPromises()
      expect(logger.level).toBe('debug')
      expect(resolver.resolve).toHaveBeenCalledTimes(2)

      second.resolve('warn')
      await flushPromises()
      expect(logger.level).toBe('warn')
      expect(resolver.resolve).toHaveBeenCalledTimes(2)
      applier.stop()
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not let an in-flight pre-stop read mutate loggers that may be closing', async () => {
    const logger = makeLogger('info', ['info'])
    const pending = deferred<'debug'>()
    const resolver = { resolve: jest.fn().mockReturnValue(pending.promise) }
    const applier = new RuntimeLogLevelApplier(logger, resolver)

    applier.start()
    applier.stop()
    pending.resolve('debug')
    await flushPromises()

    expect(logger.level).toBe('info')
    expect(logger.transports[0].level).toBe('info')
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it('serializes a restart behind an old read and immediately applies the new generation', async () => {
    const logger = makeLogger('info', ['info'])
    const oldRead = deferred<'debug'>()
    const newRead = deferred<'warn'>()
    const resolver = {
      resolve: jest
        .fn()
        .mockImplementationOnce(() => oldRead.promise)
        .mockImplementationOnce(() => newRead.promise),
    }
    const applier = new RuntimeLogLevelApplier(logger, resolver)

    applier.start()
    applier.stop()
    applier.start()
    expect(resolver.resolve).toHaveBeenCalledTimes(1)

    oldRead.resolve('debug')
    await flushPromises()
    expect(logger.level).toBe('info')
    expect(resolver.resolve).toHaveBeenCalledTimes(2)

    newRead.resolve('warn')
    await flushPromises()
    expect(logger.level).toBe('warn')
    applier.stop()
  })
})

function makeLogger(level: string, transportLevels: string[]): MutableRuntimeLogLevelLogger {
  return {
    level,
    transports: transportLevels.map((transportLevel) => ({ level: transportLevel })),
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return { promise, resolve: resolvePromise }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
