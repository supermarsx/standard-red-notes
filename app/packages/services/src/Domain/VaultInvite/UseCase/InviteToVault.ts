import { SharedVaultInviteServerHash } from '@standardnotes/responses'
import {
  TrustedContactInterface,
  SharedVaultListingInterface,
  AsymmetricMessagePayloadType,
  VaultInviteDelegatedContact,
} from '@standardnotes/models'
import { SendVaultInvite } from './SendVaultInvite'
import { PkcKeyPair } from '@standardnotes/sncrypto-common'
import { EncryptMessage } from '../../Encryption/UseCase/Asymmetric/EncryptMessage'
import { Result, SharedVaultUserPermission, UseCaseInterface } from '@standardnotes/domain-core'
import { ShareContactWithVault } from '../../SharedVaults/UseCase/ShareContactWithVault'
import { KeySystemKeyManagerInterface } from '../../KeySystem/KeySystemKeyManagerInterface'
import { GetKeyPairs } from '../../Encryption/UseCase/GetKeyPairs'
import { SelfContactManager } from '../../Contacts/SelfContactManager'

/**
 * Every precondition below used to collapse into one of three interchangeable strings ("keys not
 * found", "key system root key not found", "me contact not found") that named an internal object
 * and told the user nothing about which step failed or what to do next. The modal surfaces these
 * verbatim, so each one now names the missing precondition AND the action that fixes it.
 *
 * These strings are read by a human and may be pasted into a bug report, so they deliberately carry
 * no key material, no contact uuid and no vault identifier.
 */
export const InviteFailure = {
  NoAccountKeyPair:
    'Your account does not have collaboration keys yet, so this invite cannot be encrypted. Open Preferences → Vaults and enable collaboration for this account, then try again.',
  NoKeySystemRootKey:
    "This vault's key is not available on this device, so there is nothing to share with the invitee. Unlock the vault in Preferences → Vaults and try again.",
  NoSelfContact:
    'Your own contact record could not be created, so the invitee would have no way to verify who invited them. Make sure you are signed in and that syncing has completed, then try again.',
} as const

export class InviteToVault implements UseCaseInterface<SharedVaultInviteServerHash> {
  constructor(
    private keyManager: KeySystemKeyManagerInterface,
    private _encryptMessage: EncryptMessage,
    private _sendInvite: SendVaultInvite,
    private _shareContact: ShareContactWithVault,
    private _getKeyPairs: GetKeyPairs,
    private selfContactManager: SelfContactManager,
  ) {}

  async execute(params: {
    sharedVault: SharedVaultListingInterface
    sharedVaultContacts: TrustedContactInterface[]
    recipient: TrustedContactInterface
    permission: string
  }): Promise<Result<SharedVaultInviteServerHash>> {
    const keys = this._getKeyPairs.execute()
    if (keys.isFailed()) {
      return Result.fail(InviteFailure.NoAccountKeyPair)
    }

    const createInviteResult = await this.inviteContact({
      keys: keys.getValue(),
      sharedVault: params.sharedVault,
      sharedVaultContacts: params.sharedVaultContacts,
      recipient: params.recipient,
      permission: params.permission,
    })

    if (createInviteResult.isFailed()) {
      return createInviteResult
    }

    await this.shareContactWithOtherVaultMembers({
      contact: params.recipient,
      keys: keys.getValue(),
      sharedVault: params.sharedVault,
    })

    return createInviteResult
  }

  private async shareContactWithOtherVaultMembers(params: {
    contact: TrustedContactInterface
    keys: {
      encryption: PkcKeyPair
      signing: PkcKeyPair
    }
    sharedVault: SharedVaultListingInterface
  }): Promise<Result<void>> {
    const result = await this._shareContact.execute({
      sharedVault: params.sharedVault,
      contactToShare: params.contact,
    })

    return result
  }

  private async inviteContact(params: {
    keys: {
      encryption: PkcKeyPair
      signing: PkcKeyPair
    }
    sharedVault: SharedVaultListingInterface
    sharedVaultContacts: TrustedContactInterface[]
    recipient: TrustedContactInterface
    permission: string
  }): Promise<Result<SharedVaultInviteServerHash>> {
    const permissionOrError = SharedVaultUserPermission.create(params.permission)
    if (permissionOrError.isFailed()) {
      return Result.fail(permissionOrError.getError())
    }
    const permission = permissionOrError.getValue()

    const keySystemRootKey = this.keyManager.getPrimaryKeySystemRootKey(params.sharedVault.systemIdentifier)
    if (!keySystemRootKey) {
      return Result.fail(InviteFailure.NoKeySystemRootKey)
    }

    // Resolved from the account's own self-contact rather than searched for in `sharedVaultContacts`.
    // That list is built by resolving each SERVER-reported vault user back to a local TrustedContact
    // (GetVaultContacts), so the owner's own entry silently disappeared from it whenever the account
    // had no self-contact — the exact failure that made every invite impossible for shipped builds.
    // Identity is not something to look up in a server-provided list.
    const meContact = await this.selfContactManager.getOrCreateSelfContact()
    if (!meContact) {
      return Result.fail(InviteFailure.NoSelfContact)
    }

    const meContactContent: VaultInviteDelegatedContact = {
      name: undefined,
      contactUuid: meContact.contactUuid,
      publicKeySet: meContact.publicKeySet,
    }

    const delegatedContacts: VaultInviteDelegatedContact[] = params.sharedVaultContacts
      .filter((contact) => !contact.isMe && contact.contactUuid !== params.recipient.contactUuid)
      .map((contact) => {
        return {
          name: contact.name,
          contactUuid: contact.contactUuid,
          publicKeySet: contact.publicKeySet,
        }
      })

    const encryptedMessage = this._encryptMessage.execute({
      message: {
        type: AsymmetricMessagePayloadType.SharedVaultInvite,
        data: {
          recipientUuid: params.recipient.contactUuid,
          rootKey: keySystemRootKey.content,
          trustedContacts: [meContactContent, ...delegatedContacts],
          metadata: {
            name: params.sharedVault.name,
            description: params.sharedVault.description,
            iconString: params.sharedVault.iconString,
            fileBytesUsed: params.sharedVault.sharing.fileBytesUsed,
            designatedSurvivor: params.sharedVault.sharing.designatedSurvivor,
          },
        },
      },
      keys: params.keys,
      recipientPublicKey: params.recipient.publicKeySet.encryption,
    })

    if (encryptedMessage.isFailed()) {
      return Result.fail(encryptedMessage.getError())
    }

    const createInviteResult = await this._sendInvite.execute({
      sharedVaultUuid: params.sharedVault.sharing.sharedVaultUuid,
      recipientUuid: params.recipient.contactUuid,
      encryptedMessage: encryptedMessage.getValue(),
      permission: permission.value,
    })

    return createInviteResult
  }
}
