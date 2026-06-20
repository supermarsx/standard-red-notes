import { EmailBackupFrequency } from '@standardnotes/settings'
import { SettingsList } from './SettingsList'
import { SettingName } from '@standardnotes/domain-core'

export interface SettingsClientInterface {
  listSettings(): Promise<SettingsList>

  getSetting(name: SettingName, serverPassword?: string): Promise<string | undefined>

  getDoesSensitiveSettingExist(name: SettingName): Promise<boolean>

  updateSetting(name: SettingName, payload: string, sensitive?: boolean, totpToken?: string): Promise<void>

  deleteSetting(name: SettingName, serverPassword?: string): Promise<void>

  generateMfaSecret(): Promise<string>

  updateMfaSetting(secret: string, totpToken: string): Promise<void>

  getEmailBackupFrequencyOptionLabel(frequency: EmailBackupFrequency): string

  /**
   * Standard Red Notes: account-recovery escrow accessors. The escrow setting
   * name (`ACCOUNT_RECOVERY_ESCROW`) is validated server-side but may not be
   * present in the client's published `@standardnotes/domain-core` SettingName
   * enum, so these methods address it by raw name and bypass the typed
   * SettingName value object. They transport only an opaque client-side
   * ciphertext blob; see AccountRecoveryEscrow use cases for the format.
   */
  getAccountRecoveryEscrow(): Promise<string | undefined>

  updateAccountRecoveryEscrow(escrowPayload: string): Promise<void>

  deleteAccountRecoveryEscrow(): Promise<void>
}
