import { StorageSource, UNACCOUNTED_SOURCE_ID } from './storageUsageWorkerProtocol'
import {
  buildResidualSource,
  computeResidualBytes,
  OVERHEAD_SOURCE_DESCRIPTION,
  OVERHEAD_SOURCE_LABEL,
  sumSourceBytes,
} from './reconcileStorageSources'

const source = (bytes: number): StorageSource => ({ id: `s-${bytes}`, label: 's', bytes, count: 0 })

describe('reconcileStorageSources', () => {
  describe('sumSourceBytes', () => {
    it('sums positive byte counts', () => {
      expect(sumSourceBytes([source(10), source(20), source(30)])).toBe(60)
    })

    it('returns 0 for an empty list', () => {
      expect(sumSourceBytes([])).toBe(0)
    })

    it('ignores non-finite and negative byte counts', () => {
      expect(sumSourceBytes([source(100), source(-5), source(NaN), source(Infinity)])).toBe(100)
    })
  })

  describe('computeResidualBytes', () => {
    it('is estimate minus measured when the estimate is larger', () => {
      expect(computeResidualBytes(300, 1000)).toBe(700)
    })

    it('clamps to 0 when measured meets or exceeds the estimate', () => {
      expect(computeResidualBytes(1000, 1000)).toBe(0)
      expect(computeResidualBytes(1200, 1000)).toBe(0)
    })

    it('is 0 when there is no usable estimate', () => {
      expect(computeResidualBytes(300, undefined)).toBe(0)
      expect(computeResidualBytes(300, 0)).toBe(0)
      expect(computeResidualBytes(300, -1)).toBe(0)
      expect(computeResidualBytes(300, NaN)).toBe(0)
    })
  })

  describe('buildResidualSource', () => {
    it('reconciles: sum(measured) + residual === total', () => {
      const sources = [source(200), source(500)]
      const estimate = 1000
      const residual = buildResidualSource(sources, estimate)
      expect(residual).toBeDefined()
      expect(sumSourceBytes(sources) + (residual as StorageSource).bytes).toBe(estimate)
      expect(residual).toMatchObject({
        id: UNACCOUNTED_SOURCE_ID,
        label: OVERHEAD_SOURCE_LABEL,
        description: OVERHEAD_SOURCE_DESCRIPTION,
        bytes: 300,
        count: 0,
      })
    })

    it('returns undefined (no row) when sources meet/exceed the estimate', () => {
      expect(buildResidualSource([source(600), source(600)], 1000)).toBeUndefined()
    })

    it('returns undefined when there is no estimate', () => {
      expect(buildResidualSource([source(100)], undefined)).toBeUndefined()
    })

    it('handles empty sources — residual is the whole estimate', () => {
      const residual = buildResidualSource([], 1000)
      expect(residual?.bytes).toBe(1000)
    })
  })
})
