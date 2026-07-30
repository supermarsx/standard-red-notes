import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'
import { AccountRecoveryStatus, parseAccountRecoveryEnvelope } from './AccountRecoveryEscrowTypes'

export class GetAccountRecoveryStatus implements UseCaseInterface<AccountRecoveryStatus> {
  constructor(private settingsClient: SettingsClientInterface) {}

  async execute(): Promise<Result<AccountRecoveryStatus>> {
    try {
      const escrow = await this.settingsClient.getAccountRecoveryEscrow()
      if (!escrow) {
        return Result.ok('disabled')
      }

      return Result.ok(parseAccountRecoveryEnvelope(escrow) ? 'enabled' : 'legacy')
    } catch (error) {
      return Result.fail(`Could not read recovery status: ${(error as Error).message}`)
    }
  }
}
