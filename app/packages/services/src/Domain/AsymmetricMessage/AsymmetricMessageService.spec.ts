import { GetKeyPairs } from './../Encryption/UseCase/GetKeyPairs'
import { GetVault } from './../Vault/UseCase/GetVault'
import { SessionsClientInterface } from './../Session/SessionsClientInterface'
import { EncryptionProviderInterface } from './../Encryption/EncryptionProviderInterface'
import { GetSharedVaults } from './../SharedVaults/UseCase/GetSharedVaults'
import { GetVaultUsers } from './../VaultUser/UseCase/GetVaultUsers'
import { GetUntrustedPayload } from './UseCase/GetUntrustedPayload'
import { GetInboundMessages } from './UseCase/GetInboundMessages'
import { GetOutboundMessages } from './UseCase/GetOutboundMessages'
import { HandleRootKeyChangedMessage } from './UseCase/HandleRootKeyChangedMessage'
import { GetTrustedPayload } from './UseCase/GetTrustedPayload'
import { ReplaceContactData } from './../Contacts/UseCase/ReplaceContactData'
import { FindContact } from './../Contacts/UseCase/FindContact'
import { CreateOrEditContact } from './../Contacts/UseCase/CreateOrEditContact'
import { MutatorClientInterface } from './../Mutator/MutatorClientInterface'
import { AsymmetricMessageServer } from '@standardnotes/api'
import { AsymmetricMessageService } from './AsymmetricMessageService'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { SyncServiceInterface } from '../Sync/SyncServiceInterface'
import { AsymmetricMessageServerHash } from '@standardnotes/responses'
import {
  AsymmetricMessagePayloadType,
  AsymmetricMessageSenderKeypairChanged,
  AsymmetricMessageSharedVaultInvite,
  AsymmetricMessageSharedVaultMetadataChanged,
  AsymmetricMessageSharedVaultRootKeyChanged,
  AsymmetricMessageTrustedContactShare,
  ContactPublicKeySet,
  DecryptedPayload,
  FillItemContentSpecialized,
  KeySystemPasswordType,
  KeySystemRootKeyContentSpecialized,
  KeySystemRootKeyParamsInterface,
  KeySystemRootKeyStorageMode,
  ProtocolVersion,
  SharedVaultListingInterface,
  TrustedContact,
  PayloadTimestampDefaults,
  TrustedContactContentSpecialized,
  TrustedContactInterface,
  VaultListing,
  VaultListingContentSpecialized,
  VaultListingInterface,
} from '@standardnotes/models'
import { SharedVaultUserServerHash } from '@standardnotes/responses'
import { ContentType, Result } from '@standardnotes/domain-core'

