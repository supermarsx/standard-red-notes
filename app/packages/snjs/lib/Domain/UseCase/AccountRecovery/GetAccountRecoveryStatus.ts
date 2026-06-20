import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'

/**
 * Standard Red Notes: report whether account recovery escrow is currently enabled
 * for this account. Returns false when no escrow exists (the default for every
 * account that has not explicitly opted in).
 */
export class GetAccountRecoveryStatus implements UseCaseInterface<boolean> {
  constructor(private settingsClient: SettingsClientInterface) {}

  async execute(): Promise<Result<boolean>> {
    try {
      const escrow = await this.settingsClient.getAccountRecoveryEscrow()
      return Result.ok(escrow !== undefined && escrow !== null && escrow.length > 0)
    } catch (error) {
      return Result.fail(`Could not read recovery status: ${(error as Error).message}`)
    }
  }
}
