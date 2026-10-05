import { MessageSentToUserEvent } from '@standardnotes/domain-events'
import { AsymmetricMessageServerHash } from '@standardnotes/responses'
import { AsymmetricMessageServer } from '@standardnotes/api'
import {
  AsymmetricMessageSharedVaultRootKeyChanged,
  AsymmetricMessagePayloadType,
  AsymmetricMessageSenderKeypairChanged,
  AsymmetricMessageTrustedContactShare,
  AsymmetricMessagePayload,
  AsymmetricMessageSharedVaultMetadataChanged,
  VaultListingMutator,
  MutationType,
  PayloadEmitSource,
  VaultListingInterface,
} from '@standardnotes/models'
import { Result } from '@standardnotes/domain-core'

import { GetKeyPairs } from './../Encryption/UseCase/GetKeyPairs'
import { SyncServiceInterface } from './../Sync/SyncServiceInterface'
import { SessionsClientInterface } from './../Session/SessionsClientInterface'
import { MutatorClientInterface } from './../Mutator/MutatorClientInterface'
import { SyncEvent, SyncEventReceivedAsymmetricMessagesData } from '../Event/SyncEvent'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { InternalEventHandlerInterface } from '../Internal/InternalEventHandlerInterface'
import { InternalEventInterface } from '../Internal/InternalEventInterface'
import { AbstractService } from '../Service/AbstractService'
import { GetTrustedPayload } from './UseCase/GetTrustedPayload'
import { HandleRootKeyChangedMessage } from './UseCase/HandleRootKeyChangedMessage'
import { GetOutboundMessages } from './UseCase/GetOutboundMessages'
import { GetInboundMessages } from './UseCase/GetInboundMessages'
import { GetVault } from '../Vault/UseCase/GetVault'
import { AsymmetricMessageServiceInterface } from './AsymmetricMessageServiceInterface'
import { GetUntrustedPayload } from './UseCase/GetUntrustedPayload'
import { FindContact } from '../Contacts/UseCase/FindContact'
import { CreateOrEditContact } from '../Contacts/UseCase/CreateOrEditContact'
import { ReplaceContactData } from '../Contacts/UseCase/ReplaceContactData'
import { EncryptionProviderInterface } from '../Encryption/EncryptionProviderInterface'
import { WebSocketsServiceEvent } from '../Api/WebSocketsServiceEvent'
import { GetSharedVaults } from '../SharedVaults/UseCase/GetSharedVaults'
import { GetVaultUsers } from '../VaultUser/UseCase/GetVaultUsers'

