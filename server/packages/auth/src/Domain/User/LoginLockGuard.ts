import { RoleName, Username } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { LockRepositoryInterface } from './LockRepositoryInterface'
import { UserRepositoryInterface } from './UserRepositoryInterface'

/**
 * Why a sign-in attempt was allowed through despite a standing lock. Recorded so
 * the audit log and the admin panel can tell "nobody is attacking this account"
 * apart from "an attack is being absorbed by an exemption".
 */
export type LoginLockExemption = 'none' | 'trusted-source' | 'last-administrator' | 'recovery-route'

export interface LoginLockDecision {
  /** false means refuse the request with 423. */
  allowed: boolean
  /** Seconds to stall before continuing. Applies to allowed requests too. */
  delaySeconds: number
  exemption: LoginLockExemption
  /** Total failed attempts across both tiers, for logging. */
  attempts: number
}

export interface LoginLockGuardDTO {
  /** The submitted email or username. */
  identifier: string
  /** Resolved client address (the gateway's x-origin-ip), when known. */
  clientIp?: string
  /** True for /auth/recovery/login, which is never hard-refused. */
  isRecoveryRoute: boolean
}

/**
 * Standard Red Notes: exponential back-off between the non-captcha threshold and
 * the hard lock.
 *
 * PURE so the ramp can be asserted without a clock. With the default threshold 6
 * and cap 30 the ramp is 1, 2, 4, 8, 16, 30, 30 seconds across attempts 6..12 —
 * roughly 91 seconds of enforced patience before the lock engages. A person who
 * mistyped their password once or twice waits exactly nothing; an automated
 * guesser is finished long before it gets anywhere.
 *
 * This is the mitigation that makes the whole scheme cheap to be wrong about: it
 * costs an attacker real time WITHOUT taking anything away from the account
 * owner, which a lockout, by construction, cannot say.
 */
export function progressiveLockDelaySeconds(attempts: number, threshold: number, capSeconds: number): number {
  if (!Number.isFinite(attempts) || !Number.isFinite(threshold) || !Number.isFinite(capSeconds)) {
    return 0
  }
  if (capSeconds <= 0 || threshold <= 0 || attempts < threshold) {
    return 0
  }

  // 2^0 on the first attempt at/after the threshold. Exponent is clamped so a
  // corrupt counter cannot produce Infinity before the cap is applied.
  const exponent = Math.min(Math.floor(attempts - threshold), 32)

  return Math.min(Math.pow(2, exponent), Math.floor(capSeconds))
}

/**
 * Standard Red Notes: normalize an address for comparison against the addresses
 * already recorded on the account's sessions. Unwraps the IPv6-mapped IPv4 form
 * so `::ffff:203.0.113.4` and `203.0.113.4` are recognised as the same client.
 */
export function normalizeLockClientIp(value: string | undefined | null): string {
  if (typeof value !== 'string') {
    return ''
  }
  const trimmed = value.trim().toLowerCase()

  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed
}

/**
 * Standard Red Notes: the single decision point for "may this sign-in attempt
 * proceed?".
 *
 * It exists as a service rather than as middleware because the middleware is NOT
 * on every path. Under the DirectCall (single-container) topology the gateway
 * calls `Service.handleRequest`, which invokes the registered controller method
 * directly — Express middleware never runs — so lockout enforcement that lives
 * only in LockMiddleware is simply absent there. Both the middleware and the
 * controller consult this guard, so the two topologies cannot drift apart.
 *
 * THE DENIAL-OF-SERVICE PROBLEM THIS ANSWERS. Lockout is account-scoped: the
 * counter is keyed on the account, and anyone who knows an address can drive it.
 * For an end-to-end encrypted notes application, being locked out of the account
 * means being locked out of the notes, so a naive lockout hands any stranger a
 * 24-hour denial of service against any address they can guess. The three
 * exemptions below shrink the blast radius without removing the protection:
 *
 *   1. TRUSTED SOURCE  — an address the account has already signed in from
 *      successfully is never hard-refused, so the owner's own machine cannot be
 *      used against them by a stranger elsewhere.
 *   2. LAST ADMINISTRATOR — see lastAdministratorExempt() for why this is a
 *      deliberate trade rather than pure safety.
 *   3. RECOVERY ROUTE — see the note in evaluate().
 *
 * Every exemption still returns the full progressive delay, and every attempt is
 * still counted by the controller downstream. An exemption buys an attacker
 * patience, never speed.
 *
 * FAILURE DIRECTION. Each exemption lookup is individually wrapped and treated as
 * "not exempt" on error. The new checks can therefore only ever LOOSEN the
 * outcome, never tighten it: an infrastructure problem degrades to exactly the
 * behaviour that shipped before this guard existed, and can never invent a
 * refusal that would not otherwise have happened.
 */
export class LoginLockGuard {
  constructor(
    private userRepository: UserRepositoryInterface,
    private lockRepository: LockRepositoryInterface,
    private sessionRepository: SessionRepositoryInterface,
    private maxLoginAttempts: number,
    private progressiveDelayCapSeconds: number,
    private trustedSourceExemptionEnabled: boolean,
    private logger: Logger,
  ) {}

