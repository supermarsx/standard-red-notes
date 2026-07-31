import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { CryptoNode } from '@standardnotes/sncrypto-node'
import { inject, injectable } from 'inversify'
import { Logger } from 'winston'

import { MfaSecretRepositoryInterface } from '../../Mfa/MfaSecretRepositoryInterface'
import TYPES from '../../../Bootstrap/Types'
import { ValidateMfaTokenDTO } from './ValidateMfaTokenDTO'
import {
  SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE,
  SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE,
  supportsTotpStepUp,
} from '../../Auth/SecurityStepUp'
import { safeErrorLogMetadata } from '../../Logging/SafeLog'

@injectable()
export class ValidateMfaToken implements UseCaseInterface<void> {
  constructor(
    @inject(TYPES.Auth_CryptoNode) private cryptoNode: CryptoNode,
    @inject(TYPES.Auth_MfaSecretRepository) private mfaSecretRepository: MfaSecretRepositoryInterface,
    @inject(TYPES.Auth_Logger) private logger: Logger,
  ) {}

  async execute(dto: ValidateMfaTokenDTO): Promise<Result<void>> {
    const { userUuid, totpToken, authTokenVersion } = dto
    try {
      if (!supportsTotpStepUp(authTokenVersion)) {
        return Result.fail(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE)
      }

      if (!totpToken) {
        return Result.fail('No TOTP token provided.')
      }

      const cachedSecret = await this.mfaSecretRepository.getMfaSecret(userUuid)

      if (!cachedSecret) {
        return Result.fail('No MFA secret found. Please generate a new secret first.')
      }

      const expectedToken = await this.cryptoNode.totpToken(cachedSecret, Date.now(), 6, 30)

      if (totpToken !== expectedToken) {
        return Result.fail('Invalid TOTP token.')
      }

      await this.mfaSecretRepository.deleteMfaSecret(userUuid)

      return Result.ok()
    } catch (error) {
      try {
        this.logger.warn('Failed to validate MFA token.', {
          userId: userUuid,
          ...safeErrorLogMetadata(error),
        })
      } catch {
        // Logging is best-effort; proof validation must still fail closed with
        // the same public response if the configured transport is unavailable.
      }

      return Result.fail(SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE)
    }
  }
}
