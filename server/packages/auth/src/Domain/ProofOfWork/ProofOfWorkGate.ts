import { Username } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { LockRepositoryInterface } from '../User/LockRepositoryInterface'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { RequestProofOfWorkChallenge } from '../UseCase/RequestProofOfWorkChallenge/RequestProofOfWorkChallenge'
import { VerifyProofOfWork } from '../UseCase/VerifyProofOfWork/VerifyProofOfWork'

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

      const required =
        config.mode === 'always' ? true : await this.adaptiveRequirementReached(email, config.adaptiveThreshold)
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

    const challengeResult = await this.requestChallenge.execute({
      scope,
      difficulty: config.difficulty,
      ttlSeconds: config.ttlSeconds,
    })

    return {
      satisfied: false,
      challenge: challengeResult.getValue(),
    }
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
