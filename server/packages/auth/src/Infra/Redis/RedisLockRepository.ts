import * as IORedis from 'ioredis'

import { LockedAccountEntry, LockRepositoryInterface } from '../../Domain/User/LockRepositoryInterface'

export class RedisLockRepository implements LockRepositoryInterface {
  private readonly PREFIX = 'lock'
  private readonly CAPTCHA_PREFIX = 'captcha-lock'
  private readonly OTP_PREFIX = 'otp-lock'

  constructor(
    private redisClient: IORedis.Redis,
    private maxLoginAttempts: number,
    private nonCaptchaLockTTL: number,
    private captchaLockTTL: number,
  ) {}

  async lockSuccessfullOTP(userIdentifier: string, otp: string): Promise<void> {
    await this.redisClient.setex(`${this.OTP_PREFIX}:${userIdentifier}`, 60, otp)
  }

  async isOTPLocked(userIdentifier: string, otp: string): Promise<boolean> {
    const lock = await this.redisClient.get(`${this.OTP_PREFIX}:${userIdentifier}`)

    return lock === otp
  }

  async resetLockCounter(userIdentifier: string): Promise<void> {
    const pipeline = this.redisClient.pipeline()

    pipeline.del(`${this.PREFIX}:${userIdentifier}`)
    pipeline.del(`${this.CAPTCHA_PREFIX}:${userIdentifier}`)

    await pipeline.exec()
  }

  async updateLockCounter(userIdentifier: string, counter: number, mode: 'captcha' | 'non-captcha'): Promise<void> {
    const prefix = mode === 'captcha' ? this.CAPTCHA_PREFIX : this.PREFIX
    const lockTTL = mode === 'captcha' ? this.captchaLockTTL : this.nonCaptchaLockTTL

    await this.redisClient.setex(`${prefix}:${userIdentifier}`, lockTTL, counter)
  }

  async getLockCounter(userIdentifier: string, mode: 'captcha' | 'non-captcha'): Promise<number> {
    const prefix = mode === 'captcha' ? this.CAPTCHA_PREFIX : this.PREFIX

    const counter = await this.redisClient.get(`${prefix}:${userIdentifier}`)

    if (!counter) {
      return 0
    }

    return +counter
  }

  async isUserLocked(userIdentifier: string): Promise<boolean> {
    const counter = await this.getLockCounter(userIdentifier, 'captcha')

    return counter >= this.maxLoginAttempts
  }

  /**
   * Standard Red Notes: list every currently-tracked failed-login lock for the
   * admin anti-abuse panel. Uses SCAN (never KEYS) so it is safe on a large,
   * busy Redis, walking both the non-captcha (`lock:*`) and captcha
   * (`captcha-lock:*`) tiers and merging them by identifier. For each we read the
   * counter value and remaining TTL; `locked` mirrors isUserLocked (the captcha
   * counter has crossed the max-attempts threshold). The OTP lock (`otp-lock:*`)
   * is deliberately excluded — it is a single-use replay guard, not a lockout.
   */
  async listLockedAccounts(): Promise<LockedAccountEntry[]> {
    const byIdentifier = new Map<string, { counter: number; captchaCounter: number; ttlSeconds: number }>()

    await this.scanTier(this.PREFIX, (identifier, value, ttl) => {
      const entry = byIdentifier.get(identifier) ?? { counter: 0, captchaCounter: 0, ttlSeconds: -1 }
      entry.counter = value
      entry.ttlSeconds = Math.max(entry.ttlSeconds, ttl)
      byIdentifier.set(identifier, entry)
    })

    await this.scanTier(this.CAPTCHA_PREFIX, (identifier, value, ttl) => {
      const entry = byIdentifier.get(identifier) ?? { counter: 0, captchaCounter: 0, ttlSeconds: -1 }
      entry.captchaCounter = value
      entry.ttlSeconds = Math.max(entry.ttlSeconds, ttl)
      byIdentifier.set(identifier, entry)
    })

    const accounts: LockedAccountEntry[] = []
    for (const [identifier, entry] of byIdentifier) {
      accounts.push({
        identifier,
        counter: entry.counter,
        captchaCounter: entry.captchaCounter,
        ttlSeconds: entry.ttlSeconds,
        locked: entry.captchaCounter >= this.maxLoginAttempts,
      })
    }

    // Most-attempts-first so the worst offenders surface at the top.
    accounts.sort((a, b) => b.captchaCounter + b.counter - (a.captchaCounter + a.counter))

    return accounts
  }

  /**
   * SCAN a single lock tier (`<prefix>:*`) in batches, reading each key's value +
   * TTL and handing the un-prefixed identifier to the callback. Non-numeric
   * values are skipped defensively.
   */
  private async scanTier(
    prefix: string,
    onEntry: (identifier: string, value: number, ttlSeconds: number) => void,
  ): Promise<void> {
    const match = `${prefix}:*`
    let cursor = '0'
    do {
      const [nextCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', match, 'COUNT', 200)
      cursor = nextCursor

      for (const key of keys) {
        const identifier = key.slice(prefix.length + 1)
        if (identifier === '') {
          continue
        }
        const [rawValue, ttl] = await Promise.all([this.redisClient.get(key), this.redisClient.ttl(key)])
        const value = rawValue !== null ? Number(rawValue) : NaN
        if (!Number.isFinite(value)) {
          continue
        }
        onEntry(identifier, value, typeof ttl === 'number' ? ttl : -1)
      }
    } while (cursor !== '0')
  }
}