  async evaluate(dto: LoginLockGuardDTO): Promise<LoginLockDecision> {
    const usernameOrError = Username.create(dto.identifier, { skipValidation: true })
    if (usernameOrError.isFailed()) {
      // Not a usable identifier: there is nothing to look up and nothing to
      // refuse. The controller rejects the credentials on its own terms.
      return { allowed: true, delaySeconds: 0, exemption: 'none', attempts: 0 }
    }

    const user = await this.userRepository.findOneByUsernameOrEmail(usernameOrError.getValue())
    const subject = user?.uuid ?? dto.identifier

    const [nonCaptchaAttempts, captchaAttempts, locked] = await Promise.all([
      this.lockRepository.getLockCounter(subject, 'non-captcha'),
      this.lockRepository.getLockCounter(subject, 'captcha'),
      this.lockRepository.isUserLocked(subject),
    ])
    const attempts = nonCaptchaAttempts + captchaAttempts
    const delaySeconds = progressiveLockDelaySeconds(attempts, this.maxLoginAttempts, this.progressiveDelayCapSeconds)

    if (!locked) {
      return { allowed: true, delaySeconds, exemption: 'none', attempts }
    }

    /**
     * DELIBERATE WIDENING, stated plainly: the recovery route is never hard
     * refused. /auth/recovery/login is the owner's documented way back in, and
     * refusing it means the lock closes the very escape hatch it makes necessary.
     * The attempt is STILL counted by the controller and STILL delayed by the
     * full ramp, and it is still covered by the gateway's per-address tier, so
     * this exempts the route from LOCKING, not from everything. Recovery codes
     * are high-entropy, which is what makes the trade defensible.
     */
    if (dto.isRecoveryRoute) {
      return { allowed: true, delaySeconds, exemption: 'recovery-route', attempts }
    }

    if (user !== null && (await this.trustedSourceExempt(user.uuid, dto.clientIp))) {
      return { allowed: true, delaySeconds, exemption: 'trusted-source', attempts }
    }

    if (user !== null && (await this.lastAdministratorExempt(user))) {
      return { allowed: true, delaySeconds, exemption: 'last-administrator', attempts }
    }

    return { allowed: false, delaySeconds, exemption: 'none', attempts }
  }

  /**
   * Whether this address has already completed a sign-in for this account.
   *
   * READ-ONLY, BY DESIGN. An earlier draft stored a salted hash of the client
   * address for thirty days. That would have been new per-user network-location
   * data on a server whose whole proposition is knowing as little as possible
   * about its users — and it would not have been removed on account deletion
   * (the deletion handler removes sessions and the user row, not cache keys), nor
   * appeared in any export, nor been disclosed anywhere in the interface.
   *
   * Session.ipAddress already records exactly this, is already removed on
   * sign-out, on revoke and on account deletion, and is already under the user's
   * control through the gesture they already have: revoking a session withdraws
   * the exemption with it. So this asks a question of data the server keeps
   * anyway rather than creating a new thing to retain, and a safety feature
   * cannot quietly become a tracking feature.
   *
   * Two limitations worth naming rather than burying: Session.ipAddress is stored
   * in plaintext and is not currently surfaced in the sessions interface (a
   * pre-existing choice this does not worsen and does not fix); and someone
   * behind the same NAT as the owner inherits the exemption — they still face the
   * full delay ramp and the gateway's per-address tier.
   */
  private async trustedSourceExempt(userUuid: string, clientIp: string | undefined): Promise<boolean> {
    if (!this.trustedSourceExemptionEnabled) {
      return false
    }
    const normalized = normalizeLockClientIp(clientIp)
    if (normalized === '') {
      return false
    }

    try {
      const sessions = await this.sessionRepository.findAllByUserUuid(userUuid)

      return sessions.some((session) => normalizeLockClientIp(session.ipAddress) === normalized)
    } catch (error) {
      this.logger.warn('Trusted-source lock exemption lookup failed; treating the source as unknown.', {
        errorType: (error as Error)?.name,
      })

      return false
    }
  }

  /**
   * Standard Red Notes: the last remaining administrator is never hard-locked.
   *
   * THIS IS A TRADE, NOT PURE SAFETY, and it should be read as one. An attacker
   * who knows (or guesses) that an account is the sole administrator gets
   * unlimited attempts against it, bounded only by the progressive delay and the
   * gateway's per-address tier. That is a real weakening of this one account.
   *
   * It is still the right call for this deployment shape. A self-hosted instance
   * typically has exactly one administrator; locking that account means nobody
   * can reach the admin panel to unlock it, and an unrecoverable instance is
   * worse than a slow-guessable admin password. `srn-admin lock clear` is the
   * backstop, but it requires shell access to the container, which the person
   * locked out of their own notes may not have to hand.
   *
   * Do not "fix" this by removing it. If it should go, what replaces it is a
   * second administrator, not a stricter lock.
   */
  private async lastAdministratorExempt(user: { uuid: string; roles: Promise<{ name: string }[]> }): Promise<boolean> {
    try {
      const roles = await user.roles
      if (!roles.some((role) => role.name === RoleName.NAMES.AdminUser)) {
        return false
      }

      // Bounded LIMIT 2 — we only care whether the total is <= 1.
      const admins = await this.userRepository.findUsersForAdmin({
        role: RoleName.NAMES.AdminUser,
        limit: 2,
        offset: 0,
        sort: 'createdAt',
      })

      return admins.total <= 1
    } catch (error) {
      this.logger.warn('Last-administrator lock exemption lookup failed; treating the account as non-exempt.', {
        errorType: (error as Error)?.name,
      })

      return false
    }
  }
}
