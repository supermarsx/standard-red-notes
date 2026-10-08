import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { CacheEntryRateLimitStore, SWEEP_BATCH_SIZE, SWEEP_TRACKED_KEYS } from './CacheEntryRateLimitStore'

/**
 * An APPEND-ONLY fake, deliberately not a Map.
 *
 * The house repository fake is a `Map`, which UPSERTS: `save` twice under one key
 * leaves one entry, so a store that forgot its `removeByKey` would look correct.
 * The real `TypeORMCacheEntryRepository.save` calls `ormRepository.save` on a
 * projection carrying a FRESH uuid (CacheEntry.create mints one per call) into a
 * table with NO unique index on `key`, so it INSERTS -- two saves leave two rows.
 * This fake inserts too, and `findUnexpiredOneByKey` mimics the unordered
 * `getOne()` by returning the FIRST matching row, which is the stale one. That is
 * what makes a missing delete observable as a counter that stops climbing.
 */
class AppendOnlyCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly rows: { key: string; value: string; expiresAt: Date | null }[] = []
  saves = 0
  removals = 0
  now = new Date('2026-10-08T00:00:00.000Z')

  async save(cacheEntry: CacheEntry): Promise<void> {
    this.saves++
    this.rows.push({
      key: cacheEntry.props.key,
      value: cacheEntry.props.value,
      expiresAt: cacheEntry.props.expiresAt,
    })
  }

  async findUnexpiredOneByKey(key: string): Promise<CacheEntry | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.key === key && candidate.expiresAt !== null && candidate.expiresAt.getTime() > this.now.getTime(),
    )
    if (row === undefined) {
      return null
    }

    return CacheEntry.create({ key: row.key, value: row.value, expiresAt: row.expiresAt }).getValue()
  }

  async removeByKey(key: string): Promise<void> {
    this.removals++
    for (let index = this.rows.length - 1; index >= 0; index--) {
      if (this.rows[index].key === key) {
        this.rows.splice(index, 1)
      }
    }
  }

  rowsFor(key: string): { key: string; value: string; expiresAt: Date | null }[] {
    return this.rows.filter((row) => row.key === key)
  }
}

const timerFor = (repository: AppendOnlyCacheEntryRepository): TimerInterface =>
  ({
    getUTCDate: (): Date => repository.now,
    getUTCDateNSecondsAhead: (seconds: number): Date => new Date(repository.now.getTime() + seconds * 1000),
    convertDateToMilliseconds: (date: Date): number => date.getTime(),
  }) as unknown as TimerInterface

const storeFor = (
  repository: AppendOnlyCacheEntryRepository,
): { store: CacheEntryRateLimitStore; repository: AppendOnlyCacheEntryRepository } => ({
  store: new CacheEntryRateLimitStore(() => repository, timerFor(repository)),
  repository,
})

const freshStore = (): { store: CacheEntryRateLimitStore; repository: AppendOnlyCacheEntryRepository } =>
  storeFor(new AppendOnlyCacheEntryRepository())