export class AsymmetricMessageService
  extends AbstractService
  implements AsymmetricMessageServiceInterface, InternalEventHandlerInterface
{
  private handledMessages = new Set<string>()

  constructor(
    private encryption: EncryptionProviderInterface,
    private mutator: MutatorClientInterface,
    private sessions: SessionsClientInterface,
    private sync: SyncServiceInterface,
    private messageServer: AsymmetricMessageServer,
    private _createOrEditContact: CreateOrEditContact,
    private _findContact: FindContact,
    private _replaceContactData: ReplaceContactData,
    private _getTrustedPayload: GetTrustedPayload,
    private _getVault: GetVault,
    private _handleRootKeyChangedMessage: HandleRootKeyChangedMessage,
    private _getOutboundMessagesUseCase: GetOutboundMessages,
    private _getInboundMessagesUseCase: GetInboundMessages,
    private _getUntrustedPayload: GetUntrustedPayload,
    private _getKeyPairs: GetKeyPairs,
    private _getSharedVaults: GetSharedVaults,
    private _getVaultUsers: GetVaultUsers,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)
  }

  public override deinit(): void {
    super.deinit()
    ;(this.messageServer as unknown) = undefined
    ;(this.encryption as unknown) = undefined
    ;(this.mutator as unknown) = undefined
    ;(this._createOrEditContact as unknown) = undefined
    ;(this._findContact as unknown) = undefined
    ;(this._replaceContactData as unknown) = undefined
    ;(this._getTrustedPayload as unknown) = undefined
    ;(this._getVault as unknown) = undefined
    ;(this._handleRootKeyChangedMessage as unknown) = undefined
    ;(this._getOutboundMessagesUseCase as unknown) = undefined
    ;(this._getInboundMessagesUseCase as unknown) = undefined
    ;(this._getUntrustedPayload as unknown) = undefined
    ;(this._getSharedVaults as unknown) = undefined
    ;(this._getVaultUsers as unknown) = undefined
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case SyncEvent.ReceivedAsymmetricMessages:
        void this.handleRemoteReceivedAsymmetricMessages(event.payload as SyncEventReceivedAsymmetricMessagesData)
        break
      case WebSocketsServiceEvent.MessageSentToUser:
        void this.handleRemoteReceivedAsymmetricMessages([(event as MessageSentToUserEvent).payload.message])
        break
    }
  }

  public async getOutboundMessages(): Promise<Result<AsymmetricMessageServerHash[]>> {
    return this._getOutboundMessagesUseCase.execute()
  }

  public async getInboundMessages(): Promise<Result<AsymmetricMessageServerHash[]>> {
    return this._getInboundMessagesUseCase.execute()
  }

  public async downloadAndProcessInboundMessages(): Promise<void> {
    const messages = await this.getInboundMessages()
    if (messages.isFailed()) {
      return
    }

    await this.handleRemoteReceivedAsymmetricMessages(messages.getValue())
  }

  sortServerMessages(messages: AsymmetricMessageServerHash[]): AsymmetricMessageServerHash[] {
    const SortedPriorityTypes = [AsymmetricMessagePayloadType.SenderKeypairChanged]

    const priority: AsymmetricMessageServerHash[] = []
    const regular: AsymmetricMessageServerHash[] = []

    const allMessagesOldestFirst = messages.slice().sort((a, b) => a.created_at_timestamp - b.created_at_timestamp)

    const messageTypeMap: Record<string, AsymmetricMessagePayloadType> = {}

    for (const message of allMessagesOldestFirst) {
      const messageType = this.getServerMessageType(message)
      if (!messageType) {
        continue
      }

      messageTypeMap[message.uuid] = messageType

      if (SortedPriorityTypes.includes(messageType)) {
        priority.push(message)
      } else {
        regular.push(message)
      }
    }

    const sortedPriority = priority.sort((a, b) => {
      const typeA = messageTypeMap[a.uuid]
      const typeB = messageTypeMap[b.uuid]

      if (typeA !== typeB) {
        return SortedPriorityTypes.indexOf(typeA) - SortedPriorityTypes.indexOf(typeB)
      }

      return a.created_at_timestamp - b.created_at_timestamp
    })

    const regularMessagesOldestFirst = regular.sort((a, b) => a.created_at_timestamp - b.created_at_timestamp)

    return [...sortedPriority, ...regularMessagesOldestFirst]
  }

  getServerMessageType(message: AsymmetricMessageServerHash): AsymmetricMessagePayloadType | undefined {
    const result = this.getUntrustedMessagePayload(message)

    if (result.isFailed()) {
      return undefined
    }

    return result.getValue().type
  }

  async handleRemoteReceivedAsymmetricMessages(messages: AsymmetricMessageServerHash[]): Promise<void> {
    if (messages.length === 0) {
      return
    }

    const sortedMessages = this.sortServerMessages(messages)

    for (const message of sortedMessages) {
      const trustedPayload = this.getTrustedMessagePayload(message)
      if (trustedPayload.isFailed()) {
        continue
      }

      await this.handleTrustedMessageResult(message, trustedPayload.getValue())
    }

    void this.sync.sync()
  }

  async handleTrustedMessageResult(
    message: AsymmetricMessageServerHash,
    payload: AsymmetricMessagePayload,
  ): Promise<void> {
    if (this.handledMessages.has(message.uuid)) {
      return
    }

    this.handledMessages.add(message.uuid)

    if (payload.type === AsymmetricMessagePayloadType.ContactShare) {
      await this.handleTrustedContactShareMessage(message, payload)
    } else if (payload.type === AsymmetricMessagePayloadType.SenderKeypairChanged) {
      await this.handleTrustedSenderKeypairChangedMessage(message, payload)
    } else if (payload.type === AsymmetricMessagePayloadType.SharedVaultRootKeyChanged) {
      await this.handleTrustedSharedVaultRootKeyChangedMessage(message, payload)
    } else if (payload.type === AsymmetricMessagePayloadType.SharedVaultMetadataChanged) {
      await this.handleTrustedVaultMetadataChangedMessage(message, payload)
    } else if (payload.type === AsymmetricMessagePayloadType.SharedVaultInvite) {
      throw new Error('Shared vault invites payloads are not handled as part of asymmetric messages')
    }

    await this.deleteMessageAfterProcessing(message)
  }

  getUntrustedMessagePayload(message: AsymmetricMessageServerHash): Result<AsymmetricMessagePayload> {
    const keys = this._getKeyPairs.execute()
    if (keys.isFailed()) {
      return Result.fail(keys.getError())
    }

    const result = this._getUntrustedPayload.execute({
      privateKey: keys.getValue().encryption.privateKey,
      payload: message,
    })

    if (result.isFailed()) {
      return Result.fail(result.getError())
    }

    return result
  }

  getTrustedMessagePayload(message: AsymmetricMessageServerHash): Result<AsymmetricMessagePayload> {
    const contact = this._findContact.execute({ userUuid: message.sender_uuid })
    if (contact.isFailed()) {
      return Result.fail(contact.getError())
    }

    const keys = this._getKeyPairs.execute()
    if (keys.isFailed()) {
      return Result.fail(keys.getError())
    }

    const result = this._getTrustedPayload.execute({
      privateKey: keys.getValue().encryption.privateKey,
      sender: contact.getValue(),
      ownUserUuid: this.sessions.userUuid,
      payload: message,
    })

    if (result.isFailed()) {
      return Result.fail(result.getError())
    }

    return result
  }

  async deleteMessageAfterProcessing(message: AsymmetricMessageServerHash): Promise<void> {
    await this.messageServer.deleteMessage({ messageUuid: message.uuid })
  }

  async handleTrustedVaultMetadataChangedMessage(
    _message: AsymmetricMessageServerHash,
    trustedPayload: AsymmetricMessageSharedVaultMetadataChanged,
  ): Promise<void> {
    const vault = this._getVault.execute<VaultListingInterface>({
      sharedVaultUuid: trustedPayload.data.sharedVaultUuid,
    })
    if (vault.isFailed()) {
      return
    }

    await this.mutator.changeItem<VaultListingMutator>(
      vault.getValue(),
      (mutator) => {
        mutator.name = trustedPayload.data.name
        mutator.description = trustedPayload.data.description
      },
      MutationType.UpdateUserTimestamps,
      PayloadEmitSource.RemoteRetrieved,
    )
  }

  async handleTrustedContactShareMessage(
    message: AsymmetricMessageServerHash,
    trustedPayload: AsymmetricMessageTrustedContactShare,
  ): Promise<void> {
    if (trustedPayload.data.trustedContact.isMe) {
      return
    }

    const authorized = await this.isSenderAuthorizedToShareContact(
      message.sender_uuid,
      trustedPayload.data.trustedContact.contactUuid,
    )
    if (!authorized) {
      return
    }

    await this._replaceContactData.execute(trustedPayload.data.trustedContact)
  }

  /**
   * A ContactShare rewrites the public keys this account holds for a THIRD party, and those keys are
   * the whole basis on which items stamped with that party's `last_edited_by_uuid` are trusted.
   * Decrypting a message and verifying its signature only proves it came from SOME trusted contact,
   * which is not the same thing as "this contact has any standing to speak for that third party".
   * Without this check any trusted contact could substitute their own key for a third party's and
   * then author items that validate as that third party.
   *
   * The only legitimate sender of a ContactShare is the owner of a shared vault acting as the
   * introduction hub for its members — `ShareContactWithVault` refuses to send unless the caller owns
   * the vault. The receiving side now requires the mirror of that: the sender must own a shared vault
   * this account is a member of, and a share that would OVERWRITE keys already held must also name a
   * contact who is a member of one of those vaults.
   *
   * The membership requirement deliberately does not apply to a contact this account does not know
   * yet. At invite time the invitee has no `shared_vault_users` row — that row appears only on accept
   * — and a non-owner member cannot read a vault's pending invites, so requiring membership there
   * would break the introduction of every new member and leave existing members unable to verify
   * anything the new member writes. Introducing someone to a vault they own is within an owner's
   * legitimate authority; silently rewriting the keys of a contact who has nothing to do with their
   * vault is not. Combined with ReplaceContactData appending rather than replacing the key set, an
   * authorized sender can add a key but can no longer erase the rotation history.
   */
  private async isSenderAuthorizedToShareContact(senderUuid: string, sharedContactUuid: string): Promise<boolean> {
    const sharedVaults = this._getSharedVaults.execute()
    if (sharedVaults.isFailed()) {
      return false
    }

    const vaultsOwnedBySender = sharedVaults.getValue().filter((vault) => vault.sharing.ownerUserUuid === senderUuid)
    if (vaultsOwnedBySender.length === 0) {
      return false
    }

    const existingContact = this._findContact.execute({ userUuid: sharedContactUuid })
    if (existingContact.isFailed()) {
      return true
    }

    for (const vault of vaultsOwnedBySender) {
      const vaultUsers = await this._getVaultUsers.execute({
        sharedVaultUuid: vault.sharing.sharedVaultUuid,
        readFromCache: false,
      })
      if (vaultUsers.isFailed()) {
        continue
      }

      if (vaultUsers.getValue().some((vaultUser) => vaultUser.user_uuid === sharedContactUuid)) {
        return true
      }
    }

    return false
  }

  async handleTrustedSenderKeypairChangedMessage(
    message: AsymmetricMessageServerHash,
    trustedPayload: AsymmetricMessageSenderKeypairChanged,
  ): Promise<void> {
    await this._createOrEditContact.execute({
      contactUuid: message.sender_uuid,
      publicKey: trustedPayload.data.newEncryptionPublicKey,
      signingPublicKey: trustedPayload.data.newSigningPublicKey,
    })
  }

  async handleTrustedSharedVaultRootKeyChangedMessage(
    message: AsymmetricMessageServerHash,
    trustedPayload: AsymmetricMessageSharedVaultRootKeyChanged,
  ): Promise<void> {
    // `sender_uuid` is stamped by the server from the authenticated sender's session, never from the
    // request body, so it is the right identity to authorize against. The use case rejects the
    // message unless that sender owns the vault the key system belongs to — decrypting and
    // signature-verifying a message only proves it came from SOME trusted contact, which is not the
    // same thing as the owner of this vault.
    await this._handleRootKeyChangedMessage.execute(trustedPayload, message.sender_uuid)
  }
}
