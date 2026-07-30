import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { EncryptionProviderInterface } from '@standardnotes/services'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'

/**
 * Standard Red Notes: disable account recovery and delete the escrowed material.
 *
 * Opt-out is reversible at any time: deleting the escrow removes the only
 * server-side copy of the (ciphertext) recovery material, restoring the pure
 * end-to-end guarantee for this account going forward.
 */
export class DisableAccountRecovery implements UseCaseInterface<void> {
  constructor(
    private settingsClient: SettingsClientInterface,
    private encryption: EncryptionProviderInterface,
  ) {}

  async execute(dto: { password: string }): Promise<Result<void>> {
    if (!dto.password) {
      return Result.fail('Your current account password is required.')
    }

    try {
      const validation = await this.encryption.validateAccountPassword(dto.password)
      if (!validation.valid) {
        return Result.fail('The account password is incorrect.')
      }
      await this.settingsClient.deleteAccountRecoveryEscrow()
    } catch {
      return Result.fail('Account recovery could not be disabled.')
    }

    return Result.ok()
  }
}
