import { describe, expect, it, vi } from 'vitest'

import { createConsoleLogger, isLevelEnabled, resolveLogLevel } from '../src/logger.js'
import { createLogThrottle } from '../src/logThrottle.js'

function sinkDouble() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('resolveLogLevel', () => {
  it('defaults to info when LOG_LEVEL is unset, blank or unrecognized', () => {
    expect(resolveLogLevel(undefined)).toBe('info')
    expect(resolveLogLevel('   ')).toBe('info')
    // A typo in an operator's env must not take the gateway down, and must not
    // silently go quiet either.
    expect(resolveLogLevel('verbosee')).toBe('info')
  })

  it('accepts the same level names the other services configure winston with', () => {
    expect(resolveLogLevel('DEBUG')).toBe('debug')
    expect(resolveLogLevel(' warn ')).toBe('warn')
    expect(resolveLogLevel('silly')).toBe('silly')
    expect(resolveLogLevel('silent')).toBe('silent')
  })

  it('orders severities so a lower level suppresses the chattier ones', () => {
    expect(isLevelEnabled('warn', 'error')).toBe(true)
    expect(isLevelEnabled('warn', 'warn')).toBe(true)
    expect(isLevelEnabled('warn', 'info')).toBe(false)
    expect(isLevelEnabled('debug', 'info')).toBe(true)
    expect(isLevelEnabled('silent', 'error')).toBe(false)
  })
})

describe('createConsoleLogger', () => {
  it('honours LOG_LEVEL instead of writing everything unconditionally', () => {
    const sink = sinkDouble()
    const logger = createConsoleLogger({ level: 'warn', sink })

    logger.debug('debug line')
    logger.info('info line')
    logger.warn('warn line')
    logger.error('error line')

    expect(sink.log).not.toHaveBeenCalled()
    expect(sink.warn).toHaveBeenCalledTimes(1)
    expect(sink.error).toHaveBeenCalledTimes(1)
  })

  it('emits nothing at all at the silent level', () => {
    const sink = sinkDouble()
    const logger = createConsoleLogger({ level: 'silent', sink })

    logger.error('error line')
    logger.warn('warn line')

    expect(sink.warn).not.toHaveBeenCalled()
    expect(sink.error).not.toHaveBeenCalled()
  })

  it('redacts every argument before it reaches the sink', () => {
    const sink = sinkDouble()
    const logger = createConsoleLogger({ level: 'debug', sink })

    logger.info('connecting', {
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      connectionTokenSecret: 's3cret-signing-key',
      note: 'user@example.com wrote something private',
    })

    const emitted = JSON.stringify(sink.log.mock.calls)
    expect(emitted).not.toContain('s3cret-signing-key')
    expect(emitted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(emitted).not.toContain('user@example.com')
    expect(emitted).toContain('[REDACTED]')
  })
})

describe('createLogThrottle', () => {
  it('emits the first occurrence, suppresses the rest of the window, and reports the count', () => {
    let now = 0
    const throttle = createLogThrottle({ intervalMs: 1_000, now: () => now })

    expect(throttle.consider('a')).toEqual({ emit: true, suppressed: 0 })
    expect(throttle.consider('a')).toEqual({ emit: false, suppressed: 1 })
    expect(throttle.consider('a')).toEqual({ emit: false, suppressed: 2 })

    now = 1_000
    expect(throttle.consider('a')).toEqual({ emit: true, suppressed: 2 })
    expect(throttle.consider('a')).toEqual({ emit: false, suppressed: 1 })
  })

  it('tracks distinct causes independently', () => {
    const throttle = createLogThrottle({ intervalMs: 1_000, now: () => 0 })

    expect(throttle.consider('a').emit).toBe(true)
    expect(throttle.consider('b').emit).toBe(true)
    expect(throttle.consider('a').emit).toBe(false)
  })

  it('bounds the tracked key space so caller-influenced keys cannot grow it without limit', () => {
    const throttle = createLogThrottle({ intervalMs: 1_000, maxKeys: 2, now: () => 0 })

    throttle.consider('a')
    throttle.consider('b')
    throttle.consider('c')

    // 'a' was evicted as the oldest, so it logs again rather than being retained.
    expect(throttle.consider('a').emit).toBe(true)
    expect(throttle.consider('c').emit).toBe(false)
  })

  it('rejects a nonsensical configuration rather than silently disabling itself', () => {
    expect(() => createLogThrottle({ intervalMs: Number.NaN })).toThrow(/log throttle interval/)
    expect(() => createLogThrottle({ maxKeys: 0 })).toThrow(/log throttle key budget/)
  })
})
