import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { EncryptionProviderInterface } from '@standardnotes/services'
import { SNRootKeyParams } from '@standardnotes/encryption'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'
import {
  AccountRecoveryEscrowPayload,
  AccountRecoveryEscrowSecret,
  RECOVERY_CODE_ENTROPY_BITS,
} from './AccountRecoveryEscrowTypes'

/**
 * Standard Red Notes: enable the OPTIONAL, OFF-BY-DEFAULT account recovery escrow.
 *
 * Generates a high-entropy recovery code, derives a wrapping key from it, encrypts
 * the account master key (+ key params) under that wrapping key, and escrows ONLY
 * the resulting ciphertext on the server. The recovery code is returned to the
 * caller to be shown to the user ONCE; it is never sent to the server.
 *
 * Requires the user's current account password (to compute the root key locally).
 * Returns the recovery code on success.
 */
export class EnableAccountRecovery implements UseCaseInterface<string> {
  // argon2 parameters for deriving the wrapping key from the recovery code.
  // Mirrors the account KDF work factor so the escrow is as hard to brute force
  // as the account password derivation itself.
  private readonly ARGON_ITERATIONS = 5
  private readonly ARGON_MEM_LIMIT = 67108864
  private readonly ARGON_OUTPUT_KEY_BYTES = 32 // 256-bit XChaCha20 key
  private readonly SALT_BITS = 128
  private readonly NONCE_BITS = 192

  constructor(
    private encryption: EncryptionProviderInterface,
    private settingsClient: SettingsClientInterface,
    private crypto: PureCryptoInterface,
  ) {}

  async execute(dto: { password: string }): Promise<Result<string>> {
    if (!dto.password) {
      return Result.fail('Account password is required to enable account recovery.')
    }

    const keyParams = this.encryption.getRootKeyParams() as SNRootKeyParams | undefined
    if (!keyParams) {
      return Result.fail('Cannot enable account recovery: no account key params available.')
    }

    const rootKey = await this.encryption.computeRootKey(dto.password, keyParams)
    if (!rootKey || !rootKey.masterKey) {
      return Result.fail('Could not derive your account key. Is the password correct?')
    }

    // High-entropy recovery code. Shown to the user once; never sent to server.
    const recoveryCode = this.crypto.generateRandomKey(RECOVERY_CODE_ENTROPY_BITS)

    const salt = this.crypto.generateRandomKey(this.SALT_BITS)
    const nonce = this.crypto.generateRandomKey(this.NONCE_BITS)

    const wrappingKey = this.crypto.argon2(
      recoveryCode,
      salt,
      this.ARGON_ITERATIONS,
      this.ARGON_MEM_LIMIT,
      this.ARGON_OUTPUT_KEY_BYTES,
    )

    const secret: AccountRecoveryEscrowSecret = {
      masterKey: rootKey.masterKey,
      keyParams: keyParams.getPortableValue() as unknown as Record<string, unknown>,
    }

    const ciphertext = this.crypto.xchacha20Encrypt(JSON.stringify(secret), nonce, wrappingKey)

    const escrow: AccountRecoveryEscrowPayload = {
      version: 1,
      identifier: keyParams.identifier,
      salt,
      nonce,
      ciphertext,
    }

    try {
      await this.settingsClient.updateAccountRecoveryEscrow(JSON.stringify(escrow))
    } catch (error) {
      return Result.fail(`Could not store recovery escrow on the server: ${(error as Error).message}`)
    }

    return Result.ok(recoveryCode)
  }
}
