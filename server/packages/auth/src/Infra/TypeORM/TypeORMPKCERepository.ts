import { CacheEntry, CacheEntryRepositoryInterface } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import { PKCERepositoryInterface } from '../../Domain/User/PKCERepositoryInterface'

/**
 * DB-cache-table backed PKCE code-challenge store, bound whenever the auth
 * server runs without Redis (`CACHE_TYPE=memory`): the single container, the LXC
 * install and every `@standardnotes/home-server` bundle, since HomeServer forces
 * `CACHE_TYPE: 'memory'` through its environment overrides.
 *
 * WHY THE DELETE'S RETURN VALUE IS THE WHOLE CHECK
 *
 * `removeCodeChallenge` USED TO `return true` unconditionally. That is not the
 * same statement as "a row was removed": the shared
 * `CacheEntryRepositoryInterface.removeByKey` is `Promise<void>` and
 * `TypeORMCacheEntryRepository` throws away `DeleteResult.affected`, so the
 * DELETE resolves identically over a live row, an expired row and no row at all.
 * `SignIn.validateCodeVerifier` and `SignInWithRecoveryCodes` take that boolean
 * AS the verdict, so on this arm the PKCE step accepted any `code_verifier`
 * string whatsoever -- `RedisPKCERepository` returns `del(...) === 1` and really
 * checks, which is why the same probe was refused on multi-container and signed
 * in on the single container.
 *
 * What that cost was not an authentication bypass -- the account password is
 * still verified afterwards -- but a SECOND-FACTOR bypass. MFA is enforced at
 * `/v1|v2/login-params` (`BaseAuthController.pkceParams`), together with the
 * proof-of-work anti-bot gate; `/auth/pkce_sign_in` verifies no second factor at
 * all. The single-use code challenge is the only thing that forces a sign-in to
 * have come through that MFA-verified request, so a vacuous delete let a holder
 * of the account password alone skip `/login-params` entirely.
 *
 * RESIDUAL ATOMICITY WINDOW, stated as the sibling
 * `TypeORMProofOfWorkChallengeRepository` states its own: the shared interface
 * offers only save / findUnexpiredOneByKey / removeByKey, with no
 * compare-and-delete and no delete-returning-affected-rows, so the lookup and
 * the delete are two statements and two truly simultaneous presentations of the
 * SAME verifier can both observe the live row and both return true. The window
 * is one DB round-trip wide, exists only on this non-default arm (Redis `DEL` is
 * atomic), and -- unlike the bug above -- it cannot manufacture a challenge: a
 * row is only ever written by a `/login-params` call that already satisfied the
 * second factor, so at worst a client double-spends a challenge it legitimately
 * earned.
 */
export class TypeORMPKCERepository implements PKCERepositoryInterface {
  private readonly PREFIX = 'pkce'

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private logger: Logger,
    private timer: TimerInterface,
  ) {}

  async storeCodeChallenge(codeChallenge: string): Promise<void> {
    this.logger.debug(`Storing code challenge: ${codeChallenge}`)

    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key: this.keyFor(codeChallenge),
        value: codeChallenge,
        expiresAt: this.timer.getUTCDateNSecondsAhead(3600),
      }).getValue(),
    )
  }

  async removeCodeChallenge(codeChallenge: string): Promise<boolean> {
    const key = this.keyFor(codeChallenge)

    // Report only what is true: that THIS caller found a LIVE row and removed
    // it. `findUnexpiredOneByKey` filters `expires_at > now` in SQL, so an
    // hour-old challenge reads as absent exactly as an expired Redis key does.
    const entry = await this.cacheEntryRepository.findUnexpiredOneByKey(key)
    if (entry === null) {
      this.logger.debug(`No live entry to remove for code challenge: ${codeChallenge}`)

      return false
    }

    // Deletes BY KEY, so it also clears any duplicate rows -- `CacheEntry.create`
    // mints a fresh UniqueEntityId per call and `auth_cache_entries` has no
    // unique index on `key`, so two `/login-params` calls carrying the same
    // challenge leave two rows and both must go.
    await this.cacheEntryRepository.removeByKey(key)

    this.logger.debug(`Removed the entry for code challenge: ${codeChallenge}`)

    return true
  }

  private keyFor(codeChallenge: string): string {
    return `${this.PREFIX}:${codeChallenge}`
  }
}
