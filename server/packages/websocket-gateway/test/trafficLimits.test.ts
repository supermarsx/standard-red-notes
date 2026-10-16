import { describe, it, expect } from 'vitest'
import {
  SYNC_TRAFFIC_DEFAULTS,
  SYNC_TRAFFIC_ENV,
  SYNC_TRAFFIC_BOUNDS,
  resolveSyncTrafficLimits,
} from '../src/trafficLimits.js'
import { WebSocketIngressLimiter } from '../src/gateway.js'

describe('sync traffic limits', () => {
  it('supports sustained high-flow small frames while preserving finite admission', () => {
    let now = 0
    const limiter = new WebSocketIngressLimiter(SYNC_TRAFFIC_DEFAULTS, () => now)
    for (let second = 0; second < 20; second++) {
      for (let frame = 0; frame < 200; frame++) {
        expect(limiter.tryConsume(1024)).toBe(true)
      }
      now += 1000
    }
    const same = resolveSyncTrafficLimits()
    expect(same).toMatchObject({
      frameCapacity: 1024,
      frameRefillPerSecond: 256,
      maxQueuedFrames: 64,
      maxQueuedBytes: 16777216,
    })
  })
  it.each(Object.keys(SYNC_TRAFFIC_DEFAULTS) as Array<keyof typeof SYNC_TRAFFIC_DEFAULTS>)(
    'validates env and admin bounds for %s',
    (key) => {
      const [min, max] = SYNC_TRAFFIC_BOUNDS[key]
      expect(resolveSyncTrafficLimits({ [SYNC_TRAFFIC_ENV[key]]: String(min) })[key]).toBe(min)
      expect(resolveSyncTrafficLimits({ [SYNC_TRAFFIC_ENV[key]]: String(min) }, { [key]: max })[key]).toBe(max)
      for (const invalid of [0, min - 1, max + 1, 1.5, NaN]) {
        expect(() => resolveSyncTrafficLimits({}, { [key]: invalid })).toThrow()
      }
      expect(() => resolveSyncTrafficLimits({ [SYNC_TRAFFIC_ENV[key]]: '10ms' })).toThrow()
    },
  )
  it('reconfigures live without refilling a spent bucket or accumulating beyond a reduced capacity', () => {
    let now = 0
    const limits = { frameCapacity: 2, frameRefillPerSecond: 1, byteCapacity: 10, byteRefillPerSecond: 10 }
    const limiter = new WebSocketIngressLimiter(limits, () => now)
    expect(limiter.tryConsume(5)).toBe(true)
    expect(limiter.tryConsume(5)).toBe(true)
    limiter.reconfigure({ ...limits, frameCapacity: 100 })
    expect(limiter.tryConsume(1)).toBe(false)
    now = 1000
    expect(limiter.tryConsume(1)).toBe(true)
    limiter.reconfigure({ ...limits, byteCapacity: 1 })
    expect(limiter.tryConsume(2)).toBe(false)
  })
  it('does not apply a newly raised refill rate retroactively to elapsed idle time', () => {
    let now = 0
    const limits = { frameCapacity: 100, frameRefillPerSecond: 1, byteCapacity: 1000, byteRefillPerSecond: 1000 }
    const limiter = new WebSocketIngressLimiter(limits, () => now)
    for (let index = 0; index < 100; index++) {
      expect(limiter.tryConsume(1)).toBe(true)
    }
    now = 1000
    limiter.reconfigure({ ...limits, frameRefillPerSecond: 100 })
    expect(limiter.tryConsume(1)).toBe(true)
    expect(limiter.tryConsume(1)).toBe(false)
  })
})
