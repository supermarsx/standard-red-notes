import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'

/**
 * Standard Red Notes: disable account recovery and delete the escrowed material.
 *
 * Opt-out is reversible at any time: deleting the escrow removes the only
 * server-side copy of the (ciphertext) recovery material, restoring the pure
 * end-to-end guarantee for this account going forward.
 */
export class DisableAccountRecovery implements UseCaseInterface<void> {
  constructor(private settingsClient: SettingsClientInterface) {}

  async execute(): Promise<Result<void>> {
    try {
      await this.settingsClient.deleteAccountRecoveryEscrow()
    } catch (error) {
      return Result.fail(`Could not delete recovery escrow from the server: ${(error as Error).message}`)
    }

    return Result.ok()
  }
}
