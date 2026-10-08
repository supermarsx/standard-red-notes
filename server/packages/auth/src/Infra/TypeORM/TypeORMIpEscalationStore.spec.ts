import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TypeORMIpEscalationStore } from './TypeORMIpEscalationStore'

let now = Date.parse('2026-10-08T12:00:00.000Z')

/**
 * Stand-in for the cache-table repository, faithful to the behaviours of the real
 * one this store depends on -- and to the one that would otherwise bite it.
 *
 *   - `findUnexpiredOneByKey` filters on `expires_at > now` (in SQL in the real
 *     one), which is the whole mechanism the flag's lifetime rests on.
 *   - `save` INSERTS; it does not upsert. A Map-backed fake would overwrite and
 *     would therefore pass against a store that never deletes.
 *   - that read ends in an unordered `getOne()`, so with several rows under one
 *     key the row returned is arbitrary. This fake returns the OLDEST, which is
 *     the row that reads as "not escalated" while a live flag sits beside it.
 */
class AppendOnlyCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly rows: CacheEntry[] = []
  saveCalls = 0
  removeCalls = 0
  failSave = false
  failRead = false

  async save(cacheEntry: CacheEntry): Promise<void> {
    this.saveCalls += 1
    if (this.failSave) {
      throw new Error('insert failed')
    }
    this.rows.push(cacheEntry)
  }

  async findUnexpiredOneByKey(key: string): Promise<CacheEntry | null> {
    if (this.failRead) {
      throw new Error('select failed')
    }
    const unexpired = this.rows.filter(
      (row) => row.props.key === key && (row.props.expiresAt === null || row.props.expiresAt.getTime() > now),
    )

    return unexpired.length > 0 ? unexpired[0] : null
  }

  async removeByKey(key: string): Promise<void> {
    this.removeCalls += 1
    for (let index = this.rows.length - 1; index >= 0; index--) {
      if (this.rows[index].props.key === key) {
        this.rows.splice(index, 1)
      }
    }
  }

  rowsFor(key: string): CacheEntry[] {
    return this.rows.filter((row) => row.props.key === key)
  }
}

