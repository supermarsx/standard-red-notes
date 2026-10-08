import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TypeORMLockRepository } from './TypeORMLockRepository'

let now = Date.parse('2026-10-08T12:00:00.000Z')

/**
 * Stand-in for the cache-table repository, faithful to the behaviours of the real
 * one this repository depends on -- and to the one that would otherwise bite it.
 *
 *   - `findUnexpiredOneByKey` filters on `expires_at > now` (in SQL in the real
 *     one), which is the whole mechanism the lockout window rests on.
 *   - `save` INSERTS; it does not upsert. The old code mutated the entity it had
 *     just read and saved that, which is an UPDATE only while exactly one row
 *     exists. A Map-backed fake would hide a second row entirely.
 *   - that read ends in an unordered `getOne()`, so with two unexpired rows under
 *     one key the row returned is arbitrary. This fake returns the OLDEST, which
 *     is the row that reads a LOWER count and an EARLIER horizon.
 */
class AppendOnlyCacheEntryRepository implements CacheEntryRepositoryInterface {
  readonly rows: CacheEntry[] = []
  removeCalls = 0

  async save(cacheEntry: CacheEntry): Promise<void> {
    this.rows.push(cacheEntry)
  }

  async findUnexpiredOneByKey(key: string): Promise<CacheEntry | null> {
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

describe('TypeORMLockRepository', () => {
  const SUBJECT = '7371d9f7-d02f-4069-a68f-a3b478d86d16'
  const LOCK_KEY = `lock:${SUBJECT}`
  const CAPTCHA_KEY = `captcha-lock:${SUBJECT}`
  const OTP_KEY = `otp-lock:${SUBJECT}`

  const MAX_CAPTCHA_ATTEMPTS = 3
  const NON_CAPTCHA_TTL = 20
  const CAPTCHA_TTL = 25

  let cacheEntryRepository: AppendOnlyCacheEntryRepository
  let timer: TimerInterface
  let repository: TypeORMLockRepository

  beforeEach(() => {
    now = Date.parse('2026-10-08T12:00:00.000Z')
    cacheEntryRepository = new AppendOnlyCacheEntryRepository()
    timer = {
      getUTCDateNSecondsAhead: jest.fn().mockImplementation((seconds: number) => new Date(now + seconds * 1000)),
    } as unknown as jest.Mocked<TimerInterface>
    repository = new TypeORMLockRepository(
      cacheEntryRepository,
      timer,
      MAX_CAPTCHA_ATTEMPTS,
      NON_CAPTCHA_TTL,
      CAPTCHA_TTL,
    )
  })

  it('counts failures per tier and reads each back', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, 2, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, 1, 'captcha')

    await expect(repository.getLockCounter(SUBJECT, 'non-captcha')).resolves.toEqual(2)
    await expect(repository.getLockCounter(SUBJECT, 'captcha')).resolves.toEqual(1)
  })

  it('reads zero for a subject that has never failed', async () => {
    await expect(repository.getLockCounter(SUBJECT, 'non-captcha')).resolves.toEqual(0)
    await expect(repository.getLockCounter(SUBJECT, 'captcha')).resolves.toEqual(0)
  })

  it('locks the account once the CAPTCHA tier crosses the threshold, and not before', async () => {
    await repository.updateLockCounter(SUBJECT, MAX_CAPTCHA_ATTEMPTS, 'non-captcha')
    await expect(repository.isUserLocked(SUBJECT)).resolves.toBe(false)

    await repository.updateLockCounter(SUBJECT, MAX_CAPTCHA_ATTEMPTS - 1, 'captcha')
    await expect(repository.isUserLocked(SUBJECT)).resolves.toBe(false)

    await repository.updateLockCounter(SUBJECT, MAX_CAPTCHA_ATTEMPTS, 'captcha')
    await expect(repository.isUserLocked(SUBJECT)).resolves.toBe(true)
  })

  it('uses each tier own TTL', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, 1, 'captcha')

    expect(cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.expiresAt).toEqual(new Date(now + NON_CAPTCHA_TTL * 1000))
    expect(cacheEntryRepository.rowsFor(CAPTCHA_KEY)[0].props.expiresAt).toEqual(new Date(now + CAPTCHA_TTL * 1000))
  })

  it('ARMS THE HORIZON ON THE FIRST FAILURE AND NEVER AGAIN, so a client that keeps knocking still gets a fresh window', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')
    const armed = cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.expiresAt
    expect(armed).toEqual(new Date(now + NON_CAPTCHA_TTL * 1000))

    now += 8000
    await repository.updateLockCounter(SUBJECT, 2, 'non-captcha')
    expect(cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.expiresAt).toEqual(armed)

    now += 8000
    await repository.updateLockCounter(SUBJECT, 3, 'non-captcha')
    expect(cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.expiresAt).toEqual(armed)
  })

  it('REOPENS THE WINDOW ON SCHEDULE: a failure past the horizon reads zero and arms a new one', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, 2, 'non-captcha')

    now += (NON_CAPTCHA_TTL + 1) * 1000
    await expect(repository.getLockCounter(SUBJECT, 'non-captcha')).resolves.toEqual(0)

    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')
    expect(cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.expiresAt).toEqual(new Date(now + NON_CAPTCHA_TTL * 1000))
  })

  it('arms the captcha horizon on that tier first failure, independently of the non-captcha one', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')

    now += 10_000
    await repository.updateLockCounter(SUBJECT, 1, 'captcha')
    const captchaArmed = cacheEntryRepository.rowsFor(CAPTCHA_KEY)[0].props.expiresAt
    expect(captchaArmed).toEqual(new Date(now + CAPTCHA_TTL * 1000))

    now += 5000
    await repository.updateLockCounter(SUBJECT, 2, 'captcha')
    expect(cacheEntryRepository.rowsFor(CAPTCHA_KEY)[0].props.expiresAt).toEqual(captchaArmed)
  })

  it('DELETES BEFORE IT WRITES, so one subject never accumulates rows', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, 2, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, 3, 'non-captcha')

    expect(cacheEntryRepository.rowsFor(LOCK_KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.value).toEqual('3')
  })

  it('SERIALIZES concurrent increments for one key, so two failures cannot leave two rows and a stale count', async () => {
    await Promise.all([
      repository.updateLockCounter(SUBJECT, 1, 'non-captcha'),
      repository.updateLockCounter(SUBJECT, 2, 'non-captcha'),
      repository.updateLockCounter(SUBJECT, 3, 'non-captcha'),
    ])

    expect(cacheEntryRepository.rowsFor(LOCK_KEY)).toHaveLength(1)
    await expect(repository.getLockCounter(SUBJECT, 'non-captcha')).resolves.toEqual(3)
  })

  it('does not queue one tier behind the other, nor one subject behind another', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    await Promise.all([
      repository.updateLockCounter(SUBJECT, 1, 'non-captcha'),
      repository.updateLockCounter(SUBJECT, 1, 'captcha'),
      repository.updateLockCounter(other, 1, 'non-captcha'),
    ])

    expect(cacheEntryRepository.rowsFor(LOCK_KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(CAPTCHA_KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(`lock:${other}`)).toHaveLength(1)
  })

  it('replaces a row that somehow has no horizon rather than carrying the absence forward', async () => {
    await cacheEntryRepository.save(CacheEntry.create({ key: LOCK_KEY, value: '2', expiresAt: null }).getValue())

    await repository.updateLockCounter(SUBJECT, 3, 'non-captcha')

    expect(cacheEntryRepository.rowsFor(LOCK_KEY)).toHaveLength(1)
    expect(cacheEntryRepository.rowsFor(LOCK_KEY)[0].props.expiresAt).toEqual(new Date(now + NON_CAPTCHA_TTL * 1000))
  })

  it('clears both tiers on reset, so a completed sign-in really unlocks the account', async () => {
    await repository.updateLockCounter(SUBJECT, 3, 'non-captcha')
    await repository.updateLockCounter(SUBJECT, MAX_CAPTCHA_ATTEMPTS, 'captcha')
    await expect(repository.isUserLocked(SUBJECT)).resolves.toBe(true)

    await repository.resetLockCounter(SUBJECT)

    await expect(repository.getLockCounter(SUBJECT, 'non-captcha')).resolves.toEqual(0)
    await expect(repository.getLockCounter(SUBJECT, 'captcha')).resolves.toEqual(0)
    await expect(repository.isUserLocked(SUBJECT)).resolves.toBe(false)
    expect(cacheEntryRepository.rows).toHaveLength(0)
  })

  it('a reset racing an increment leaves no row behind', async () => {
    await repository.updateLockCounter(SUBJECT, 1, 'non-captcha')

    await Promise.all([repository.updateLockCounter(SUBJECT, 2, 'non-captcha'), repository.resetLockCounter(SUBJECT)])

    expect(cacheEntryRepository.rowsFor(LOCK_KEY)).toHaveLength(0)
  })

  describe('the OTP replay guard, which is a single-use marker and not a lockout', () => {
    it('records a used code for a minute and matches only that code', async () => {
      await repository.lockSuccessfullOTP(SUBJECT, '123456')

      await expect(repository.isOTPLocked(SUBJECT, '123456')).resolves.toBe(true)
      await expect(repository.isOTPLocked(SUBJECT, '654321')).resolves.toBe(false)
      expect(cacheEntryRepository.rowsFor(OTP_KEY)[0].props.expiresAt).toEqual(new Date(now + 60_000))
    })

    it('forgets the code once the minute passes', async () => {
      await repository.lockSuccessfullOTP(SUBJECT, '123456')

      now += 61_000

      await expect(repository.isOTPLocked(SUBJECT, '123456')).resolves.toBe(false)
    })
  })
})
