import 'reflect-metadata'

import { DomainEventInterface } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { DomainEventFactory } from './DomainEventFactory'

describe('DomainEventFactory', () => {
  let timer: TimerInterface

  const createFactory = () => new DomainEventFactory(timer)

  beforeEach(() => {
    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(1))
  })

  const expectEvent = (
    event: DomainEventInterface,
    expected: { type: string; userIdentifier: string; userIdentifierType: string; payload: unknown },
  ) => {
    expect(event.type).toEqual(expected.type)
    expect(event.createdAt).toEqual(new Date(1))
    expect(event.meta).toEqual({
      correlation: {
        userIdentifier: expected.userIdentifier,
        userIdentifierType: expected.userIdentifierType,
      },
      origin: 'syncing-server',
    })
    expect(event.payload).toEqual(expected.payload)
  }

  it('should create an items changed on server event correlated to the user', () => {
    const dto = { userUuid: '1-2-3', sessionUuid: '2-3-4', timestamp: 123 }

    expectEvent(createFactory().createItemsChangedOnServerEvent(dto), {
      type: 'ITEMS_CHANGED_ON_SERVER',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an account deletion verification passed event correlated to the user uuid, not the email', () => {
    const dto = { userUuid: '1-2-3', email: 'test@test.te' }

    expectEvent(createFactory().createAccountDeletionVerificationPassedEvent(dto), {
      type: 'ACCOUNT_DELETION_VERIFICATION_PASSED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a user designated as survivor in shared vault event', () => {
    const dto = { sharedVaultUuid: '3-4-5', userUuid: '1-2-3', timestamp: 123 }

    expectEvent(createFactory().createUserDesignatedAsSurvivorInSharedVaultEvent(dto), {
      type: 'USER_DESIGNATED_AS_SURVIVOR_IN_SHARED_VAULT',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a shared vault removed event correlated to the vault rather than to a user', () => {
    const dto = { sharedVaultUuid: '3-4-5', vaultOwnerUuid: '1-2-3' }

    expectEvent(createFactory().createSharedVaultRemovedEvent(dto), {
      type: 'SHARED_VAULT_REMOVED',
      userIdentifier: '3-4-5',
      userIdentifierType: 'shared-vault-uuid',
      payload: dto,
    })
  })

  it('should create an item removed from shared vault event', () => {
    const dto = { sharedVaultUuid: '3-4-5', itemUuid: '4-5-6', userUuid: '1-2-3' }

    expectEvent(createFactory().createItemRemovedFromSharedVaultEvent(dto), {
      type: 'ITEM_REMOVED_FROM_SHARED_VAULT',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a user removed from shared vault event', () => {
    const dto = { sharedVaultUuid: '3-4-5', userUuid: '1-2-3' }

    expectEvent(createFactory().createUserRemovedFromSharedVaultEvent(dto), {
      type: 'USER_REMOVED_FROM_SHARED_VAULT',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a user added to shared vault event', () => {
    const dto = {
      sharedVaultUuid: '3-4-5',
      userUuid: '1-2-3',
      permission: 'write',
      createdAt: 123,
      updatedAt: 234,
    }

    expectEvent(createFactory().createUserAddedToSharedVaultEvent(dto), {
      type: 'USER_ADDED_TO_SHARED_VAULT',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a user invited to shared vault event correlated to the invited user', () => {
    const dto = {
      invite: {
        uuid: '5-6-7',
        shared_vault_uuid: '3-4-5',
        user_uuid: '1-2-3',
        sender_uuid: '2-3-4',
        encrypted_message: 'encrypted',
        permission: 'write',
        created_at_timestamp: 123,
        updated_at_timestamp: 234,
      },
    }

    expectEvent(createFactory().createUserInvitedToSharedVaultEvent(dto), {
      type: 'USER_INVITED_TO_SHARED_VAULT',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a message sent to user event correlated to the recipient, not the sender', () => {
    const dto = {
      message: {
        uuid: '5-6-7',
        recipient_uuid: '1-2-3',
        sender_uuid: '2-3-4',
        encrypted_message: 'encrypted',
        replaceability_identifier: null,
        created_at_timestamp: 123,
        updated_at_timestamp: 234,
      },
    }

    expectEvent(createFactory().createMessageSentToUserEvent(dto), {
      type: 'MESSAGE_SENT_TO_USER',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a notification added for user event', () => {
    const dto = {
      notification: {
        uuid: '5-6-7',
        user_uuid: '1-2-3',
        type: 'SHARED_VAULT_ITEM_REMOVED',
        payload: 'payload',
        created_at_timestamp: 123,
        updated_at_timestamp: 234,
      },
    }

    expectEvent(createFactory().createNotificationAddedForUserEvent(dto), {
      type: 'NOTIFICATION_ADDED_FOR_USER',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a web socket message requested event', () => {
    const dto = { userUuid: '1-2-3', message: 'a message', originatingSessionUuid: '2-3-4' }

    expectEvent(createFactory().createWebSocketMessageRequestedEvent(dto), {
      type: 'WEB_SOCKET_MESSAGE_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a revisions copy requested event correlated to the separately supplied user uuid', () => {
    const dto = { originalItemUuid: '4-5-6', newItemUuid: '5-6-7' }

    expectEvent(createFactory().createRevisionsCopyRequestedEvent('1-2-3', dto), {
      type: 'REVISIONS_COPY_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an item dumped event carrying only the dump path, not the user uuid', () => {
    expectEvent(createFactory().createItemDumpedEvent({ fileDumpPath: '/tmp/dump', userUuid: '1-2-3' }), {
      type: 'ITEM_DUMPED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: { fileDumpPath: '/tmp/dump' },
    })
  })

  it('should create an item revision creation requested event carrying only the item uuid', () => {
    expectEvent(createFactory().createItemRevisionCreationRequested({ itemUuid: '4-5-6', userUuid: '1-2-3' }), {
      type: 'ITEM_REVISION_CREATION_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: { itemUuid: '4-5-6' },
    })
  })

  it('should create a duplicate item synced event', () => {
    const dto = { itemUuid: '4-5-6', userUuid: '1-2-3' }

    expectEvent(createFactory().createDuplicateItemSyncedEvent(dto), {
      type: 'DUPLICATE_ITEM_SYNCED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an item deleted event', () => {
    const dto = { itemUuid: '4-5-6', userUuid: '1-2-3' }

    expectEvent(createFactory().createItemDeletedEvent(dto), {
      type: 'ITEM_DELETED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an email requested event correlated by email address rather than by uuid', () => {
    const dto = {
      userEmail: 'test@test.te',
      messageIdentifier: 'EMAIL_BACKUP',
      level: 'system',
      body: '<p>body</p>',
      subject: 'A subject',
      sender: 'sender@test.te',
      attachments: [
        {
          filePath: '/tmp/backup',
          fileName: 'backup.txt',
          attachmentFileName: 'backup.txt',
          attachmentContentType: 'text/plain',
        },
      ],
      userUuid: '1-2-3',
    }

    expectEvent(createFactory().createEmailRequestedEvent(dto), {
      type: 'EMAIL_REQUESTED',
      userIdentifier: 'test@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should stamp every event with the timer date at the moment of creation', () => {
    timer.getUTCDate = jest.fn().mockReturnValueOnce(new Date(1)).mockReturnValueOnce(new Date(2))

    const factory = createFactory()

    expect(factory.createItemDeletedEvent({ itemUuid: '4-5-6', userUuid: '1-2-3' }).createdAt).toEqual(new Date(1))
    expect(factory.createItemDeletedEvent({ itemUuid: '4-5-6', userUuid: '1-2-3' }).createdAt).toEqual(new Date(2))
  })
})