describe('TypeORMIpEscalationStore', () => {
  const IP = '203.0.113.7'
  const KEY = `rl:escalate:${IP}`
  const TTL = 300

  let cacheEntryRepository: AppendOnlyCacheEntryRepository
  let timer: TimerInterface
  let adaptiveEscalationEnabled: jest.Mock
  let store: TypeORMIpEscalationStore

  const createStore = (): TypeORMIpEscalationStore =>
    new TypeORMIpEscalationStore(cacheEntryRepository, timer, adaptiveEscalationEnabled as () => Promise<boolean>)

  beforeEach(() => {
    now = Date.parse('2026-10-08T12:00:00.000Z')
    cacheEntryRepository = new AppendOnlyCacheEntryRepository()
    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => new Date(now + seconds * 1000)),
    } as unknown as jest.Mocked<TimerInterface>
    adaptiveEscalationEnabled = jest.fn().mockResolvedValue(true)
    store = createStore()
  })

  it('reads back the flag the writer just set, which is the whole ramp end to end', async () => {
    await expect(store.isEscalated(IP)).resolves.toBe(false)

    await store.escalate(IP, TTL)

    await expect(store.isEscalated(IP)).resolves.toBe(true)
  })

  it('uses the SAME key the Redis arm writes, so an operator reads one name for one signal', async () => {
    await store.escalate(IP, TTL)

    expect(cacheEntryRepository.rows.map((row) => row.props.key)).toEqual([KEY])
  })

  it('writes the flag and its horizon in ONE save, so no flag can exist without an expiry', async () => {
    await store.escalate(IP, TTL)

    expect(cacheEntryRepository.saveCalls).toEqual(1)
    expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(KEY)[0].props.expiresAt).toEqual(new Date(now + TTL * 1000))
  })

  it('EXPIRES on schedule, so the ramp lets a reformed address through again', async () => {
    await store.escalate(IP, TTL)

    now += (TTL - 1) * 1000
    await expect(store.isEscalated(IP)).resolves.toBe(true)

    now += 2000
    await expect(store.isEscalated(IP)).resolves.toBe(false)
  })

  it('pushes the horizon out on a later throttle, matching the Redis arm SET ... EX exactly', async () => {
    await store.escalate(IP, TTL)
    now += 100_000
    await store.escalate(IP, TTL)

    expect(cacheEntryRepository.rowsFor(KEY)[0].props.expiresAt).toEqual(new Date(now + TTL * 1000))
  })

  it('DELETES BEFORE IT WRITES, so one address never accumulates rows and the read cannot land on a dead one', async () => {
    await store.escalate(IP, TTL)
    now += 1000
    await store.escalate(IP, TTL)
    now += 1000
    await store.escalate(IP, TTL)

    expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(1)
    expect(cacheEntryRepository.removeCalls).toEqual(3)
    await expect(store.isEscalated(IP)).resolves.toBe(true)
  })

  it('SERIALIZES concurrent writes for one address, so two throttles cannot leave two rows', async () => {
    await Promise.all([store.escalate(IP, TTL), store.escalate(IP, TTL), store.escalate(IP, TTL)])

    expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(1)
    await expect(store.isEscalated(IP)).resolves.toBe(true)
  })

  it('does not queue one address behind another', async () => {
    await Promise.all([store.escalate(IP, TTL), store.escalate('198.51.100.4', TTL)])

    expect(cacheEntryRepository.rowsFor(KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor('rl:escalate:198.51.100.4')).toHaveLength(1)
  })

  it('IS GATED BY THE SAME SWITCH THE WRITER CONSULTS, so disabling escalation stops the demand immediately', async () => {
    await store.escalate(IP, TTL)
    adaptiveEscalationEnabled.mockResolvedValue(false)

    await expect(store.isEscalated(IP)).resolves.toBe(false)
  })

  it('re-reads the switch per call, so an admin toggle applies without a restart', async () => {
    await store.escalate(IP, TTL)
    adaptiveEscalationEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(store.isEscalated(IP)).resolves.toBe(false)
    await expect(store.isEscalated(IP)).resolves.toBe(true)
    expect(adaptiveEscalationEnabled).toHaveBeenCalledTimes(2)
  })

  it('REFUSES TO WRITE A FLAG IT COULD NOT EXPIRE, because a permanent demand locks out everyone behind the address', async () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await store.escalate(IP, ttl)
    }

    expect(cacheEntryRepository.rows).toHaveLength(0)
  })

  it('ignores an empty address at both ends', async () => {
    await store.escalate('', TTL)

    expect(cacheEntryRepository.rows).toHaveLength(0)
    await expect(store.isEscalated('')).resolves.toBe(false)
  })

  it('FAILS OPEN when the switch lookup throws', async () => {
    await store.escalate(IP, TTL)
    adaptiveEscalationEnabled.mockRejectedValue(new Error('overlay unreadable'))

    await expect(store.isEscalated(IP)).resolves.toBe(false)
  })

  it('FAILS OPEN when the read throws, so a database blip never forces proof-of-work', async () => {
    await store.escalate(IP, TTL)
    cacheEntryRepository.failRead = true

    await expect(store.isEscalated(IP)).resolves.toBe(false)
  })

  it('SWALLOWS a write error, because it runs inside the limiter fail-open branch', async () => {
    cacheEntryRepository.failSave = true

    await expect(store.escalate(IP, TTL)).resolves.toBeUndefined()
  })

  it('a failed write does not poison the next throttle from the same address', async () => {
    cacheEntryRepository.failSave = true
    await store.escalate(IP, TTL)

    cacheEntryRepository.failSave = false
    await store.escalate(IP, TTL)

    await expect(store.isEscalated(IP)).resolves.toBe(true)
  })

  it('floors a fractional ttl rather than handing the table a fractional second', async () => {
    await store.escalate(IP, 12.7)

    expect(cacheEntryRepository.rowsFor(KEY)[0].props.expiresAt).toEqual(new Date(now + 12_000))
  })
})
