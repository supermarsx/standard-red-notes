import * as crypto from 'crypto'
import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { v4 as uuidv4 } from 'uuid'
import { Logger } from 'winston'

import { MagicLinkToken } from '../../MagicLink/MagicLinkToken'
import { MagicLinkTokenRepositoryInterface } from '../../MagicLink/MagicLinkTokenRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { createEmailDeliveryId } from '../../Email/EmailDeliveryId'

import { GenerateMagicLinkCodeDto } from './GenerateMagicLinkCodeDto'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

export class GenerateMagicLinkCode implements UseCaseInterface<{ emailed: true }> {
  private static readonly CODE_LENGTH = 6
  private static readonly EXPIRATION_MINUTES = 15

  constructor(
    private magicLinkTokenRepository: MagicLinkTokenRepositoryInterface,
    private emailSender: EmailSenderInterface,
    private logger: Logger,
  ) {}

  async isDeliveryConfigured(): Promise<boolean> {
    return this.emailSender.isConfigured()
  }

  async execute(dto: GenerateMagicLinkCodeDto): Promise<Result<{ emailed: true }>> {
    if (!dto.userIdentifier) {
      return Result.fail('Could not generate magic link code: missing user identifier.')
    }

    try {
      if (!(await this.isDeliveryConfigured())) {
        return Result.fail('Email delivery is not configured. Magic-link sign-in is unavailable.')
      }

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

      const emailed = await this.emailSender.sendEmail(
        dto.userIdentifier,
        'Your sign-in verification code',
        `Your one-time verification code is: ${code}\n\nThis code expires in ${GenerateMagicLinkCode.EXPIRATION_MINUTES} minutes.`,
        {
          deliverySource: 'account',
          deliveryId: createEmailDeliveryId('magic-link', magicLinkToken.id.toString()),
          expiresAt: expiresAt.getTime(),
          supersessionKey: createEmailDeliveryId('magic-link-user', dto.userIdentifier),
        },
      )
      if (!emailed) {
        return Result.fail('Could not deliver the magic-link verification code. Please try again.')
      }

      return Result.ok({ emailed: true })
    } catch (error) {
      this.logger.error('Failed to generate a magic-link code.', safeErrorLogMetadata(error))

      return Result.fail('Could not generate magic link code.')
    }
  }

  private generateNumericCode(): string {
    const max = 10 ** GenerateMagicLinkCode.CODE_LENGTH
    const randomNumber = crypto.randomInt(0, max)

    return randomNumber.toString().padStart(GenerateMagicLinkCode.CODE_LENGTH, '0')
  }
}