describe('AsymmetricMessageService', () => {
  let sync: jest.Mocked<SyncServiceInterface>
  let mutator: jest.Mocked<MutatorClientInterface>
  let encryption: jest.Mocked<EncryptionProviderInterface>
  let sessions!: jest.Mocked<SessionsClientInterface>
  let findContact: jest.Mocked<FindContact>
  let replaceContactData: jest.Mocked<ReplaceContactData>
  let getSharedVaults: jest.Mocked<GetSharedVaults>
  let getVaultUsers: jest.Mocked<GetVaultUsers>
  let service: AsymmetricMessageService

  beforeEach(() => {
    const messageServer = {} as jest.Mocked<AsymmetricMessageServer>
    messageServer.deleteMessage = jest.fn()

    encryption = {} as jest.Mocked<EncryptionProviderInterface>
    const createOrEditContact = {} as jest.Mocked<CreateOrEditContact>
    findContact = {} as jest.Mocked<FindContact>
    replaceContactData = {} as jest.Mocked<ReplaceContactData>
    const getTrustedPayload = {} as jest.Mocked<GetTrustedPayload>
    const getVault = {} as jest.Mocked<GetVault>
    const handleRootKeyChangedMessage = {} as jest.Mocked<HandleRootKeyChangedMessage>
    const getOutboundMessagesUseCase = {} as jest.Mocked<GetOutboundMessages>
    const getInboundMessagesUseCase = {} as jest.Mocked<GetInboundMessages>
    const getUntrustedPayload = {} as jest.Mocked<GetUntrustedPayload>
    const getKeyPairs = {} as jest.Mocked<GetKeyPairs>
    getSharedVaults = {} as jest.Mocked<GetSharedVaults>
    getVaultUsers = {} as jest.Mocked<GetVaultUsers>

    sync = {} as jest.Mocked<SyncServiceInterface>
    sync.sync = jest.fn()

    mutator = {} as jest.Mocked<MutatorClientInterface>
    mutator.changeItem = jest.fn()

    const eventBus = {} as jest.Mocked<InternalEventBusInterface>
    eventBus.addEventHandler = jest.fn()

    service = new AsymmetricMessageService(
      encryption,
      mutator,
      sessions,
      sync,
      messageServer,
      createOrEditContact,
      findContact,
      replaceContactData,
      getTrustedPayload,
      getVault,
      handleRootKeyChangedMessage,
      getOutboundMessagesUseCase,
      getInboundMessagesUseCase,
      getUntrustedPayload,
      getKeyPairs,
      getSharedVaults,
      getVaultUsers,
      eventBus,
    )
  })

  describe('sortServerMessages', () => {
    it('should prioritize keypair changed messages over other messages', () => {
      const messages: AsymmetricMessageServerHash[] = [
        {
          uuid: 'keypair-changed-message',
          recipient_uuid: '1',
          sender_uuid: '2',
          encrypted_message: 'encrypted_message',
          created_at_timestamp: 2,
          updated_at_timestamp: 2,
          replaceability_identifier: null,
        },
        {
          uuid: 'misc-message',
          recipient_uuid: '1',
          sender_uuid: '2',
          encrypted_message: 'encrypted_message',
          created_at_timestamp: 1,
          updated_at_timestamp: 1,
          replaceability_identifier: null,
        },
      ]

      service.getUntrustedMessagePayload = jest.fn()
      service.getServerMessageType = jest.fn().mockImplementation((message) => {
        if (message.uuid === 'keypair-changed-message') {
          return AsymmetricMessagePayloadType.SenderKeypairChanged
        } else {
          return AsymmetricMessagePayloadType.ContactShare
        }
      })

      const sorted = service.sortServerMessages(messages)
      expect(sorted[0].uuid).toEqual('keypair-changed-message')
      expect(sorted[1].uuid).toEqual('misc-message')

      const reverseSorted = service.sortServerMessages(messages.reverse())
      expect(reverseSorted[0].uuid).toEqual('keypair-changed-message')
      expect(reverseSorted[1].uuid).toEqual('misc-message')
    })
  })

  describe('handleTrustedMessageResult', () => {
    it('should not double handle the same message', async () => {
      /**
       * Because message retrieval is based on a syncToken, and the server aligns syncTokens to items sent back
       * rather than messages, we may receive the same message twice. We want to keep track of processed messages
       * and avoid double processing.
       */

      const message: AsymmetricMessageServerHash = {
        uuid: 'message',
        recipient_uuid: '1',
        sender_uuid: '2',
        encrypted_message: 'encrypted_message',
        created_at_timestamp: 2,
        updated_at_timestamp: 2,
        replaceability_identifier: null,
      }

      const decryptedMessagePayload: AsymmetricMessageTrustedContactShare = {
        type: AsymmetricMessagePayloadType.ContactShare,
        data: {
          recipientUuid: '1',
          trustedContact: {} as TrustedContactInterface,
        },
      }

      service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
        .fn()
        .mockReturnValue(Result.ok(decryptedMessagePayload))

      service.handleTrustedContactShareMessage = jest.fn()
      await service.handleTrustedMessageResult(message, decryptedMessagePayload)
      expect(service.handleTrustedContactShareMessage).toHaveBeenCalledTimes(1)

      service.handleTrustedContactShareMessage = jest.fn()
      await service.handleTrustedMessageResult(message, decryptedMessagePayload)
      expect(service.handleTrustedContactShareMessage).toHaveBeenCalledTimes(0)
    })
  })

  it('should process incoming messages oldest first', async () => {
    const messages: AsymmetricMessageServerHash[] = [
      {
        uuid: 'newer-message',
        recipient_uuid: '1',
        sender_uuid: '2',
        encrypted_message: 'encrypted_message',
        created_at_timestamp: 2,
        updated_at_timestamp: 2,
        replaceability_identifier: null,
      },
      {
        uuid: 'older-message',
        recipient_uuid: '1',
        sender_uuid: '2',
        encrypted_message: 'encrypted_message',
        created_at_timestamp: 1,
        updated_at_timestamp: 1,
        replaceability_identifier: null,
      },
    ]

    const trustedPayloadMock = { type: AsymmetricMessagePayloadType.ContactShare, data: { recipientUuid: '1' } }

    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(trustedPayloadMock))

    const handleTrustedContactShareMessageMock = jest.fn()
    service.handleTrustedContactShareMessage = handleTrustedContactShareMessageMock

    await service.handleRemoteReceivedAsymmetricMessages(messages)

    expect(handleTrustedContactShareMessageMock.mock.calls[0][0]).toEqual(messages[1])
    expect(handleTrustedContactShareMessageMock.mock.calls[1][0]).toEqual(messages[0])
  })

  it('should handle ContactShare message', async () => {
    const message: AsymmetricMessageServerHash = {
      uuid: 'message',
      recipient_uuid: '1',
      sender_uuid: '2',
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 2,
      updated_at_timestamp: 2,
      replaceability_identifier: null,
    }

    const decryptedMessagePayload: AsymmetricMessageTrustedContactShare = {
      type: AsymmetricMessagePayloadType.ContactShare,
      data: {
        recipientUuid: '1',
        trustedContact: {} as TrustedContactInterface,
      },
    }

    service.handleTrustedContactShareMessage = jest.fn()
    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(decryptedMessagePayload))

    await service.handleRemoteReceivedAsymmetricMessages([message])

    expect(service.handleTrustedContactShareMessage).toHaveBeenCalledWith(message, decryptedMessagePayload)
  })

  it('should handle SenderKeypairChanged message', async () => {
    const message: AsymmetricMessageServerHash = {
      uuid: 'message',
      recipient_uuid: '1',
      sender_uuid: '2',
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 2,
      updated_at_timestamp: 2,
      replaceability_identifier: null,
    }

    const decryptedMessagePayload: AsymmetricMessageSenderKeypairChanged = {
      type: AsymmetricMessagePayloadType.SenderKeypairChanged,
      data: {
        recipientUuid: '1',
        newEncryptionPublicKey: 'new-encryption-public-key',
        newSigningPublicKey: 'new-signing-public-key',
      },
    }

    service.handleTrustedSenderKeypairChangedMessage = jest.fn()
    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(decryptedMessagePayload))

    await service.handleRemoteReceivedAsymmetricMessages([message])

    expect(service.handleTrustedSenderKeypairChangedMessage).toHaveBeenCalledWith(message, decryptedMessagePayload)
  })

  it('should handle SharedVaultRootKeyChanged message', async () => {
    const message: AsymmetricMessageServerHash = {
      uuid: 'message',
      recipient_uuid: '1',
      sender_uuid: '2',
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 2,
      updated_at_timestamp: 2,
      replaceability_identifier: null,
    }

    const decryptedMessagePayload: AsymmetricMessageSharedVaultRootKeyChanged = {
      type: AsymmetricMessagePayloadType.SharedVaultRootKeyChanged,
      data: {
        recipientUuid: '1',
        rootKey: {} as KeySystemRootKeyContentSpecialized,
      },
    }

    service.handleTrustedSharedVaultRootKeyChangedMessage = jest.fn()
    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(decryptedMessagePayload))

    await service.handleRemoteReceivedAsymmetricMessages([message])

    expect(service.handleTrustedSharedVaultRootKeyChangedMessage).toHaveBeenCalledWith(message, decryptedMessagePayload)
  })

  it('should handle SharedVaultMetadataChanged message', async () => {
    const message: AsymmetricMessageServerHash = {
      uuid: 'message',
      recipient_uuid: '1',
      sender_uuid: '2',
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 2,
      updated_at_timestamp: 2,
      replaceability_identifier: null,
    }

    const decryptedMessagePayload: AsymmetricMessageSharedVaultMetadataChanged = {
      type: AsymmetricMessagePayloadType.SharedVaultMetadataChanged,
      data: {
        recipientUuid: '1',
        sharedVaultUuid: 'shared-vault-uuid',
        name: 'Vault name',
        description: 'Vault description',
      },
    }

    service.handleTrustedVaultMetadataChangedMessage = jest.fn()
    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(decryptedMessagePayload))

    await service.handleRemoteReceivedAsymmetricMessages([message])

    expect(service.handleTrustedVaultMetadataChangedMessage).toHaveBeenCalledWith(message, decryptedMessagePayload)
  })

  it('should throw if message type is SharedVaultInvite', async () => {
    const message: AsymmetricMessageServerHash = {
      uuid: 'message',
      recipient_uuid: '1',
      sender_uuid: '2',
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 2,
      updated_at_timestamp: 2,
      replaceability_identifier: null,
    }

    const decryptedMessagePayload: AsymmetricMessageSharedVaultInvite = {
      type: AsymmetricMessagePayloadType.SharedVaultInvite,
      data: {
        recipientUuid: '1',
      },
    } as AsymmetricMessageSharedVaultInvite

    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(decryptedMessagePayload))

    await expect(service.handleRemoteReceivedAsymmetricMessages([message])).rejects.toThrow(
      'Shared vault invites payloads are not handled as part of asymmetric messages',
    )
  })

  describe('handleTrustedContactShareMessage authorization', () => {
    const VAULT_OWNER = 'vault-owner-uuid'
    const UNRELATED_CONTACT = 'unrelated-contact-uuid'
    const THIRD_PARTY = 'third-party-uuid'
    const SHARED_VAULT_UUID = 'shared-vault-uuid'

    const createVault = (params: { sharedVaultUuid: string; ownerUserUuid: string }): SharedVaultListingInterface => {
      const rootKeyParams: KeySystemRootKeyParamsInterface = {
        systemIdentifier: 'key-system-identifier',
        seed: 'seed',
        version: ProtocolVersion.V004,
        passwordType: KeySystemPasswordType.Randomized,
        creationTimestamp: 1,
      }

      const vault = new VaultListing(
        new DecryptedPayload({
          uuid: `vault-item-${params.sharedVaultUuid}`,
          content_type: ContentType.TYPES.VaultListing,
          ...PayloadTimestampDefaults(),
          content: FillItemContentSpecialized<VaultListingContentSpecialized, VaultListingInterface>({
            systemIdentifier: 'key-system-identifier',
            rootKeyParams,
            keyStorageMode: KeySystemRootKeyStorageMode.Synced,
            name: 'A Shared Vault',
            iconString: 'safe-square',
            sharing: {
              sharedVaultUuid: params.sharedVaultUuid,
              ownerUserUuid: params.ownerUserUuid,
              fileBytesUsed: 0,
              designatedSurvivor: null,
            },
          }),
        }),
      )

      // A plain object cast would satisfy the type while failing `isSharedVaultListing()`, which is
      // how GetSharedVaults decides what it returns at all.
      if (!vault.isSharedVaultListing()) {
        throw new Error('vault fixture is not a shared vault listing')
      }

      return vault
    }

    const createContact = (contactUuid: string): TrustedContactInterface =>
      new TrustedContact(
        new DecryptedPayload({
          uuid: `contact-item-${contactUuid}`,
          content_type: ContentType.TYPES.TrustedContact,
          ...PayloadTimestampDefaults(),
          content: FillItemContentSpecialized<TrustedContactContentSpecialized, TrustedContactInterface>({
            name: contactUuid,
            contactUuid,
            isMe: false,
            publicKeySet: new ContactPublicKeySet({
              encryption: `encryption-${contactUuid}`,
              signing: `signing-${contactUuid}`,
              timestamp: new Date(1),
              previousKeySet: undefined,
            }),
          }),
        }),
      )

    const createVaultUser = (userUuid: string): SharedVaultUserServerHash => ({
      uuid: `membership-${userUuid}`,
      shared_vault_uuid: SHARED_VAULT_UUID,
      user_uuid: userUuid,
      permission: 'write',
      updated_at_timestamp: 1,
      is_designated_survivor: false,
    })

    const createMessage = (senderUuid: string): AsymmetricMessageServerHash => ({
      uuid: 'contact-share-message',
      recipient_uuid: 'me-uuid',
      sender_uuid: senderUuid,
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 1,
      updated_at_timestamp: 1,
      replaceability_identifier: null,
    })

    const createPayload = (contactUuid: string, isMe = false): AsymmetricMessageTrustedContactShare => ({
      type: AsymmetricMessagePayloadType.ContactShare,
      data: {
        recipientUuid: 'me-uuid',
        trustedContact: {
          name: 'Substituted Name',
          contactUuid,
          isMe,
          publicKeySet: new ContactPublicKeySet({
            encryption: 'encryption-chosen-by-sender',
            signing: 'signing-chosen-by-sender',
            timestamp: new Date(2),
            previousKeySet: undefined,
          }).asJson(),
        },
      },
    })

    beforeEach(() => {
      replaceContactData.execute = jest.fn()
      getVaultUsers.execute = jest.fn().mockResolvedValue(Result.ok([createVaultUser(THIRD_PARTY)]))
    })

    it('refuses a share from a contact who owns no shared vault this account is in', async () => {
      const vaultOwnedBySomeoneElse = createVault({
        sharedVaultUuid: SHARED_VAULT_UUID,
        ownerUserUuid: VAULT_OWNER,
      })

      // Precondition: this account really is in a shared vault, just not one the sender owns, so the
      // refusal is the ownership test rather than "no vaults at all".
      getSharedVaults.execute = jest.fn().mockReturnValue(Result.ok([vaultOwnedBySomeoneElse]))
      expect(getSharedVaults.execute().getValue()).toHaveLength(1)

      findContact.execute = jest.fn().mockReturnValue(Result.ok(createContact(THIRD_PARTY)))

      await service.handleTrustedContactShareMessage(createMessage(UNRELATED_CONTACT), createPayload(THIRD_PARTY))

      expect(replaceContactData.execute).not.toHaveBeenCalled()
    })

    it('refuses a share that would overwrite keys for a contact outside the sender vaults', async () => {
      const senderOwnedVault = createVault({ sharedVaultUuid: SHARED_VAULT_UUID, ownerUserUuid: VAULT_OWNER })
      getSharedVaults.execute = jest.fn().mockReturnValue(Result.ok([senderOwnedVault]))

      const alreadyTrusted = createContact(THIRD_PARTY)
      findContact.execute = jest.fn().mockReturnValue(Result.ok(alreadyTrusted))

      // The vault really has members, and the shared contact is not among them.
      const members = [createVaultUser('some-other-member-uuid')]
      getVaultUsers.execute = jest.fn().mockResolvedValue(Result.ok(members))

      await service.handleTrustedContactShareMessage(createMessage(VAULT_OWNER), createPayload(THIRD_PARTY))

      // Preconditions: the keys really were already held locally, and the membership of the sender's
      // vault really was consulted — so this is a refusal, not a lookup that never happened.
      expect(findContact.execute).toHaveBeenCalledWith({ userUuid: THIRD_PARTY })
      expect(alreadyTrusted.publicKeySet.encryption).toEqual(`encryption-${THIRD_PARTY}`)
      expect(getVaultUsers.execute).toHaveBeenCalledWith({
        sharedVaultUuid: SHARED_VAULT_UUID,
        readFromCache: false,
      })
      expect(members.map((member) => member.user_uuid)).not.toContain(THIRD_PARTY)

      expect(replaceContactData.execute).not.toHaveBeenCalled()
    })

    it('accepts a rotation share for a member of a vault the sender owns', async () => {
      const senderOwnedVault = createVault({ sharedVaultUuid: SHARED_VAULT_UUID, ownerUserUuid: VAULT_OWNER })
      getSharedVaults.execute = jest.fn().mockReturnValue(Result.ok([senderOwnedVault]))

      findContact.execute = jest.fn().mockReturnValue(Result.ok(createContact(THIRD_PARTY)))
      getVaultUsers.execute = jest.fn().mockResolvedValue(Result.ok([createVaultUser(THIRD_PARTY)]))

      const payload = createPayload(THIRD_PARTY)
      await service.handleTrustedContactShareMessage(createMessage(VAULT_OWNER), payload)

      expect(getVaultUsers.execute).toHaveBeenCalledWith({
        sharedVaultUuid: SHARED_VAULT_UUID,
        readFromCache: false,
      })
      expect(replaceContactData.execute).toHaveBeenCalledWith(payload.data.trustedContact)
    })

    it('accepts the introduction of a not yet known contact by a vault owner', async () => {
      const senderOwnedVault = createVault({ sharedVaultUuid: SHARED_VAULT_UUID, ownerUserUuid: VAULT_OWNER })
      getSharedVaults.execute = jest.fn().mockReturnValue(Result.ok([senderOwnedVault]))

      // The invitee has no membership row yet, and this account has never heard of them. This is the
      // invite-time introduction ShareContactWithVault performs right after creating the invite.
      findContact.execute = jest.fn().mockReturnValue(Result.fail('Contact not found'))
      getVaultUsers.execute = jest.fn().mockResolvedValue(Result.ok([createVaultUser('some-other-member-uuid')]))

      const payload = createPayload('brand-new-invitee-uuid')
      await service.handleTrustedContactShareMessage(createMessage(VAULT_OWNER), payload)

      expect(findContact.execute).toHaveBeenCalledWith({ userUuid: 'brand-new-invitee-uuid' })
      expect(replaceContactData.execute).toHaveBeenCalledWith(payload.data.trustedContact)
    })

    it('still ignores a share claiming to be the me contact', async () => {
      getSharedVaults.execute = jest.fn()
      findContact.execute = jest.fn()

      await service.handleTrustedContactShareMessage(createMessage(VAULT_OWNER), createPayload(THIRD_PARTY, true))

      expect(getSharedVaults.execute).not.toHaveBeenCalled()
      expect(replaceContactData.execute).not.toHaveBeenCalled()
    })
  })

  it('should delete message from server after processing', async () => {
    const message: AsymmetricMessageServerHash = {
      uuid: 'message',
      recipient_uuid: '1',
      sender_uuid: '2',
      encrypted_message: 'encrypted_message',
      created_at_timestamp: 2,
      updated_at_timestamp: 2,
      replaceability_identifier: null,
    }

    const decryptedMessagePayload: AsymmetricMessageTrustedContactShare = {
      type: AsymmetricMessagePayloadType.ContactShare,
      data: {
        recipientUuid: '1',
        trustedContact: {} as TrustedContactInterface,
      },
    }

    service.deleteMessageAfterProcessing = jest.fn()
    service.handleTrustedContactShareMessage = jest.fn()
    service.getTrustedMessagePayload = service.getUntrustedMessagePayload = jest
      .fn()
      .mockReturnValue(Result.ok(decryptedMessagePayload))

    await service.handleRemoteReceivedAsymmetricMessages([message])

    expect(service.deleteMessageAfterProcessing).toHaveBeenCalled()
  })
})
