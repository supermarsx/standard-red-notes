import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'

import { VerifyMagicLinkCodeDto } from './VerifyMagicLinkCodeDto'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

/**
 * Standard Red Notes: the one message an exhausted code answers with.
 *
 * Deliberately distinct from "incorrect" and from "already been used": the owner
 * has to be told that retrying is pointless and that the fix is a new code, or
 * they will keep typing the right digits into a dead token. It discloses nothing
 * an attacker does not already know — they are the one who spent the attempts.
 */
const EXHAUSTED_MESSAGE =
  'Too many incorrect attempts have been made against this verification code. Please request a new one.'

export class VerifyMagicLinkCode implements UseCaseInterface<boolean> {
  constructor(
    private magicLinkTokenRepository: MagicLinkTokenRepositoryInterface,
    private logger: Logger,
  ) {}

  async execute(dto: VerifyMagicLinkCodeDto): Promise<Result<boolean>> {
    if (!dto.userIdentifier || !dto.code) {
      return Result.fail('Could not verify magic link code: missing parameters.')
    }

    try {
      const token = await this.magicLinkTokenRepository.findByUserIdentifierAndCode(dto.userIdentifier, dto.code)

      if (token === null) {
        const latestToken = await this.magicLinkTokenRepository.findLatestByUserIdentifier(dto.userIdentifier)
        if (latestToken === null) {
          return Result.fail('No magic link code was issued for this account.')
        }

        if (latestToken.props.consumed) {
          return Result.fail('This magic link code has already been used.')
        }

        if (latestToken.isExpired(new Date())) {
          return Result.fail('This magic link code has expired.')
        }

        /**
         * Standard Red Notes: CHARGE THE WRONG GUESS TO THE CODE.
         *
         * This is the only path a brute-force guess can take — a code the guesser
         * does not have resolves to no token, so every guess lands here — and it
         * is where the cap is spent. The cost falls on the OUTSTANDING CODE, not
         * on the account: five wrong guesses kill one six-digit code and leave
         * every other thing about the account exactly as it was.
         *
         * The already-dead cases above return first, on purpose. A consumed or
         * expired token has nothing left to protect, and charging it would let an
         * attacker drive an unbounded stream of writes against a row that is not
         * even a credential any more.
         *
         * An exhausted token is checked BEFORE the increment so the counter stops
         * at the cap rather than climbing for as long as someone keeps guessing;
         * the stored number is then exactly "the allowance, spent", and an
         * exhausted code costs the server one read and no write.
         */
        if (latestToken.hasExhaustedAttempts()) {
          return Result.fail(EXHAUSTED_MESSAGE)
        }

        latestToken.registerFailedAttempt()
        await this.magicLinkTokenRepository.save(latestToken)

        if (latestToken.hasExhaustedAttempts()) {
          this.logger.debug('A magic-link code was invalidated after exhausting its attempt allowance.')

          return Result.fail(EXHAUSTED_MESSAGE)
        }

        return Result.fail('The magic link code you entered is incorrect.')
      }

      if (token.props.consumed) {
        return Result.fail('This magic link code has already been used.')
      }

      if (token.isExpired(new Date())) {
        return Result.fail('This magic link code has expired.')
      }

      /**
       * Standard Red Notes: AN EXHAUSTED CODE IS REFUSED EVEN WHEN IT IS RIGHT.
       *
       * Without this the cap would be theatre. A guesser who burns the allowance
       * and then hits the code on the next try — or, far more realistically, one
       * who learns the code some other way after the allowance is gone — would
       * still be let in, and the "invalidated" token would never actually have
       * been invalidated. Exhaustion is a terminal state for the token, exactly
       * like consumption and expiry above; the owner recovers by requesting a new
       * code, which starts a new token with a fresh allowance.
       */
      if (token.hasExhaustedAttempts()) {
        return Result.fail(EXHAUSTED_MESSAGE)
      }

      token.props.consumed = true
      await this.magicLinkTokenRepository.save(token)

      return Result.ok(true)
    } catch (error) {
      this.logger.error('Failed to verify a magic-link code.', safeErrorLogMetadata(error))

      return Result.fail('Could not verify magic link code.')
    }
  }
}
