import {
  BulkRunSummary,
  errorMessageOf,
  excludeSelfTarget,
  pageSelectionState,
  runBulkWithConcurrency,
  selectedUuidsOnPage,
  setPageSelection,
  summarizeBulkOutcome,
  toggleSelected,
} from './adminUsersBulk'

describe('selection transitions', () => {
  describe('toggleSelected', () => {
    it('adds an absent uuid and removes a present one, returning a new set', () => {
      const start = new Set<string>(['a'])
      const added = toggleSelected(start, 'b')
      expect(added).not.toBe(start)
      expect([...added].sort()).toEqual(['a', 'b'])
      expect([...start]).toEqual(['a']) // original untouched

      const removed = toggleSelected(added, 'a')
      expect([...removed]).toEqual(['b'])
    })
  })

  describe('setPageSelection', () => {
    it('selects every page uuid, preserving off-page selections', () => {
      const start = new Set<string>(['off-page'])
      const next = setPageSelection(start, ['a', 'b'], true)
      expect([...next].sort()).toEqual(['a', 'b', 'off-page'])
    })

    it('deselects every page uuid, preserving off-page selections', () => {
      const start = new Set<string>(['a', 'b', 'off-page'])
      const next = setPageSelection(start, ['a', 'b'], false)
      expect([...next]).toEqual(['off-page'])
    })
  })

  describe('pageSelectionState', () => {
    it('is none for an empty page', () => {
      expect(pageSelectionState(new Set(['a']), [])).toBe('none')
    })

    it('is none when nothing on the page is selected', () => {
      expect(pageSelectionState(new Set(['x']), ['a', 'b'])).toBe('none')
    })

    it('is partial when some page rows are selected', () => {
      expect(pageSelectionState(new Set(['a']), ['a', 'b'])).toBe('partial')
    })

    it('is all when every page row is selected', () => {
      expect(pageSelectionState(new Set(['a', 'b']), ['a', 'b'])).toBe('all')
    })
  })

  describe('selectedUuidsOnPage', () => {
    it('returns only on-page selections in page order', () => {
      const selected = new Set(['b', 'off-page', 'a'])
      expect(selectedUuidsOnPage(selected, ['a', 'b', 'c'])).toEqual(['a', 'b'])
    })
  })
})

describe('excludeSelfTarget', () => {
  it('removes the acting admin uuid and flags it', () => {
    const { targets, excludedSelf } = excludeSelfTarget(['a', 'me', 'b'], 'me')
    expect(targets).toEqual(['a', 'b'])
    expect(excludedSelf).toBe(true)
  })

  it('keeps every uuid when self is not in the list', () => {
    const { targets, excludedSelf } = excludeSelfTarget(['a', 'b'], 'me')
    expect(targets).toEqual(['a', 'b'])
    expect(excludedSelf).toBe(false)
  })

  it('is a no-op when there is no self uuid', () => {
    const { targets, excludedSelf } = excludeSelfTarget(['a', 'b'], undefined)
    expect(targets).toEqual(['a', 'b'])
    expect(excludedSelf).toBe(false)
  })
})

describe('errorMessageOf', () => {
  it('reads Error, string and message-bearing objects, else falls back', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom')
    expect(errorMessageOf('nope')).toBe('nope')
    expect(errorMessageOf({ message: 'obj' })).toBe('obj')
    expect(errorMessageOf(42)).toBe('Unknown error')
  })
})

describe('runBulkWithConcurrency', () => {
  const uuidsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `u${i}`)

  it('runs every item and reports order-stable success results', async () => {
    const items = uuidsOf(6)
    const summary = await runBulkWithConcurrency(
      items,
      (u) => u,
      async () => undefined,
      { concurrency: 2 },
    )
    expect(summary.total).toBe(6)
    expect(summary.failed).toEqual([])
    expect(summary.succeeded.map((r) => r.uuid)).toEqual(items)
  })

  it('collects per-item failures without aborting the batch', async () => {
    const items = uuidsOf(5)
    const summary = await runBulkWithConcurrency(
      items,
      (u) => u,
      async (u) => {
        if (u === 'u2') {
          throw new Error('nope-2')
        }
        if (u === 'u4') {
          throw 'nope-4'
        }
      },
      { concurrency: 3 },
    )
    expect(summary.succeeded.map((r) => r.uuid)).toEqual(['u0', 'u1', 'u3'])
    expect(summary.failed).toEqual([
      { uuid: 'u2', ok: false, error: 'nope-2' },
      { uuid: 'u4', ok: false, error: 'nope-4' },
    ])
  })

  it('never exceeds the concurrency ceiling', async () => {
    const items = uuidsOf(10)
    let inFlight = 0
    let peak = 0
    await runBulkWithConcurrency(
      items,
      (u) => u,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
      },
      { concurrency: 3 },
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('reports progress once per item, ending at total', async () => {
    const items = uuidsOf(4)
    const progress: Array<[number, number]> = []
    await runBulkWithConcurrency(
      items,
      (u) => u,
      async () => undefined,
      {
        concurrency: 2,
        onProgress: (completed, total) => progress.push([completed, total]),
      },
    )
    expect(progress.length).toBe(4)
    expect(progress.map(([c]) => c)).toEqual([1, 2, 3, 4])
    expect(progress.every(([, total]) => total === 4)).toBe(true)
  })

  it('handles an empty batch', async () => {
    const summary = await runBulkWithConcurrency<string>(
      [],
      (u) => u,
      async () => undefined,
    )
    expect(summary).toEqual({ total: 0, succeeded: [], failed: [] })
  })

  it('clamps a huge or invalid concurrency to the item count', async () => {
    const items = uuidsOf(3)
    const summary = await runBulkWithConcurrency(
      items,
      (u) => u,
      async () => undefined,
      { concurrency: 999 },
    )
    expect(summary.succeeded.length).toBe(3)
  })
})

describe('summarizeBulkOutcome', () => {
  const summary = (succeeded: number, failed: number): BulkRunSummary => ({
    total: succeeded + failed,
    succeeded: Array.from({ length: succeeded }, (_, i) => ({ uuid: `s${i}`, ok: true })),
    failed: Array.from({ length: failed }, (_, i) => ({ uuid: `f${i}`, ok: false, error: 'x' })),
  })

  it('reports an all-success run', () => {
    expect(summarizeBulkOutcome('Banned', summary(38, 0))).toEqual({
      message: 'Banned 38 users.',
      hasFailures: false,
    })
  })

  it('reports a partial-failure run', () => {
    expect(summarizeBulkOutcome('Banned', summary(36, 2))).toEqual({
      message: 'Banned 36 users, 2 failed.',
      hasFailures: true,
    })
  })

  it('uses the singular for a single user', () => {
    expect(summarizeBulkOutcome('Unbanned', summary(1, 0)).message).toBe('Unbanned 1 user.')
  })
})
