import { CacheEntryRepositoryInterface, CacheEntry } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { LockRepositoryInterface } from '../../Domain/User/LockRepositoryInterface'

export class TypeORMLockRepository implements LockRepositoryInterface {
  private readonly PREFIX = 'lock'
  private readonly CAPTCHA_PREFIX = 'captcha-lock'
  private readonly OTP_PREFIX = 'otp-lock'
  /** Per-key promise chain, so delete-then-write cannot interleave. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private timer: TimerInterface,
    private maxLoginAttempts: number,
    private nonCaptchaLockTTL: number,
    private captchaLockTTL: number,
  ) {}

  async lockSuccessfullOTP(userIdentifier: string, otp: string): Promise<void> {
    const cacheEntryOrError = CacheEntry.create({
      key: `${this.OTP_PREFIX}:${userIdentifier}`,
      value: otp,
      expiresAt: this.timer.getUTCDateNSecondsAhead(60),
    })
    if (cacheEntryOrError.isFailed()) {
      throw new Error('Could not create cache entry')
    }

    await this.cacheEntryRepository.save(cacheEntryOrError.getValue())
  }

  async isOTPLocked(userIdentifier: string, otp: string): Promise<boolean> {
    const lock = await this.cacheEntryRepository.findUnexpiredOneByKey(`${this.OTP_PREFIX}:${userIdentifier}`)
    if (!lock) {
      return false
    }

    return lock.props.value === otp
  }

  async resetLockCounter(userIdentifier: string): Promise<void> {
    const nonCaptchaKey = `${this.PREFIX}:${userIdentifier}`
    const captchaKey = `${this.CAPTCHA_PREFIX}:${userIdentifier}`

    // Through each key's own mutex, so a successful sign-in's clear cannot land
    // between an in-flight increment's delete and its write and leave the row
    // behind.
    await this.withLock(nonCaptchaKey, () => this.cacheEntryRepository.removeByKey(nonCaptchaKey))
    await this.withLock(captchaKey, () => this.cacheEntryRepository.removeByKey(captchaKey))
  }

  /**
   * Standard Red Notes: A FIXED WINDOW. THE HORIZON IS ARMED ON THE FIRST FAILURE
   * AND NEVER AGAIN.
   *
   * This used to recompute `expiresAt = now + lockTTL` on EVERY increment, which
   * made the failed-login counter a SLIDING window: it could not decay while the
   * client kept knocking. Measured on a live single container with
   * FAILED_LOGIN_LOCKOUT=20, three failures eight seconds apart:
   *
   *   t=0   lock:<uuid> = 1  expires_at 18:30:43
   *   t=8   lock:<uuid> = 2  expires_at 18:30:53   <- moved
   *   t=16  lock:<uuid> = 3  expires_at 18:31:04   <- moved again
   *
   * so sixteen seconds of attempts never closed a twenty-second window, the
   * counter reached the non-captcha ceiling and the next failure escalated it to
   * the captcha tier. With the horizon armed once, the window shuts at 18:30:43
   * and that fourth failure opens a FRESH window at 1 instead.
   *
   * WHO THAT COSTS. An attacker is indifferent -- they back off and get a clean
   * window either way. The client that keeps knocking inside the TTL is the honest
   * one: a desktop or CLI client holding a stale password retries on a schedule,
   * and under a sliding window its failures accumulate across days until the
   * account crosses the hard lock and answers 423. The owner then cannot sign in
   * even with the right password, because the lock is checked BEFORE the
   * credential. And short of the lock, `LoginLockGuard`'s progressive delay is
   * computed from the same never-decaying counters, so it stays pinned at its cap
   * -- charged to the owner on the attempt where they finally type it correctly.
   *
   * A row that cannot expire is the worst outcome available to a lockout counter,
   * which is why the horizon is written in the SAME `save` as the value and a row
   * found without one is replaced rather than carried forward.
   *
   * DELETE BEFORE WRITE, under the key's mutex: `auth_cache_entries` has no unique
   * index on `key`, so mutating the found entity worked only while exactly one row
   * existed. Two concurrent failures for one account could leave two, after which
   * the unordered `getOne()` behind `findUnexpiredOneByKey` may return either --
   * reading a lower count, or an older horizon, at random.
   */
  async updateLockCounter(userIdentifier: string, counter: number, mode: 'captcha' | 'non-captcha'): Promise<void> {
    const prefix = mode === 'captcha' ? this.CAPTCHA_PREFIX : this.PREFIX
    const lockTTL = mode === 'captcha' ? this.captchaLockTTL : this.nonCaptchaLockTTL
    const key = `${prefix}:${userIdentifier}`

    await this.withLock(key, async (): Promise<void> => {
      const existing = await this.cacheEntryRepository.findUnexpiredOneByKey(key)
      const expiresAt =
        existing !== null && existing.props.expiresAt !== null
          ? existing.props.expiresAt
          : this.timer.getUTCDateNSecondsAhead(lockTTL)

      await this.cacheEntryRepository.removeByKey(key)
      await this.cacheEntryRepository.save(CacheEntry.create({ key, value: counter.toString(), expiresAt }).getValue())
    })
  }

  async getLockCounter(userIdentifier: string, mode: 'captcha' | 'non-captcha'): Promise<number> {
    const prefix = mode === 'captcha' ? this.CAPTCHA_PREFIX : this.PREFIX

    const counter = await this.cacheEntryRepository.findUnexpiredOneByKey(`${prefix}:${userIdentifier}`)

    if (!counter) {
      return 0
    }

    return +counter.props.value
  }

  async isUserLocked(userIdentifier: string): Promise<boolean> {
    const counter = await this.getLockCounter(userIdentifier, 'captcha')

    return counter >= this.maxLoginAttempts
  }

  /**
   * Run `work` after everything already queued for `key`, never before. The chain
   * is cleared once it drains, so the map only holds keys with work in flight.
   */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    // Swallow a predecessor's rejection: one failed write must not poison every
    // later attempt against the same account.
    const run = previous.then(
      () => work(),
      () => work(),
    )
    this.locks.set(key, run)

    try {
      return await run
    } finally {
      if (this.locks.get(key) === run) {
        this.locks.delete(key)
      }
    }
  }
}
