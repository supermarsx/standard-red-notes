import { CacheEntry, CacheEntryRepositoryInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { SessionTokensCooldownRepositoryInterface } from '../../Domain/Session/SessionTokensCooldownRepositoryInterface'

/**
 * The session-token cooldown window for deployments with NO Redis.
 *
 * WHY THIS IS A TABLE AND NOT A MAP
 *
 * A rotated credential must answer 498 `expired-access-token` (stale, retry with
 * the new token) for `COOLDOWN_SESSION_TOKENS_TTL` seconds instead of 401. The
 * no-Redis branch used to bind a stub whose `getHashedTokens` always returned
 * null, so the window did not exist at all and a rotation went straight to 401
 * -> REVOKED: a logout-grade failure on sync, collaboration and files alike.
 *
 * A process-local map would work for the single container (one node process
 * hosts auth, syncing-server, files and the gateway together), but it would need
 * its own expiry clock and its own size bound to avoid both a memory leak and a
 * credential that outlives its cooldown. The cache table already supplies both:
 * `findUnexpiredOneByKey` filters on `expires_at > now` IN SQL, so the horizon is
 * enforced by the same mechanism the six sibling repositories in this same
 * no-Redis branch rely on (ephemeral sessions, offline/subscription tokens, MFA
 * secrets, locks, PoW challenges). It is also strictly better than a map: the
 * window survives a process restart, so a rotation that straddles one still gets
 * its 498 rather than degrading to the 401 this class exists to remove.
 *
 * The stored value is byte-identical to {@link RedisSessionTokensCooldownRepository}'s
 * -- `<format version>:<hashed access>:<hashed refresh>` -- so the two topologies
 * cannot drift in how they read a cooldown back.
 *
 * `setCooldown` deletes before it writes. `CacheEntry.create` mints a fresh
 * UniqueEntityId on every call, so `save` INSERTs rather than upserts: without
 * the delete, two refreshes inside one TTL would leave two unexpired rows under
 * one key and `findUnexpiredOneByKey`'s unordered `getOne()` could hand back the
 * OLDER pair -- missing the very 498 this exists for -- while the table grew
 * without bound. The delete+insert pair is not atomic the way Redis `SETEX` is,
 * but the gap can only hide a cooldown that was about to be overwritten anyway,
 * never one that a concurrent request would otherwise have matched.
 */
export class TypeORMSessionTokensCooldownRepository implements SessionTokensCooldownRepositoryInterface {
  private readonly PREFIX = 'cooldown:session-tokens'
  private readonly COOLDOWN_FORMAT_VERSION = 1

  constructor(
    private cacheEntryRepository: CacheEntryRepositoryInterface,
    private timer: TimerInterface,
  ) {}

  async getHashedTokens(sessionUuid: Uuid): Promise<{ hashedAccessToken: string; hashedRefreshToken: string } | null> {
    const cacheEntry = await this.cacheEntryRepository.findUnexpiredOneByKey(this.keyFor(sessionUuid))
    if (!cacheEntry) {
      return null
    }

    const [version, hashedAccessToken, hashedRefreshToken] = cacheEntry.props.value.split(':')

    if (parseInt(version) !== this.COOLDOWN_FORMAT_VERSION) {
      return null
    }

    // Both halves are sha256 hex, and `GetSessionFromToken` feeds them straight
    // to `crypto.timingSafeEqual`, which THROWS on a length mismatch and on
    // `Buffer.from(undefined)`. A truncated row must read as "no cooldown".
    if (!hashedAccessToken || !hashedRefreshToken) {
      return null
    }

    return {
      hashedAccessToken,
      hashedRefreshToken,
    }
  }

  async setCooldown(dto: {
    sessionUuid: Uuid
    hashedAccessToken: string
    hashedRefreshToken: string
    cooldownPeriodInSeconds: number
  }): Promise<void> {
    const key = this.keyFor(dto.sessionUuid)

    await this.cacheEntryRepository.removeByKey(key)

    await this.cacheEntryRepository.save(
      CacheEntry.create({
        key,
        value: `${this.COOLDOWN_FORMAT_VERSION}:${dto.hashedAccessToken}:${dto.hashedRefreshToken}`,
        expiresAt: this.timer.getUTCDateNSecondsAhead(dto.cooldownPeriodInSeconds),
      }).getValue(),
    )
  }

  private keyFor(sessionUuid: Uuid): string {
    return `${this.PREFIX}:${sessionUuid.value}`
  }
}
