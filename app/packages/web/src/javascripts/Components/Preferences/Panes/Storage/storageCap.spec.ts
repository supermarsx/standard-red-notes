import {
  BYTES_PER_GB,
  BYTES_PER_MB,
  resolveStorageCapState,
  STORAGE_CAP_UNLIMITED,
  STORAGE_CAP_WARNING_THRESHOLD,
} from './storageCap'

describe('resolveStorageCapState', () => {
  describe('Unlimited (cap = 0) and invalid caps', () => {
    it('reports ok with no ratio and a limit-less label when the cap is Unlimited', () => {
      const state = resolveStorageCapState(1.5 * BYTES_PER_GB, STORAGE_CAP_UNLIMITED)
      expect(state.status).toBe('ok')
      expect(state.ratio).toBe(0)
      expect(state.percent).toBe(0)
      expect(state.label).toBe('1.5 GB used')
    })

    it('treats negative and non-finite caps as Unlimited', () => {
      expect(resolveStorageCapState(BYTES_PER_GB, -5).status).toBe('ok')
      expect(resolveStorageCapState(BYTES_PER_GB, NaN).status).toBe('ok')
      expect(resolveStorageCapState(BYTES_PER_GB, Infinity).label).toBe('1 GB used')
    })
  })

  describe('with a cap set', () => {
    it('is ok well below the warning threshold', () => {
      const state = resolveStorageCapState(BYTES_PER_GB, 5 * BYTES_PER_GB)
      expect(state.status).toBe('ok')
      expect(state.ratio).toBeCloseTo(0.2)
      expect(state.percent).toBeCloseTo(20)
      expect(state.label).toBe('1 GB used of 5 GB limit (20.0%)')
    })

    it('warns exactly at the warning threshold (80% of the cap)', () => {
      const cap = 10 * BYTES_PER_GB
      const state = resolveStorageCapState(cap * STORAGE_CAP_WARNING_THRESHOLD, cap)
      expect(state.status).toBe('warning')
      expect(state.percent).toBeCloseTo(80)
    })

    it('stays warning (not over) at exactly 100% of the cap', () => {
      const cap = BYTES_PER_GB
      const state = resolveStorageCapState(cap, cap)
      expect(state.status).toBe('warning')
      expect(state.ratio).toBe(1)
      expect(state.percent).toBe(100)
    })

    it('reports over past the cap, with the bar percent clamped to 100', () => {
      const state = resolveStorageCapState(2 * BYTES_PER_GB, BYTES_PER_GB)
      expect(state.status).toBe('over')
      expect(state.ratio).toBe(2)
      expect(state.percent).toBe(100)
      expect(state.label).toBe('2 GB used of 1 GB limit (200.0%)')
    })

    it('formats MB-scale caps naturally', () => {
      const state = resolveStorageCapState(100 * BYTES_PER_MB, 500 * BYTES_PER_MB)
      expect(state.status).toBe('ok')
      expect(state.label).toBe('100 MB used of 500 MB limit (20.0%)')
    })
  })

  describe('degenerate usage inputs', () => {
    it('treats negative / non-finite usage as zero', () => {
      expect(resolveStorageCapState(-100, BYTES_PER_GB)).toEqual({
        ratio: 0,
        percent: 0,
        status: 'ok',
        label: '0 B used of 1 GB limit (0.0%)',
      })
      expect(resolveStorageCapState(NaN, BYTES_PER_GB).ratio).toBe(0)
    })

    it('handles zero usage with a cap set', () => {
      const state = resolveStorageCapState(0, 5 * BYTES_PER_GB)
      expect(state.status).toBe('ok')
      expect(state.label).toBe('0 B used of 5 GB limit (0.0%)')
    })
  })
})
