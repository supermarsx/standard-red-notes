import { ConflictType } from '@standardnotes/responses'

import { ItemHttpRepresentation } from '../Http/ItemHttpRepresentation'
import { ItemHashHttpRepresentation } from '../Http/ItemHashHttpRepresentation'
import { SavedItemHttpRepresentation } from '../Http/SavedItemHttpRepresentation'
import { SyncResponse20200115 } from '../../Domain/Item/SyncResponse/SyncResponse20200115'

import { SyncResponseGRPCMapper } from './SyncResponseGRPCMapper'

describe('SyncResponseGRPCMapper', () => {
  const createMapper = () => new SyncResponseGRPCMapper()

  const fullItem: ItemHttpRepresentation = {
    uuid: 'item-uuid',
    items_key_id: 'items-key-id',
    duplicate_of: 'duplicate-of',
    enc_item_key: 'enc-item-key',
    content: 'content',
    content_type: 'Note',
    auth_hash: 'auth-hash',
    deleted: false,
    created_at: '2023-01-01',
    created_at_timestamp: 123,
    updated_at: '2023-01-02',
    updated_at_timestamp: 456,
    updated_with_session: 'session-uuid',
    key_system_identifier: 'key-system-identifier',
    shared_vault_uuid: 'shared-vault-uuid',
    user_uuid: 'user-uuid',
    last_edited_by_uuid: 'last-edited-by-uuid',
  }

  const bareItem: ItemHttpRepresentation = {
    uuid: 'item-uuid',
    items_key_id: null,
    duplicate_of: null,
    enc_item_key: null,
    content: null,
    content_type: 'Note',
    auth_hash: null,
    deleted: true,
    created_at: '2023-01-01',
    created_at_timestamp: 123,
    updated_at: '2023-01-02',
    updated_at_timestamp: 456,
    updated_with_session: null,
    key_system_identifier: null,
    shared_vault_uuid: null,
    user_uuid: null,
    last_edited_by_uuid: null,
  }

  const fullSavedItem: SavedItemHttpRepresentation = {
    uuid: 'saved-item-uuid',
    duplicate_of: 'duplicate-of',
    content_type: 'Note',
    auth_hash: 'auth-hash',
    deleted: false,
    created_at: '2023-01-01',
    created_at_timestamp: 123,
    updated_at: '2023-01-02',
    updated_at_timestamp: 456,
    key_system_identifier: 'key-system-identifier',
    shared_vault_uuid: 'shared-vault-uuid',
    user_uuid: 'user-uuid',
    last_edited_by_uuid: 'last-edited-by-uuid',
  }

  const bareSavedItem: SavedItemHttpRepresentation = {
    uuid: 'saved-item-uuid',
    duplicate_of: null,
    content_type: 'Note',
    auth_hash: null,
    deleted: true,
    created_at: '2023-01-01',
    created_at_timestamp: 123,
    updated_at: '2023-01-02',
    updated_at_timestamp: 456,
    key_system_identifier: null,
    shared_vault_uuid: null,
    user_uuid: null,
    last_edited_by_uuid: null,
  }

  const fullItemHash: ItemHashHttpRepresentation = {
    uuid: 'hash-uuid',
    user_uuid: 'hash-user-uuid',
    content: 'hash-content',
    content_type: 'Note',
    deleted: true,
    duplicate_of: 'hash-duplicate-of',
    auth_hash: 'hash-auth-hash',
    enc_item_key: 'hash-enc-item-key',
    items_key_id: 'hash-items-key-id',
    key_system_identifier: 'hash-key-system-identifier',
    shared_vault_uuid: 'hash-shared-vault-uuid',
    created_at: '2023-01-01',
    created_at_timestamp: 12,
    updated_at: '2023-01-02',
    updated_at_timestamp: 34,
  }

  const bareItemHash: ItemHashHttpRepresentation = {
    uuid: 'hash-uuid',
    user_uuid: 'hash-user-uuid',
    content_type: null,
    deleted: false,
    duplicate_of: null,
    key_system_identifier: null,
    shared_vault_uuid: null,
  }

  const emptyResponse = (): SyncResponse20200115 => ({
    retrieved_items: [],
    saved_items: [],
    conflicts: [],
    sync_token: 'sync-token',
    messages: [],
    shared_vaults: [],
    shared_vault_invites: [],
    notifications: [],
  })

  it('carries the sync token across', () => {
    expect(createMapper().toProjection(emptyResponse()).getSyncToken()).toEqual('sync-token')
  })

  it('omits the cursor token when the domain response has none', () => {
    expect(createMapper().toProjection(emptyResponse()).getCursorToken()).toEqual('')
  })

  it('sets the cursor token when the domain response has one', () => {
    const projection = createMapper().toProjection({ ...emptyResponse(), cursor_token: 'cursor-token' })

    expect(projection.getCursorToken()).toEqual('cursor-token')
  })

  it('maps a fully populated retrieved item', () => {
    const [item] = createMapper()
      .toProjection({ ...emptyResponse(), retrieved_items: [fullItem] })
      .getRetrievedItemsList()

    expect(item.getUuid()).toEqual('item-uuid')
    expect(item.getItemsKeyId()).toEqual('items-key-id')
    expect(item.getDuplicateOf()).toEqual('duplicate-of')
    expect(item.getEncItemKey()).toEqual('enc-item-key')
    expect(item.getContent()).toEqual('content')
    expect(item.getContentType()).toEqual('Note')
    expect(item.getAuthHash()).toEqual('auth-hash')
    expect(item.getDeleted()).toBe(false)
    expect(item.getCreatedAt()).toEqual('2023-01-01')
    expect(item.getCreatedAtTimestamp()).toEqual(123)
    expect(item.getUpdatedAt()).toEqual('2023-01-02')
    expect(item.getUpdatedAtTimestamp()).toEqual(456)
    expect(item.getUpdatedWithSession()).toEqual('session-uuid')
    expect(item.getKeySystemIdentifier()).toEqual('key-system-identifier')
    expect(item.getSharedVaultUuid()).toEqual('shared-vault-uuid')
    expect(item.getUserUuid()).toEqual('user-uuid')
    expect(item.getLastEditedByUuid()).toEqual('last-edited-by-uuid')
  })

  it('leaves every optional retrieved item field unset when the source is null', () => {
    const [item] = createMapper()
      .toProjection({ ...emptyResponse(), retrieved_items: [bareItem] })
      .getRetrievedItemsList()

    expect(item.getItemsKeyId()).toEqual('')
    expect(item.getDuplicateOf()).toEqual('')
    expect(item.getEncItemKey()).toEqual('')
    expect(item.getContent()).toEqual('')
    expect(item.getAuthHash()).toEqual('')
    expect(item.getUpdatedWithSession()).toEqual('')
    expect(item.getKeySystemIdentifier()).toEqual('')
    expect(item.getSharedVaultUuid()).toEqual('')
    expect(item.getUserUuid()).toEqual('')
    expect(item.getLastEditedByUuid()).toEqual('')
    expect(item.getDeleted()).toBe(true)
  })

  it('maps a fully populated saved item', () => {
    const [item] = createMapper()
      .toProjection({ ...emptyResponse(), saved_items: [fullSavedItem] })
      .getSavedItemsList()

    expect(item.getUuid()).toEqual('saved-item-uuid')
    expect(item.getDuplicateOf()).toEqual('duplicate-of')
    expect(item.getContentType()).toEqual('Note')
    expect(item.getAuthHash()).toEqual('auth-hash')
    expect(item.getDeleted()).toBe(false)
    expect(item.getCreatedAtTimestamp()).toEqual(123)
    expect(item.getUpdatedAtTimestamp()).toEqual(456)
    expect(item.getKeySystemIdentifier()).toEqual('key-system-identifier')
    expect(item.getSharedVaultUuid()).toEqual('shared-vault-uuid')
    expect(item.getUserUuid()).toEqual('user-uuid')
    expect(item.getLastEditedByUuid()).toEqual('last-edited-by-uuid')
  })

  it('leaves every optional saved item field unset when the source is null', () => {
    const [item] = createMapper()
      .toProjection({ ...emptyResponse(), saved_items: [bareSavedItem] })
      .getSavedItemsList()

    expect(item.getDuplicateOf()).toEqual('')
    expect(item.getAuthHash()).toEqual('')
    expect(item.getKeySystemIdentifier()).toEqual('')
    expect(item.getSharedVaultUuid()).toEqual('')
    expect(item.getUserUuid()).toEqual('')
    expect(item.getLastEditedByUuid()).toEqual('')
    expect(item.getDeleted()).toBe(true)
  })

  it('maps a conflict carrying a server item', () => {
    const [conflict] = createMapper()
      .toProjection({
        ...emptyResponse(),
        conflicts: [{ type: ConflictType.ConflictingData, server_item: fullItem }],
      })
      .getConflictsList()

    expect(conflict.getType()).toEqual(ConflictType.ConflictingData)
    expect(conflict.getServerItem()?.getUuid()).toEqual('item-uuid')
    expect(conflict.getUnsavedItem()).toBeUndefined()
  })

  it('maps a conflict carrying a fully populated unsaved item hash', () => {
    const [conflict] = createMapper()
      .toProjection({
        ...emptyResponse(),
        conflicts: [{ type: ConflictType.UuidConflict, unsaved_item: fullItemHash }],
      })
      .getConflictsList()

    const hash = conflict.getUnsavedItem()
    expect(conflict.getServerItem()).toBeUndefined()
    expect(hash?.getUuid()).toEqual('hash-uuid')
    expect(hash?.getUserUuid()).toEqual('hash-user-uuid')
    expect(hash?.getContent()).toEqual('hash-content')
    expect(hash?.getContentType()).toEqual('Note')
    expect(hash?.getDeleted()).toBe(true)
    expect(hash?.getDuplicateOf()).toEqual('hash-duplicate-of')
    expect(hash?.getAuthHash()).toEqual('hash-auth-hash')
    expect(hash?.getEncItemKey()).toEqual('hash-enc-item-key')
    expect(hash?.getItemsKeyId()).toEqual('hash-items-key-id')
    expect(hash?.getKeySystemIdentifier()).toEqual('hash-key-system-identifier')
    expect(hash?.getSharedVaultUuid()).toEqual('hash-shared-vault-uuid')
    expect(hash?.getCreatedAt()).toEqual('2023-01-01')
    expect(hash?.getCreatedAtTimestamp()).toEqual(12)
    expect(hash?.getUpdatedAt()).toEqual('2023-01-02')
    expect(hash?.getUpdatedAtTimestamp()).toEqual(34)
  })

  it('leaves every optional item hash field unset when the source omits it', () => {
    const [conflict] = createMapper()
      .toProjection({
        ...emptyResponse(),
        conflicts: [{ type: ConflictType.UuidConflict, unsaved_item: bareItemHash }],
      })
      .getConflictsList()

    const hash = conflict.getUnsavedItem()
    expect(hash?.getContent()).toEqual('')
    expect(hash?.getContentType()).toEqual('')
    expect(hash?.getDeleted()).toBe(false)
    expect(hash?.getDuplicateOf()).toEqual('')
    expect(hash?.getAuthHash()).toEqual('')
    expect(hash?.getEncItemKey()).toEqual('')
    expect(hash?.getItemsKeyId()).toEqual('')
    expect(hash?.getKeySystemIdentifier()).toEqual('')
    expect(hash?.getSharedVaultUuid()).toEqual('')
    expect(hash?.getCreatedAt()).toEqual('')
    expect(hash?.getCreatedAtTimestamp()).toEqual(0)
    expect(hash?.getUpdatedAt()).toEqual('')
    expect(hash?.getUpdatedAtTimestamp()).toEqual(0)
  })

  it('maps a conflict that carries neither side', () => {
    const [conflict] = createMapper()
      .toProjection({ ...emptyResponse(), conflicts: [{ type: ConflictType.UuidConflict }] })
      .getConflictsList()

    expect(conflict.getServerItem()).toBeUndefined()
    expect(conflict.getUnsavedItem()).toBeUndefined()
    expect(conflict.getType()).toEqual(ConflictType.UuidConflict)
  })

  it('maps a message with a replaceability identifier', () => {
    const [message] = createMapper()
      .toProjection({
        ...emptyResponse(),
        messages: [
          {
            uuid: 'message-uuid',
            recipient_uuid: 'recipient-uuid',
            sender_uuid: 'sender-uuid',
            encrypted_message: 'encrypted-message',
            replaceability_identifier: 'replaceability-identifier',
            created_at_timestamp: 1,
            updated_at_timestamp: 2,
          },
        ],
      })
      .getMessagesList()

    expect(message.getUuid()).toEqual('message-uuid')
    expect(message.getRecipientUuid()).toEqual('recipient-uuid')
    expect(message.getSenderUuid()).toEqual('sender-uuid')
    expect(message.getEncryptedMessage()).toEqual('encrypted-message')
    expect(message.getReplaceabilityIdentifier()).toEqual('replaceability-identifier')
    expect(message.getCreatedAtTimestamp()).toEqual(1)
    expect(message.getUpdatedAtTimestamp()).toEqual(2)
  })

  it('leaves the replaceability identifier unset when the message has none', () => {
    const [message] = createMapper()
      .toProjection({
        ...emptyResponse(),
        messages: [
          {
            uuid: 'message-uuid',
            recipient_uuid: 'recipient-uuid',
            sender_uuid: 'sender-uuid',
            encrypted_message: 'encrypted-message',
            replaceability_identifier: null,
            created_at_timestamp: 1,
            updated_at_timestamp: 2,
          },
        ],
      })
      .getMessagesList()

    expect(message.getReplaceabilityIdentifier()).toEqual('')
  })

  it('maps shared vaults', () => {
    const [sharedVault] = createMapper()
      .toProjection({
        ...emptyResponse(),
        shared_vaults: [
          {
            uuid: 'shared-vault-uuid',
            user_uuid: 'user-uuid',
            file_upload_bytes_used: 1024,
            created_at_timestamp: 1,
            updated_at_timestamp: 2,
          },
        ],
      })
      .getSharedVaultsList()

    expect(sharedVault.getUuid()).toEqual('shared-vault-uuid')
    expect(sharedVault.getUserUuid()).toEqual('user-uuid')
    expect(sharedVault.getFileUploadBytesUsed()).toEqual(1024)
    expect(sharedVault.getCreatedAtTimestamp()).toEqual(1)
    expect(sharedVault.getUpdatedAtTimestamp()).toEqual(2)
  })

  it('maps shared vault invites', () => {
    const [invite] = createMapper()
      .toProjection({
        ...emptyResponse(),
        shared_vault_invites: [
          {
            uuid: 'invite-uuid',
            shared_vault_uuid: 'shared-vault-uuid',
            user_uuid: 'user-uuid',
            sender_uuid: 'sender-uuid',
            encrypted_message: 'encrypted-message',
            permission: 'write',
            created_at_timestamp: 1,
            updated_at_timestamp: 2,
          },
        ],
      })
      .getSharedVaultInvitesList()

    expect(invite.getUuid()).toEqual('invite-uuid')
    expect(invite.getSharedVaultUuid()).toEqual('shared-vault-uuid')
    expect(invite.getUserUuid()).toEqual('user-uuid')
    expect(invite.getSenderUuid()).toEqual('sender-uuid')
    expect(invite.getEncryptedMessage()).toEqual('encrypted-message')
    expect(invite.getPermission()).toEqual('write')
    expect(invite.getCreatedAtTimestamp()).toEqual(1)
    expect(invite.getUpdatedAtTimestamp()).toEqual(2)
  })

  it('maps notifications', () => {
    const [notification] = createMapper()
      .toProjection({
        ...emptyResponse(),
        notifications: [
          {
            uuid: 'notification-uuid',
            user_uuid: 'user-uuid',
            type: 'SHARED_VAULT_ITEM_REMOVED',
            payload: 'payload',
            created_at_timestamp: 1,
            updated_at_timestamp: 2,
          },
        ],
      })
      .getNotificationsList()

    expect(notification.getUuid()).toEqual('notification-uuid')
    expect(notification.getUserUuid()).toEqual('user-uuid')
    expect(notification.getType()).toEqual('SHARED_VAULT_ITEM_REMOVED')
    expect(notification.getPayload()).toEqual('payload')
    expect(notification.getCreatedAtTimestamp()).toEqual(1)
    expect(notification.getUpdatedAtTimestamp()).toEqual(2)
  })

  it('maps every collection of a populated response at once', () => {
    const projection = createMapper().toProjection({
      ...emptyResponse(),
      retrieved_items: [fullItem, bareItem],
      saved_items: [fullSavedItem],
      conflicts: [{ type: ConflictType.ConflictingData, server_item: fullItem, unsaved_item: fullItemHash }],
    })

    expect(projection.getRetrievedItemsList()).toHaveLength(2)
    expect(projection.getSavedItemsList()).toHaveLength(1)
    expect(projection.getConflictsList()).toHaveLength(1)
    expect(projection.getConflictsList()[0].getServerItem()?.getUuid()).toEqual('item-uuid')
    expect(projection.getConflictsList()[0].getUnsavedItem()?.getUuid()).toEqual('hash-uuid')
  })

  it('refuses to map a gRPC response back to the domain', () => {
    expect(() => createMapper().toDomain({} as never)).toThrow('Method not implemented.')
  })
})
