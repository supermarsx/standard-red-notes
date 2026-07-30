import { KeySystemRootKeyInterface, VaultListingInterface } from '@standardnotes/models'
import { AbstractService } from '../Service/AbstractService'
import { VaultLockServiceEvent, VaultLockServiceEventPayload } from './VaultLockServiceEvent'

export interface VaultLockServiceInterface extends AbstractService<
  VaultLockServiceEvent,
  VaultLockServiceEventPayload[VaultLockServiceEvent]
> {
  getLockedvaults(): VaultListingInterface[]
  isVaultLocked(vault: VaultListingInterface): boolean
  /**
   * Returns the current client-held root key only for an unlocked shared vault.
   * This narrow boundary lets clients derive non-extractable, domain-separated
   * subkeys without treating public vault identifiers as secrets.
   */
  getUnlockedSharedVaultRootKey(vault: VaultListingInterface): KeySystemRootKeyInterface | undefined
  isVaultLockable(vault: VaultListingInterface): boolean
  lockNonPersistentVault(vault: VaultListingInterface): Promise<void>
  unlockNonPersistentVault(vault: VaultListingInterface, password: string): Promise<boolean>
}
