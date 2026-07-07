import { Username } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { LockRepositoryInterface } from '../User/LockRepositoryInterface'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { RequestProofOfWorkChallenge } from '../UseCase/RequestProofOfWorkChallenge/RequestProofOfWorkChallenge'
import { VerifyProofOfWork } from '../UseCase/VerifyProofOfWork/VerifyProofOfWork'

import { IpEscalationCheckerInterface } from './IpEscalationCheckerInterface'
import { ProofOfWorkConfigResolverInterface } from './ProofOfWorkConfigResolverInterface'
import { ProofOfWorkScope, ProofOfWorkScopeConfig } from './ProofOfWorkConfig'

export interface ProofOfWorkChallengePayload {
  seed: string
  difficulty: number
  algorithm: string
  ttlSeconds: number
}

export type ProofOfWorkGateResult = { satisfied: true } | { satisfied: false; challenge: ProofOfWorkChallengePayload }

/**
 * Standard Red Notes: the enforcement seam for the proof-of-work anti-bot
 * challenge. It decides WHETHER a challenge is required (config + adaptive
 * escalation), verifies a submitted solution, and — when the solution is
 * missing/invalid — mints a fresh challenge to hand back to the client so it
 * can solve and resubmit (the same "server issues challenge in the error, client
 * solves, retries" shape used for MFA).
 *
 * Resilience: this is a bot-resistance layer, not an authenticator. If the
 * challenge store is unavailable it FAILS OPEN (treats the request as
 * satisfied), matching the gateway rate-limiter's philosophy, so an
 * infrastructure blip never locks legitimate users out of sign-in/registration.
 * The account password and MFA are verified elsewhere and are unaffected.
 */
export class ProofOfWorkGate {
  constructor(
    private requestChallenge: RequestProofOfWorkChallenge,
    private verifyProofOfWork: VerifyProofOfWork,
    private configResolver: ProofOfWorkConfigResolverInterface,
    private lockRepository: LockRepositoryInterface,
    private userRepository: UserRepositoryInterface,
    private logger: Logger,
    // Standard Red Notes: optional reader for the gateway's per-IP escalate flag
    // (shared Redis). When present AND the resolved client IP is escalated, the
    // adaptive sign-in gate requires PoW even below the account threshold. Absent
    // (no shared Redis / older wiring) => escalation simply never triggers.
    private escalationChecker?: IpEscalationCheckerInterface,
  ) {}

  async enforceRegister(requestBody: Record<string, unknown>): Promise<ProofOfWorkGateResult> {
    try {
      const config = (await this.configResolver.resolve()).register
      if (!config.enabled) {
        return { satisfied: true }
      }

      return await this.verifyOrIssue('register', config, requestBody)
    } catch (error) {
      this.logger.warn(`Proof-of-work register gate failed open: ${(error as Error).message}`)

      return { satisfied: true }
    }
  }

  async enforceSignInParams(
    email: string,
    requestBody: Record<string, unknown>,
    bypass: boolean,
    // Standard Red Notes: the resolved client IP reaching auth (from the gateway's
    // x-origin-ip header). Used to consult the shared per-IP escalate flag. When
    // omitted, only the account-based adaptive rule applies (unchanged behavior).
    clientIp?: string,
  ): Promise<ProofOfWorkGateResult> {
    try {
      // A pre-authorized credential (valid app password / trusted device) skips
      // the challenge entirely — that is the deliberate escape hatch for legit
      // headless/automation clients.
      if (bypass) {
        return { satisfied: true }
      }

      const config = (await this.configResolver.resolve()).signIn
      if (!config.enabled) {
        return { satisfied: true }
      }

      // In 'always' mode PoW is required unconditionally. In 'adaptive' mode it is
      // required when EITHER the account has crossed the failed-attempt threshold
      // OR the gateway has flagged this IP for escalation (shared Redis). The
      // ip-escalate check fails open to false, so it can only ADD enforcement.
      const required =
        config.mode === 'always'
          ? true
          : (await this.adaptiveRequirementReached(email, config.adaptiveThreshold)) ||
            (await this.ipEscalated(clientIp))
      if (!required) {
        return { satisfied: true }
      }

      return await this.verifyOrIssue('signIn', config, requestBody)
    } catch (error) {
      this.logger.warn(`Proof-of-work sign-in gate failed open: ${(error as Error).message}`)

      return { satisfied: true }
    }
  }

  private async verifyOrIssue(
    scope: ProofOfWorkScope,
    config: ProofOfWorkScopeConfig,
    requestBody: Record<string, unknown>,
  ): Promise<ProofOfWorkGateResult> {
    const verifyResult = await this.verifyProofOfWork.execute({
      scope,
      seed: requestBody.pow_seed,
      nonce: requestBody.pow_nonce,
    })
    if (!verifyResult.isFailed()) {
      return { satisfied: true }
    }

    // We only reach here when PoW is ENABLED for this scope, so a challenge MUST
    // demand real work. A difficulty <= 0 (misconfiguration) would otherwise fail
    // OPEN — proofOfWorkSolutionMeetsDifficulty treats <= 0 as "no work required",
    // so any nonce would pass a challenge that looks enforced. Clamp to a minimum
    // effective difficulty of 1 at the moment we mint the challenge, so the stored
    // (authoritative) difficulty verification later reads is always >= 1.
    const effectiveDifficulty = Math.max(1, Math.floor(config.difficulty))
    if (effectiveDifficulty !== config.difficulty) {
      this.logger.warn(
        `Proof-of-work ${scope} is enabled with difficulty ${config.difficulty}; ` +
          `enforcing a minimum effective difficulty of ${effectiveDifficulty} so it cannot fail open.`,
      )
    }

    const challengeResult = await this.requestChallenge.execute({
      scope,
      difficulty: effectiveDifficulty,
      ttlSeconds: config.ttlSeconds,
    })

    return {
      satisfied: false,
      challenge: challengeResult.getValue(),
    }
  }

  /**
   * Whether the gateway has flagged this client IP for escalation (an active
   * `rl:escalate:<ip>` key in the shared Redis). Gated by the same
   * adaptiveEscalation config the gateway uses to set the flag; fails open to
   * false so a Redis error never forces PoW. No checker / no IP => false.
   */
  private async ipEscalated(clientIp?: string): Promise<boolean> {
    if (this.escalationChecker === undefined || clientIp === undefined || clientIp === '') {
      return false
    }

    return this.escalationChecker.isEscalated(clientIp)
  }

  private async adaptiveRequirementReached(email: string, threshold: number): Promise<boolean> {
    if (threshold <= 0) {
      return true
    }

    let identifier = email
    const usernameOrError = Username.create(email, { skipValidation: true })
    if (!usernameOrError.isFailed()) {
      const user = await this.userRepository.findOneByUsernameOrEmail(usernameOrError.getValue())
      if (user !== null) {
        identifier = user.uuid
      }
    }

    const nonCaptchaAttempts = await this.lockRepository.getLockCounter(identifier, 'non-captcha')
    const captchaAttempts = await this.lockRepository.getLockCounter(identifier, 'captcha')

    return nonCaptchaAttempts + captchaAttempts >= threshold
  }
}
