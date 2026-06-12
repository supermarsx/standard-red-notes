import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'

import { VerifyMagicLinkCodeDto } from './VerifyMagicLinkCodeDto'

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
      const token = await this.magicLinkTokenRepository.findLatestByUserIdentifier(dto.userIdentifier)

      if (token === null) {
        return Result.fail('No magic link code was issued for this account.')
      }

      if (token.props.consumed) {
        return Result.fail('This magic link code has already been used.')
      }

      if (token.isExpired(new Date())) {
        return Result.fail('This magic link code has expired.')
      }

      if (token.props.code !== dto.code) {
        return Result.fail('The magic link code you entered is incorrect.')
      }

      token.props.consumed = true
      await this.magicLinkTokenRepository.save(token)

      return Result.ok(true)
    } catch (error) {
      this.logger.error(`Failed to verify magic link code: ${(error as Error).message}`)

      return Result.fail('Could not verify magic link code.')
    }
  }
}
