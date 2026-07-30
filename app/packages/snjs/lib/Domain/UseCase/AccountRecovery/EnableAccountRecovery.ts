import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { EncryptionProviderInterface, SessionsClientInterface } from '@standardnotes/services'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'
import {
  ACCOUNT_RECOVERY_VERSION,
  RECOVERY_ARGON_ITERATIONS,
  RECOVERY_ARGON_MEMORY_BYTES,
  RECOVERY_ARGON_OUTPUT_BYTES,
  RECOVERY_CODE_ENTROPY_BITS,
  RECOVERY_KDF_SALT_BITS,
  RECOVERY_NONCE_BITS,
  accountRecoveryAssociatedData,
  createRecoveryCode,
  serializeAccountRecoverySecret,
} from './AccountRecoveryEscrowTypes'

/**
 * Explicitly enrolls the signed-in account in ciphertext-only recovery.
 * The server receives only the versioned envelope; the returned one-time code
 * contains the sole wrapping secret.
 */
export class EnableAccountRecovery implements UseCaseInterface<string> {
  constructor(
    private encryption: EncryptionProviderInterface,
    private settingsClient: SettingsClientInterface,
    private crypto: PureCryptoInterface,
    private sessions: SessionsClientInterface,
  ) {}

  async execute(dto: { password: string }): Promise<Result<string>> {
    if (!dto.password) {
      return Result.fail('Your current account password is required.')
    }

    try {
      const validation = await this.encryption.validateAccountPassword(dto.password)
      if (!validation.valid || !('artifacts' in validation)) {
        return Result.fail('The account password is incorrect.')
      }

      const userUuid = this.sessions.getSureUser().uuid
      const plaintext = serializeAccountRecoverySecret(validation.artifacts.rootKey)
      if (!plaintext) {
        return Result.fail('The active account keys cannot be safely escrowed.')
      }

      const recoverySecret = this.crypto.generateRandomKey(RECOVERY_CODE_ENTROPY_BITS)
      const salt = this.crypto.generateRandomKey(RECOVERY_KDF_SALT_BITS)
      const nonce = this.crypto.generateRandomKey(RECOVERY_NONCE_BITS)
      const wrappingKey = this.crypto.argon2(
        recoverySecret,
        salt,
        RECOVERY_ARGON_ITERATIONS,
        RECOVERY_ARGON_MEMORY_BYTES,
        RECOVERY_ARGON_OUTPUT_BYTES,
      )
      const ciphertext = this.crypto.xchacha20Encrypt(
        plaintext,
        nonce,
        wrappingKey,
        accountRecoveryAssociatedData(userUuid),
      )
      const escrow = JSON.stringify({
        version: ACCOUNT_RECOVERY_VERSION,
        userUuid,
        salt,
        nonce,
        ciphertext,
      })

      await this.settingsClient.updateAccountRecoveryEscrow(escrow)

      return Result.ok(createRecoveryCode(userUuid, recoverySecret))
    } catch {
      return Result.fail('Account recovery could not be enabled.')
    }
  }
}
