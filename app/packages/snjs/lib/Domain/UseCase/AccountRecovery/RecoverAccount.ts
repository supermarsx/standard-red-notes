import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'

import {
  AccountRecoveryEscrowPayload,
  AccountRecoveryEscrowSecret,
} from './AccountRecoveryEscrowTypes'

export interface RecoverAccountResult {
  /** The recovered account master key (encrypts the user's items keys). */
  masterKey: string
  /** The key params captured at escrow time. */
  keyParams: Record<string, unknown>
}

/**
 * Standard Red Notes: recover access using the escrow + the user-held recovery code.
 *
 * COMPLETE (and unit-tested): `decryptEscrow` takes the escrow blob (fetched from
 * the server) and the recovery code (held by the user) and returns the recovered
 * master key + key params. This is the security-critical core: without the
 * recovery code the escrow cannot be decrypted, proving the server alone cannot
 * read it.
 *
 * SCAFFOLDED (intentionally not wired here): turning the recovered master key into
 * a fully usable signed-in session with a NEW password. That step requires either
 * an unauthenticated server "recover" endpoint or an authenticated
 * change-credentials call, both of which live in the session/auth layer that is
 * owned by other work in this fork. The documented procedure is:
 *   1. Fetch the escrow blob for the account (unauthenticated lookup by identifier,
 *      or via a temporary recovery session) and call `decryptEscrow` with the code.
 *   2. Reconstruct an SNRootKey from { masterKey, keyParams } (see
 *      SignInWithRecoveryCodes for the CopyPayloadWithContentOverride pattern) to
 *      regain decryption of the user's items keys / data.
 *   3. Immediately rotate credentials to a NEW password via
 *      UserService.changeCredentials, which re-wraps items keys under the new root
 *      key and updates the server password.
 * The hook `execute` below performs step 1's decryption and returns the material
 * for steps 2-3; it does NOT itself mutate session or server state.
 */
export class RecoverAccount implements UseCaseInterface<RecoverAccountResult> {
  private readonly ARGON_ITERATIONS = 5
  private readonly ARGON_MEM_LIMIT = 67108864
  private readonly ARGON_OUTPUT_KEY_BYTES = 32

  constructor(private crypto: PureCryptoInterface) {}

  async execute(dto: { escrow: string; recoveryCode: string }): Promise<Result<RecoverAccountResult>> {
    return this.decryptEscrow(dto.escrow, dto.recoveryCode)
  }

  /**
   * Decrypt the escrow blob with the recovery code. Returns the recovered master
   * key + key params, or a failure if the code is wrong / the blob is malformed.
   */
  decryptEscrow(escrowJson: string, recoveryCode: string): Result<RecoverAccountResult> {
    if (!recoveryCode) {
      return Result.fail('A recovery code is required to recover this account.')
    }

    let escrow: AccountRecoveryEscrowPayload
    try {
      escrow = JSON.parse(escrowJson) as AccountRecoveryEscrowPayload
    } catch (_error) {
      return Result.fail('Recovery escrow is malformed and could not be parsed.')
    }

    if (escrow.version !== 1 || !escrow.salt || !escrow.nonce || !escrow.ciphertext) {
      return Result.fail('Recovery escrow is missing required fields or is an unsupported version.')
    }

    const wrappingKey = this.crypto.argon2(
      recoveryCode,
      escrow.salt,
      this.ARGON_ITERATIONS,
      this.ARGON_MEM_LIMIT,
      this.ARGON_OUTPUT_KEY_BYTES,
    )

    const decrypted = this.crypto.xchacha20Decrypt(escrow.ciphertext, escrow.nonce, wrappingKey)
    if (decrypted === null) {
      return Result.fail('Could not decrypt the recovery escrow. The recovery code is incorrect.')
    }

    let secret: AccountRecoveryEscrowSecret
    try {
      secret = JSON.parse(decrypted) as AccountRecoveryEscrowSecret
    } catch (_error) {
      return Result.fail('Recovered escrow contents are malformed.')
    }

    if (!secret.masterKey) {
      return Result.fail('Recovered escrow did not contain a master key.')
    }

    return Result.ok({
      masterKey: secret.masterKey,
      keyParams: secret.keyParams,
    })
  }
}
