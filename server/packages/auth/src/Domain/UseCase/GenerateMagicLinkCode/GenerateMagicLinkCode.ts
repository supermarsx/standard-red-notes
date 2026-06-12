import * as crypto from 'crypto'
import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { v4 as uuidv4 } from 'uuid'
import { Logger } from 'winston'

import { MagicLinkToken } from '../../MagicLink/MagicLinkToken'
import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { GenerateMagicLinkCodeDto } from './GenerateMagicLinkCodeDto'

export class GenerateMagicLinkCode implements UseCaseInterface<{ code: string; emailed: boolean }> {
  private static readonly CODE_LENGTH = 6
  private static readonly EXPIRATION_MINUTES = 15

  constructor(
    private magicLinkTokenRepository: MagicLinkTokenRepositoryInterface,
    private emailSender: EmailSenderInterface,
    private logger: Logger,
  ) {}

  async execute(dto: GenerateMagicLinkCodeDto): Promise<Result<{ code: string; emailed: boolean }>> {
    if (!dto.userIdentifier) {
      return Result.fail('Could not generate magic link code: missing user identifier.')
    }

    try {
      const code = this.generateNumericCode()
      const now = new Date()
      const expiresAt = new Date(now.getTime() + GenerateMagicLinkCode.EXPIRATION_MINUTES * 60 * 1000)

      const magicLinkToken = MagicLinkToken.create(
        {
          userIdentifier: dto.userIdentifier,
          code,
          expiresAt,
          consumed: false,
          createdAt: now,
        },
        new UniqueEntityId(uuidv4()),
      ).getValue()

      await this.magicLinkTokenRepository.save(magicLinkToken)

      let emailed = false
      if (this.emailSender.isConfigured()) {
        emailed = await this.emailSender.sendEmail(
          dto.userIdentifier,
          'Your sign-in verification code',
          `Your one-time verification code is: ${code}\n\nThis code expires in ${GenerateMagicLinkCode.EXPIRATION_MINUTES} minutes.`,
        )
      }

      return Result.ok({ code, emailed })
    } catch (error) {
      this.logger.error(`Failed to generate magic link code: ${(error as Error).message}`)

      return Result.fail('Could not generate magic link code.')
    }
  }

  private generateNumericCode(): string {
    const max = 10 ** GenerateMagicLinkCode.CODE_LENGTH
    const randomNumber = crypto.randomInt(0, max)

    return randomNumber.toString().padStart(GenerateMagicLinkCode.CODE_LENGTH, '0')
  }
}
