import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'

import { VerifyMagicLinkCodeDto } from './VerifyMagicLinkCodeDto'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

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

        return Result.fail('The magic link code you entered is incorrect.')
      }

      if (token.props.consumed) {
        return Result.fail('This magic link code has already been used.')
      }

      if (token.isExpired(new Date())) {
        return Result.fail('This magic link code has expired.')
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
