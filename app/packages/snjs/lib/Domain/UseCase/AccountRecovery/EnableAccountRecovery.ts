import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { EncryptionProviderInterface } from '@standardnotes/services'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'

/**
 * Account-recovery enrollment is intentionally fail-closed.
 *
 * The repository has cryptographic escrow primitives but no verified logged-out
 * retrieval, restricted recovery session, credential rotation, or sign-in flow.
 * Creating new escrow would weaken the account's normal end-to-end guarantee
 * without providing dependable recovery, so callers cannot enable it.
 */
export class EnableAccountRecovery implements UseCaseInterface<string> {
  constructor(
    _encryption: EncryptionProviderInterface,
    _settingsClient: SettingsClientInterface,
    _crypto: PureCryptoInterface,
  ) {}

  async execute(_dto: { password: string }): Promise<Result<string>> {
    return Result.fail(
      'Account recovery enrollment is unavailable because the end-to-end recovery and credential-rotation flow is incomplete.',
    )
  }
}