describe('CacheEntryRateLimitStore', () => {
  it('counts 1, 2, 3 for repeated hits inside one window', async () => {
    const { store } = freshStore()

    await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(1)
    await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(2)
    await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(3)
  })

  it('namespaces the stored row so it cannot collide with another cache user', async () => {
    const { store, repository } = freshStore()

    await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)

    expect(repository.rows).toHaveLength(1)
    expect(repository.rows[0].key).toEqual('ratelimit:rl:auth-login:1.2.3.4')
  })

  it('counts each key independently', async () => {
    const { store } = freshStore()

    await store.incrementInWindow('rl:auth-login:1.1.1.1', 60)
    await store.incrementInWindow('rl:auth-login:1.1.1.1', 60)

    await expect(store.incrementInWindow('rl:auth-login:2.2.2.2', 60)).resolves.toEqual(1)
  })

  /**
   * The mutation this kills: dropping `removeByKey` from incrementInWindow. Against
   * a Map fake that survives; against an append-only one the counter stalls.
   */
  it('leaves exactly one row per key, so the count never reads back stale', async () => {
    const { store, repository } = freshStore()

    for (let hit = 0; hit < 5; hit++) {
      await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
    }

    const rows = repository.rowsFor('ratelimit:rl:auth-login:1.2.3.4')
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toEqual('5')
  })

  it('keeps the first hit horizon instead of sliding it forward on later hits', async () => {
    const { store, repository } = freshStore()

    await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
    const armedAt = repository.rowsFor('ratelimit:rl:auth-login:1.2.3.4')[0].expiresAt

    repository.now = new Date(repository.now.getTime() + 30_000)
    await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)

    // A sliding horizon would be 30s later and would keep a steady attacker
    // refused forever once they tripped the ceiling.
    expect(repository.rowsFor('ratelimit:rl:auth-login:1.2.3.4')[0].expiresAt).toEqual(armedAt)
    await expect(store.ttl('rl:auth-login:1.2.3.4')).resolves.toEqual(30)
  })

  it('arms every write with a horizon, so no row can outlive its window', async () => {
    const { store, repository } = freshStore()

    for (let hit = 0; hit < 3; hit++) {
      await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
    }

    expect(repository.rows.every((row) => row.expiresAt !== null)).toBe(true)
  })

  /**
   * Standard Red Notes: the same property the live probe measured by knocking
   * every 2 s for a whole window -- the horizon must not move while a refused
   * client keeps trying, or the window never opens and the limit becomes a
   * permanent lockout. Proven here by knocking well PAST the ceiling and then
   * stepping the clock to exactly the original horizon.
   */
  it('releases on schedule even while a refused client keeps knocking', async () => {
    const { store, repository } = freshStore()
    const horizon = repository.now.getTime() + 60_000

    // 30 hits at 2s intervals, a ceiling's worth and then twenty more.
    for (let hit = 0; hit < 30; hit++) {
      await store.incrementInWindow('rl:auth-sensitive:1.2.3.4', 60)
      repository.now = new Date(repository.now.getTime() + 2_000)
      // Mid-window the counter is still the SAME window, counting up.
      if (repository.now.getTime() < horizon) {
        expect(repository.rowsFor('ratelimit:rl:auth-sensitive:1.2.3.4')[0].expiresAt?.getTime()).toEqual(horizon)
      }
    }

    // The clock is now past the original horizon, so the next hit opens a fresh
    // window. A sliding horizon would have been pushed 60s beyond the last knock.
    await expect(store.incrementInWindow('rl:auth-sensitive:1.2.3.4', 60)).resolves.toEqual(1)
  })

  it('restarts the count at 1 once the window has passed', async () => {
    const { store, repository } = freshStore()

    await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
    await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)

    repository.now = new Date(repository.now.getTime() + 61_000)

    await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(1)
  })

  it('reads a count persisted by an earlier process, so a restart does not reset the allowance', async () => {
    const repository = new AppendOnlyCacheEntryRepository()
    const { store: before } = storeFor(repository)
    await before.incrementInWindow('rl:auth-login:1.2.3.4', 60)
    await before.incrementInWindow('rl:auth-login:1.2.3.4', 60)

    // A brand new store over the SAME table is what a process restart looks like.
    const { store: after } = storeFor(repository)

    await expect(after.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(3)
  })

  describe('concurrency', () => {
    it('does not lose an increment when requests overlap', async () => {
      const { store } = freshStore()

      const counts = await Promise.all(
        Array.from({ length: 10 }, () => store.incrementInWindow('rl:auth-login:1.2.3.4', 60)),
      )

      // Unserialized read-modify-write would hand several callers the same number.
      expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    it('does not make one address queue behind another', async () => {
      const { store } = freshStore()

      const counts = await Promise.all([
        store.incrementInWindow('rl:auth-login:1.1.1.1', 60),
        store.incrementInWindow('rl:auth-login:2.2.2.2', 60),
        store.incrementInWindow('rl:auth-login:3.3.3.3', 60),
      ])

      expect(counts).toEqual([1, 1, 1])
    })

    it('does not poison a key after one failed increment', async () => {
      const repository = new AppendOnlyCacheEntryRepository()
      const { store } = storeFor(repository)
      const save = jest.spyOn(repository, 'save').mockRejectedValueOnce(new Error('disk full'))

      await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).rejects.toThrow('disk full')
      save.mockRestore()

      await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(1)
    })
  })

  describe('ttl', () => {
    it('reports the seconds left in the live window', async () => {
      const { store, repository } = freshStore()

      await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
      repository.now = new Date(repository.now.getTime() + 15_500)

      await expect(store.ttl('rl:auth-login:1.2.3.4')).resolves.toEqual(45)
    })

    it('never reports 0 for a live window', async () => {
      const { store, repository } = freshStore()

      await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
      repository.now = new Date(repository.now.getTime() + 59_900)

      await expect(store.ttl('rl:auth-login:1.2.3.4')).resolves.toEqual(1)
    })

    it('reports -2 when there is no counter, the value Redis returns for a missing key', async () => {
      const { store } = freshStore()

      await expect(store.ttl('rl:auth-login:1.2.3.4')).resolves.toEqual(-2)
    })

    it('reports -2 once the window has passed', async () => {
      const { store, repository } = freshStore()

      await store.incrementInWindow('rl:auth-login:1.2.3.4', 60)
      repository.now = new Date(repository.now.getTime() + 61_000)

      await expect(store.ttl('rl:auth-login:1.2.3.4')).resolves.toEqual(-2)
    })
  })

  describe('a row this store did not write', () => {
    it('treats a non-numeric value as no count rather than locking the address out', async () => {
      const repository = new AppendOnlyCacheEntryRepository()
      repository.rows.push({
        key: 'ratelimit:rl:auth-login:1.2.3.4',
        value: 'not-a-number',
        expiresAt: new Date(repository.now.getTime() + 60_000),
      })
      const { store } = storeFor(repository)

      await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(1)
    })

    it('treats a negative value as no count rather than exempting the address', async () => {
      const repository = new AppendOnlyCacheEntryRepository()
      repository.rows.push({
        key: 'ratelimit:rl:auth-login:1.2.3.4',
        value: '-500',
        expiresAt: new Date(repository.now.getTime() + 60_000),
      })
      const { store } = storeFor(repository)

      await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(1)
    })

    it('arms a horizon on a row that has none, so it cannot become a permanent lockout', async () => {
      const repository = new AppendOnlyCacheEntryRepository()
      repository.rows.push({ key: 'ratelimit:rl:auth-login:1.2.3.4', value: '900', expiresAt: null })
      const { store } = storeFor(repository)

      // The null-horizon row is invisible to findUnexpiredOneByKey, so it reads as
      // no counter: the count restarts and the replacement row carries a horizon.
      await expect(store.incrementInWindow('rl:auth-login:1.2.3.4', 60)).resolves.toEqual(1)
      expect(repository.rowsFor('ratelimit:rl:auth-login:1.2.3.4')).toEqual([
        {
          key: 'ratelimit:rl:auth-login:1.2.3.4',
          value: '1',
          expiresAt: new Date('2026-10-08T00:01:00.000Z'),
        },
      ])
    })
  })

  describe('the sweep', () => {
    it('deletes the expired rows of keys that never came back', async () => {
      const { store, repository } = freshStore()

      for (let address = 0; address < SWEEP_BATCH_SIZE; address++) {
        await store.incrementInWindow(`rl:auth-login:10.0.0.${address}`, 60)
      }
      expect(repository.rows).toHaveLength(SWEEP_BATCH_SIZE)

      repository.now = new Date(repository.now.getTime() + 61_000)
      // One more increment is what drives the sweep; it leaves its own row behind.
      await store.incrementInWindow('rl:auth-login:10.0.0.99', 60)

      expect(repository.rowsFor('ratelimit:rl:auth-login:10.0.0.99')).toHaveLength(1)
      expect(repository.rows).toHaveLength(1)
    })

    /**
     * The mutation this kills: dropping the live-row re-check from the sweep. An
     * expired key whose window has been REOPENED must not be deleted -- that would
     * hand the caller a fresh allowance, which is exactly the bypass the limiter
     * exists to prevent.
     */
    it('never deletes a counter whose window has been reopened', async () => {
      const { store, repository } = freshStore()

      // Two keys expire together; one of them is then used again.
      await store.incrementInWindow('rl:auth-login:10.0.0.1', 60)
      await store.incrementInWindow('rl:auth-login:10.0.0.2', 60)

      repository.now = new Date(repository.now.getTime() + 61_000)

      // 10.0.0.1 opens a NEW window and climbs to 3 before any sweep notices the
      // tracked horizon for that same key has passed.
      await store.incrementInWindow('rl:auth-login:10.0.0.1', 60)
      await store.incrementInWindow('rl:auth-login:10.0.0.1', 60)
      await expect(store.incrementInWindow('rl:auth-login:10.0.0.1', 60)).resolves.toEqual(3)

      // ... and the next hit still sees 4, not 1.
      await expect(store.incrementInWindow('rl:auth-login:10.0.0.1', 60)).resolves.toEqual(4)
      expect(repository.rowsFor('ratelimit:rl:auth-login:10.0.0.2')).toHaveLength(0)
    })

    /**
     * The mutation this kills: dropping the live-row re-check from the sweep.
     *
     * The sequential test above does NOT reach it, because `incrementInWindow`
     * re-tracks the key with its new horizon before the sweep ever looks, so a
     * reopened key is simply not due. The re-check earns its place only in the
     * interleaving below, which is the one the single container can actually hit:
     * the sweep collects a due key, deletes its tracking entry, and then queues on
     * that key's mutex -- and while it waits, the key's window reopens. Without the
     * re-check the sweep then deletes a LIVE counter, handing that address a fresh
     * allowance. That is the bypass the limiter exists to prevent, so it has to be
     * a test rather than a comment.
     */
    it('skips a key whose window reopened while the sweep queued behind it', async () => {
      const repository = new AppendOnlyCacheEntryRepository()
      const { store } = storeFor(repository)
      const key = 'rl:auth-login:10.0.0.7'
      const cacheKey = 'ratelimit:rl:auth-login:10.0.0.7'

      await store.incrementInWindow(key, 60)
      repository.now = new Date(repository.now.getTime() + 61_000)

      // Hold the REOPENING increment open inside its own mutex, at a point before
      // it re-tracks the key -- so the sweep still sees the old, passed horizon.
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const realSave = repository.save.bind(repository)
      let heldOnce = false
      repository.save = async (entry): Promise<void> => {
        if (!heldOnce && entry.props.key === cacheKey) {
          heldOnce = true
          await held
        }

        return realSave(entry)
      }

      const reopening = store.incrementInWindow(key, 60)
      await new Promise((resolve) => setImmediate(resolve))

      // Another key's increment drives the sweep, which marks this key due and
      // queues on its mutex behind the increment above.
      const sweeping = store.incrementInWindow('rl:auth-login:10.0.0.8', 60)
      await new Promise((resolve) => setImmediate(resolve))

      release()
      await Promise.all([reopening, sweeping])

      // The fresh window must have survived the sweep, counter and all.
      expect(repository.rowsFor(cacheKey)).toHaveLength(1)
      await expect(store.incrementInWindow(key, 60)).resolves.toEqual(2)
    })

    it('tracks at most SWEEP_TRACKED_KEYS keys, so the index cannot grow without bound', async () => {
      const { store, repository } = freshStore()

      // Only the tracking is capped. Nothing is evicted, because an evicted entry
      // is a row nothing would ever delete.
      for (let address = 0; address <= SWEEP_TRACKED_KEYS; address++) {
        await store.incrementInWindow(`rl:auth-login:untracked-${address}`, 600)
      }

      expect(repository.rows.length).toEqual(SWEEP_TRACKED_KEYS + 1)
      const tracked = (store as unknown as { tracked: Map<string, number> }).tracked
      expect(tracked.size).toEqual(SWEEP_TRACKED_KEYS)
    })

    it('does nothing while every tracked horizon is still live', async () => {
      const { store, repository } = freshStore()

      await store.incrementInWindow('rl:auth-login:10.0.0.1', 60)
      const removalsAfterFirst = repository.removals

      await store.incrementInWindow('rl:auth-login:10.0.0.2', 60)

      // One removal for the increment's own delete-before-write, none for a sweep.
      expect(repository.removals).toEqual(removalsAfterFirst + 1)
      expect(repository.rows).toHaveLength(2)
    })
  })
})
