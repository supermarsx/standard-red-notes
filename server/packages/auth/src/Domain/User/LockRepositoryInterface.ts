/**
 * Standard Red Notes: one currently-tracked failed-login lock, as surfaced to the
 * admin "Locked accounts" panel. `identifier` is the raw lock key subject (a user
 * uuid or an email — whatever the failed attempt was keyed on). `counter` is the
 * non-captcha attempt count, `captchaCounter` the captcha-tier count; `locked` is
 * true once the account has actually crossed the lockout threshold. `ttlSeconds`
 * is the remaining life of the lock (max of the two tiers), -1 when unknown.
 */
export interface LockedAccountEntry {
  identifier: string
  counter: number
  captchaCounter: number
  ttlSeconds: number
  locked: boolean
}

export interface LockRepositoryInterface {
  resetLockCounter(userIdentifier: string): Promise<void>
  updateLockCounter(userIdentifier: string, counter: number, mode: 'captcha' | 'non-captcha'): Promise<void>
  getLockCounter(userIdentifier: string, mode: 'captcha' | 'non-captcha'): Promise<number>
  isUserLocked(userIdentifier: string): Promise<boolean>
  lockSuccessfullOTP(userIdentifier: string, otp: string): Promise<void>
  isOTPLocked(userIdentifier: string, otp: string): Promise<boolean>
  /**
   * Standard Red Notes: OPTIONAL admin listing of currently-tracked failed-login
   * locks (backs the anti-abuse "Locked accounts" panel). Implemented only by the
   * Redis-backed repository (SCAN over the lock keys); absent under the TypeORM
   * cache topology, where the admin endpoint degrades to "not available".
   */
  listLockedAccounts?(): Promise<LockedAccountEntry[]>
}
