import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import { SyncServiceInterface } from '../../Sync/SyncServiceInterface'
import {
  KeySystemRootKeyInterface,
  AsymmetricMessageSharedVaultRootKeyChanged,
  FillItemContent,
  KeySystemRootKeyContent,
  VaultListingMutator,
  VaultListingInterface,
  SharedVaultListingInterface,
} from '@standardnotes/models'

import { ContentType } from '@standardnotes/domain-core'
import { GetVault } from '../../Vault/UseCase/GetVault'
import { DecryptErroredPayloads } from '../../Encryption/UseCase/DecryptErroredPayloads'

export const RootKeyChangedRejection = {
  /** The key system named by the message belongs to a vault that is not shared at all. */
  NotASharedVault: 'not-a-shared-vault',
  /** The sender is not the owner of the shared vault that owns this key system. */
  SenderIsNotVaultOwner: 'sender-is-not-vault-owner',
} as const

export type RootKeyChangedRejectionReason = (typeof RootKeyChangedRejection)[keyof typeof RootKeyChangedRejection]

export type HandleRootKeyChangedMessageResult =
  { applied: true } | { applied: false; reason: RootKeyChangedRejectionReason }

export class HandleRootKeyChangedMessage {
  constructor(
    private mutator: MutatorClientInterface,
    private sync: SyncServiceInterface,
    private _getVault: GetVault,
    private _decryptErroredPayloads: DecryptErroredPayloads,
  ) {}

  /**
   * Applies a `SharedVaultRootKeyChanged` message: the vault owner rotated the key system root key
   * and is handing the new one to each member.
   *
   * AUTHORIZATION. Being able to decrypt and signature-verify this message proves only that it came
   * from somebody whose keys we hold as a TrustedContact — it does NOT prove they have anything to
   * do with the vault the message names. `SendMessageToUser` on the server accepts a message for any
   * recipient uuid with no relationship check at all, and a contact record is created for every
   * co-member of every vault we join (`ProcessAcceptedVaultInvite`), so "a trusted contact" is a far
   * wider set than "the owner of this vault".
   *
   * Without the check below, any such contact could hand us a `KeySystemRootKey` they generated for
   * the system identifier of a vault we already hold. `getPrimaryKeySystemRootKey` resolves the
   * primary key by newest `keyParams.creationTimestamp` — a value carried in the message — so the
   * injected key would become the primary one, and everything the vault encrypted afterwards would
   * be encrypted under a key the sender knows. Pointing the message at a PRIVATE vault's key system
   * is the same attack with no shared vault involved at all, which is why a non-shared listing is
   * rejected outright rather than merely failing the owner comparison.
   *
   * Only the vault owner legitimately sends this (`RotateVaultKey.shareNewKeyWithMembers` returns
   * early for non-owners), so owner-or-nothing is the exact rule, enforced against the locally held
   * `VaultListing` rather than anything in the message.
   *
   * When the key system is NOT locally known this stays permissive and inserts the key, which is
   * deliberately unchanged behaviour: asymmetric messages are processed BEFORE the retrieved
   * payloads of the same sync response are emitted (`SyncService.handleSuccessServerResponse`), so a
   * legitimate rotation can genuinely arrive one step ahead of the `VaultListing` it belongs to, and
   * the caller deletes the message once this returns. An orphan root key cannot be reached by any
   * vault operation until a listing for its system identifier exists.
   */
  async execute(
    message: AsymmetricMessageSharedVaultRootKeyChanged,
    senderUuid: string,
  ): Promise<HandleRootKeyChangedMessageResult> {
    const rootKeyContent = message.data.rootKey

    const vault = this._getVault.execute<VaultListingInterface>({
      keySystemIdentifier: rootKeyContent.systemIdentifier,
    })

    const knownVault = vault.isFailed() ? undefined : vault.getValue()

    let sharedListing: SharedVaultListingInterface | undefined
    if (knownVault?.isSharedVaultListing()) {
      sharedListing = knownVault
    }

    if (knownVault !== undefined && sharedListing === undefined) {
      return { applied: false, reason: RootKeyChangedRejection.NotASharedVault }
    }

    if (sharedListing !== undefined && sharedListing.sharing.ownerUserUuid !== senderUuid) {
      return { applied: false, reason: RootKeyChangedRejection.SenderIsNotVaultOwner }
    }

    await this.mutator.createItem<KeySystemRootKeyInterface>(
      ContentType.TYPES.KeySystemRootKey,
      FillItemContent<KeySystemRootKeyContent>(rootKeyContent),
      true,
    )

    if (knownVault) {
      await this.mutator.changeItem<VaultListingMutator>(knownVault, (mutator) => {
        mutator.rootKeyParams = rootKeyContent.keyParams
      })
    }

    await this._decryptErroredPayloads.execute()

    void this.sync.sync({ sourceDescription: 'Not awaiting due to this event handler running from sync response' })

    return { applied: true }
  }
}
