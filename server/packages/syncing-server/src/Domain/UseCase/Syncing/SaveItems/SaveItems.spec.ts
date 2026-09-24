import { TimerInterface } from '@standardnotes/time'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemSaveValidatorInterface } from '../../../Item/SaveValidator/ItemSaveValidatorInterface'
import {
  SaveItems,
  WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT,
  WEBSOCKET_SYNC_PUSH_MAX_ITEMS_DEFAULT,
  parseWebsocketSyncPushEnabled,
  parseWebsocketSyncPushMaxBytes,
  parseWebsocketSyncPushMaxItems,
} from './SaveItems'
import { SaveNewItem } from '../SaveNewItem/SaveNewItem'
import { UpdateExistingItem } from '../UpdateExistingItem/UpdateExistingItem'
import { Logger } from 'winston'
import { ContentType, Dates, MapperInterface, Result, Timestamps, Uuid } from '@standardnotes/domain-core'
import { ItemHash } from '../../../Item/ItemHash'
import { Item } from '../../../Item/Item'
import { SendEventToClient } from '../SendEventToClient/SendEventToClient'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { ItemsChangedOnServerEvent } from '@standardnotes/domain-events'
import { SendEventToClients } from '../SendEventToClients/SendEventToClients'
import { SharedVaultAssociation } from '../../../SharedVault/SharedVaultAssociation'
import { CheckForContentLimit } from '../CheckForContentLimit/CheckForContentLimit'
import { ItemHttpRepresentation } from '../../../../Mapping/Http/ItemHttpRepresentation'
import { ConcurrentItemUpdateError } from '../../../Item/ConcurrentItemUpdateError'

describe('SaveItems', () => {
  let itemSaveValidator: ItemSaveValidatorInterface
  let itemRepository: ItemRepositoryInterface
  let timer: TimerInterface
  let saveNewItem: SaveNewItem
  let updateExistingItem: UpdateExistingItem
  let logger: Logger
  let itemHash1: ItemHash
  let savedItem: Item
  let sendEventToClient: SendEventToClient
  let sendEventToClients: SendEventToClients
  let domainEventFactory: DomainEventFactoryInterface
  let checkForContentLimit: CheckForContentLimit
  let itemHttpMapper: MapperInterface<Item, ItemHttpRepresentation>
  let websocketSyncPushEnabled: boolean
  let websocketSyncPushMaxItems: number
  let websocketSyncPushMaxBytes: number

  const createUseCase = () =>
    new SaveItems(
      itemSaveValidator,
      itemRepository,
      timer,
      saveNewItem,
      updateExistingItem,
      sendEventToClient,
      sendEventToClients,
      domainEventFactory,
      checkForContentLimit,
      itemHttpMapper,
      websocketSyncPushEnabled,
      websocketSyncPushMaxItems,
      websocketSyncPushMaxBytes,
      logger,
    )

  beforeEach(() => {
    checkForContentLimit = {} as jest.Mocked<CheckForContentLimit>
    checkForContentLimit.execute = jest.fn().mockResolvedValue(Result.ok())

    sendEventToClient = {} as jest.Mocked<SendEventToClient>
    sendEventToClient.execute = jest.fn().mockReturnValue(Result.ok())

    sendEventToClients = {} as jest.Mocked<SendEventToClients>
    sendEventToClients.execute = jest.fn().mockReturnValue(Result.ok())

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createItemsChangedOnServerEvent = jest.fn().mockReturnValue({
      type: 'ITEMS_CHANGED_ON_SERVER',
      createdAt: new Date(1),
      meta: { correlation: { userIdentifier: 'user-uuid', userIdentifierType: 'uuid' }, origin: 'syncing-server' },
      payload: {},
    } as unknown as jest.Mocked<ItemsChangedOnServerEvent>)

    itemHttpMapper = {} as jest.Mocked<MapperInterface<Item, ItemHttpRepresentation>>
    itemHttpMapper.toProjection = jest.fn().mockReturnValue({ uuid: 'projected', content: 'enc' })

    // Most cases here exercise the inlining branch explicitly, so turn it on
    // with generous ceilings; the production default (off) has its own test.
    websocketSyncPushEnabled = true
    websocketSyncPushMaxItems = 50
    websocketSyncPushMaxBytes = WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT

    itemSaveValidator = {} as jest.Mocked<ItemSaveValidatorInterface>
    itemSaveValidator.validate = jest.fn().mockResolvedValue({ passed: true })

    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findByUuid = jest.fn().mockResolvedValue(null)

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(123)

    savedItem = Item.create({
      duplicateOf: null,
      itemsKeyId: 'items-key-id',
      content: 'content',
      contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
      encItemKey: 'enc-item-key',
      authHash: 'auth-hash',
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      deleted: false,
      updatedWithSession: null,
      dates: Dates.create(new Date(123), new Date(123)).getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    saveNewItem = {} as jest.Mocked<SaveNewItem>
    saveNewItem.execute = jest.fn().mockReturnValue(Result.ok(savedItem))

    updateExistingItem = {} as jest.Mocked<UpdateExistingItem>
    updateExistingItem.execute = jest.fn().mockResolvedValue(Result.ok(savedItem))

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()
    logger.warn = jest.fn()

    itemHash1 = ItemHash.create({
      uuid: '00000000-0000-0000-0000-000000000000',
      user_uuid: 'user-uuid',
      content: 'content',
      content_type: ContentType.TYPES.Note,
      deleted: false,
      auth_hash: 'auth-hash',
      enc_item_key: 'enc-item-key',
      items_key_id: 'items-key-id',
      key_system_identifier: null,
      shared_vault_uuid: null,
      created_at: '2020-01-01T00:00:00.000Z',
      created_at_timestamp: 123,
      updated_at: '2020-01-01T00:00:00.000Z',
      updated_at_timestamp: 123,
    }).getValue()
  })

  it('should save new items', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().syncToken).toEqual('MjowLjAwMDEyNA==')
    expect(saveNewItem.execute).toHaveBeenCalledWith({
      itemHash: itemHash1,
      userUuid: 'user-uuid',
      sessionUuid: 'session-uuid',
    })
    expect(sendEventToClient.execute).toHaveBeenCalled()
  })

  it('should skip the personal realtime push when live-sync is disabled but still save', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: false,
    })

    expect(result.isFailed()).toBeFalsy()
    // The save itself must still succeed; only the realtime push is suppressed.
    expect(saveNewItem.execute).toHaveBeenCalled()
    expect(sendEventToClient.execute).not.toHaveBeenCalled()
  })

  /**
   * Standard Red Notes (t97): this is a STRUCTURAL validation failure inside
   * SaveNewItem itself, not the infrastructure catch below and not OwnershipFilter's
   * genuine uuid collision -- it must never regenerate the item's uuid
   * (ConflictType.UuidConflict is destructive on the client). itemHash1's content_type
   * is valid Note, so the item's data is malformed in some OTHER way -- the generic
   * ContentError, matching ContentFilter's role, not the more specific ContentTypeError.
   */
  it('reports a structural new-item failure as ContentError when the content_type itself is valid', async () => {
    const useCase = createUseCase()

    saveNewItem.execute = jest.fn().mockResolvedValue(Result.fail('error'))

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().conflicts).toEqual([
      {
        unsavedItem: itemHash1,
        type: 'content_error',
      },
    ])
    expect(sendEventToClient.execute).not.toHaveBeenCalled()
  })

  /**
   * Standard Red Notes (t97): same structural-failure case as above, but the item
   * hash's OWN content_type field is itself unparsable -- reuses the exact check
   * ContentTypeFilter already runs, so this must resolve to the more specific
   * ContentTypeError rather than the generic ContentError.
   */
  it('reports a structural new-item failure as ContentTypeError when the content_type itself is malformed', async () => {
    const useCase = createUseCase()

    saveNewItem.execute = jest.fn().mockResolvedValue(Result.fail('error'))

    const malformedContentTypeHash = ItemHash.create({
      ...itemHash1.props,
      content_type: 'NotARealContentType',
    }).getValue()

    const result = await useCase.execute({
      itemHashes: [malformedContentTypeHash],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().conflicts).toEqual([
      {
        unsavedItem: malformedContentTypeHash,
        type: 'content_type_error',
      },
    ])
  })

  /**
   * Standard Red Notes (t97): a thrown, unclassified error here is an infrastructure
   * fault (DB connection, timeout -- exactly the shape the now-fixed AppDataSource
   * uncached-getter bug produced), not a uuid identity conflict. Reporting it as
   * ConflictType.UuidConflict used to be destructive on the client:
   * PayloadsByAlternatingUuid treats UuidConflict as authoritative and unconditionally
   * discards the item's original uuid, regenerating a new one -- so a transient
   * database hiccup on an ordinary save could make a healthy note the user was
   * actively editing vanish out from under them for no reason connected to anything
   * they did. The item must instead be left unacknowledged (neither saved nor
   * conflicted) so it stays dirty and the client's next regular sync retries it.
   */
  it('leaves the item unacknowledged (not a conflict) when saving a new item throws an unclassified error', async () => {
    const useCase = createUseCase()

    saveNewItem.execute = jest.fn().mockRejectedValue(new Error('error'))

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([])
    expect(result.getValue().conflicts).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Saving item'),
      expect.objectContaining({ errorType: 'Error' }),
    )
  })

  it('leaves the item unacknowledged (not a conflict) when updating an existing item throws an unclassified error', async () => {
    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockRejectedValue(new Error('update blew up'))

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([])
    expect(result.getValue().conflicts).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Updating item'),
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('update blew up')
  })

  /**
   * Standard Red Notes (t97): the ONE place in this codebase that reliably knows a
   * uuid genuinely belongs to a different account is OwnershipFilter, reached through
   * itemSaveValidator.validate BEFORE either try/catch above ever runs. That path is
   * untouched by the t97 fix -- a real collision must still surface as UuidConflict so
   * the client's uuid-regeneration recovery still fires for the case it exists for.
   */
  it('still reports a genuine cross-account uuid collision (surfaced by the validator) as UuidConflict', async () => {
    const useCase = createUseCase()

    const collisionConflict = {
      unsavedItem: itemHash1,
      type: 'uuid_conflict',
    }
    itemSaveValidator.validate = jest.fn().mockResolvedValue({ passed: false, conflict: collisionConflict })

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([])
    expect(result.getValue().conflicts).toEqual([collisionConflict])
    // Neither execute call ran: the collision was decided before either branch, so
    // this is the validator's verdict passing through, not the try/catch path.
    expect(saveNewItem.execute).not.toHaveBeenCalled()
    expect(updateExistingItem.execute).not.toHaveBeenCalled()
  })

  it('returns the persisted winner as a sync conflict when a concurrent update loses', async () => {
    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockRejectedValue(new ConcurrentItemUpdateError(savedItem))

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([])
    expect(result.getValue().conflicts).toEqual([
      {
        unsavedItem: itemHash1,
        serverItem: savedItem,
        type: 'sync_conflict',
      },
    ])
    expect(sendEventToClient.execute).not.toHaveBeenCalled()
    expect(sendEventToClients.execute).not.toHaveBeenCalled()
  })

  it('should still report the save as successful when post-persist notification throws', async () => {
    // The items are already durably persisted at this point; a Redis/publish blip
    // must not turn a successful save into a failed sync request.
    const useCase = createUseCase()

    domainEventFactory.createItemsChangedOnServerEvent = jest.fn().mockImplementation(() => {
      throw new Error('publish blip')
    })

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([savedItem])
    expect(result.getValue().conflicts).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Notifying other clients of changed items failed post-persist'),
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('publish blip')
  })

  it('should not save items if in read-only mode', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: true,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(saveNewItem.execute).not.toHaveBeenCalled()
  })

  it('should return conflicts if the items have not passed validation', async () => {
    const useCase = createUseCase()

    const conflict = {
      unsavedItem: itemHash1,
      type: 'conflict-type',
    }
    itemSaveValidator.validate = jest.fn().mockResolvedValue({ passed: false, conflict })

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().conflicts).toEqual([conflict])
  })

  it('should mark items as saved if they are skipped on validation', async () => {
    const useCase = createUseCase()

    itemSaveValidator.validate = jest.fn().mockResolvedValue({ passed: false, skipped: savedItem })

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([savedItem])
  })

  it('should update existing items', async () => {
    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: '00000000-0000-0000-0000-000000000000',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(updateExistingItem.execute).toHaveBeenCalledWith({
      isFreeUser: false,
      itemHash: itemHash1,
      existingItem: savedItem,
      sessionUuid: 'session-uuid',
      performingUserUuid: '00000000-0000-0000-0000-000000000000',
    })
    expect(sendEventToClient.execute).toHaveBeenCalled()
    expect(sendEventToClients.execute).not.toHaveBeenCalled()
  })

  it('should log, but not fail the save, when the personal realtime push cannot be delivered', async () => {
    sendEventToClient.execute = jest.fn().mockReturnValue(Result.fail('websocket gateway unreachable'))

    const result = await createUseCase().execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().savedItems).toEqual([savedItem])
    expect(logger.error).toHaveBeenCalledWith(
      'Sending items changed event to client failed.',
      expect.objectContaining({
        errorType: 'Error',
        userId: 'user-uuid',
      }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('websocket gateway unreachable')
  })

  it('should log, but not fail the save, when the shared vault fan-out cannot be delivered', async () => {
    savedItem = Item.create({
      duplicateOf: null,
      itemsKeyId: 'items-key-id',
      content: 'content',
      contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
      encItemKey: 'enc-item-key',
      authHash: 'auth-hash',
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      deleted: false,
      updatedWithSession: null,
      sharedVaultAssociation: SharedVaultAssociation.create({
        sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000001').getValue(),
        lastEditedBy: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      }).getValue(),
      dates: Dates.create(new Date(123), new Date(123)).getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockResolvedValue(Result.ok(savedItem))
    sendEventToClients.execute = jest.fn().mockReturnValue(Result.fail('shared vault gateway unreachable'))

    const result = await createUseCase().execute({
      itemHashes: [itemHash1],
      userUuid: '00000000-0000-0000-0000-000000000000',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(sendEventToClients.execute).toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'Sending items changed event to clients failed.',
      expect.objectContaining({
        errorType: 'Error',
        userId: '00000000-0000-0000-0000-000000000000',
        sharedVaultUuid: '00000000-0000-0000-0000-000000000001',
      }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('shared vault gateway unreachable')
  })

  it('should update existing shared vault items', async () => {
    savedItem = Item.create({
      duplicateOf: null,
      itemsKeyId: 'items-key-id',
      content: 'content',
      contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
      encItemKey: 'enc-item-key',
      authHash: 'auth-hash',
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      deleted: false,
      updatedWithSession: null,
      sharedVaultAssociation: SharedVaultAssociation.create({
        sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000001').getValue(),
        lastEditedBy: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      }).getValue(),
      dates: Dates.create(new Date(123), new Date(123)).getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockResolvedValue(Result.ok(savedItem))

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: '00000000-0000-0000-0000-000000000000',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(updateExistingItem.execute).toHaveBeenCalledWith({
      isFreeUser: false,
      itemHash: itemHash1,
      existingItem: savedItem,
      sessionUuid: 'session-uuid',
      performingUserUuid: '00000000-0000-0000-0000-000000000000',
    })
    expect(sendEventToClient.execute).toHaveBeenCalled()
    expect(sendEventToClients.execute).toHaveBeenCalled()
  })

  /**
   * Standard Red Notes (t97): same reasoning as the new-item case above, for the
   * existing-item structural-failure branch. itemHash1's content_type is valid, so
   * this resolves to the generic ContentError, not UuidConflict (which would
   * regenerate the item's identity and discard the original over a malformed field).
   */
  it('reports a structural existing-item failure as ContentError when the content_type itself is valid', async () => {
    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockResolvedValue(Result.fail('error'))

    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().conflicts).toEqual([
      {
        unsavedItem: itemHash1,
        type: 'content_error',
      },
    ])
  })

  it('reports a structural existing-item failure as ContentTypeError when the content_type itself is malformed', async () => {
    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockResolvedValue(Result.fail('error'))

    const malformedContentTypeHash = ItemHash.create({
      ...itemHash1.props,
      content_type: 'NotARealContentType',
    }).getValue()

    const result = await useCase.execute({
      itemHashes: [malformedContentTypeHash],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().conflicts).toEqual([
      {
        unsavedItem: malformedContentTypeHash,
        type: 'content_type_error',
      },
    ])
  })

  it('should mark items as conflict if the item uuid is invalid', async () => {
    const useCase = createUseCase()

    itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
    updateExistingItem.execute = jest.fn().mockResolvedValue(Result.fail('error'))

    const result = await useCase.execute({
      itemHashes: [ItemHash.create({ ...itemHash1.props, uuid: 'invalid-uuid' }).getValue()],
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().conflicts).toEqual([
      {
        unsavedItem: ItemHash.create({ ...itemHash1.props, uuid: 'invalid-uuid' }).getValue(),
        type: 'uuid_conflict',
      },
    ])
  })

  it('should calculate the sync token based on existing and new items saved', async () => {
    const useCase = createUseCase()

    saveNewItem.execute = jest
      .fn()
      .mockResolvedValueOnce(Result.ok(savedItem))
      .mockResolvedValueOnce(
        Result.ok(
          Item.create({
            ...savedItem.props,
            timestamps: Timestamps.create(100, 100).getValue(),
          }).getValue(),
        ),
      )
      .mockResolvedValueOnce(
        Result.ok(
          Item.create({
            ...savedItem.props,
            timestamps: Timestamps.create(159, 159).getValue(),
          }).getValue(),
        ),
      )

    const result = await useCase.execute({
      itemHashes: [
        itemHash1,
        ItemHash.create({ ...itemHash1.props, uuid: '00000000-0000-0000-0000-000000000002' }).getValue(),
        ItemHash.create({ ...itemHash1.props, uuid: '00000000-0000-0000-0000-000000000003' }).getValue(),
      ],
      userUuid: 'user-uuid',
      apiVersion: '2',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue().syncToken).toEqual('MjowLjAwMDE2')
  })

  it('should succeed if a free user has no content limit', async () => {
    checkForContentLimit.execute = jest.fn().mockResolvedValue(Result.fail('exceeded'))

    const useCase = createUseCase()
    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: '00000000-0000-0000-0000-000000000000',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: true,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
  })

  it('should return a failure result if a free user has exceeded their content limit', async () => {
    checkForContentLimit.execute = jest.fn().mockResolvedValue(Result.fail('exceeded'))

    const useCase = createUseCase()
    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: '00000000-0000-0000-0000-000000000000',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: true,
      hasContentLimit: true,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should succeed if a free user has not exceeded their content limit', async () => {
    checkForContentLimit.execute = jest.fn().mockResolvedValue(Result.ok())

    const useCase = createUseCase()
    const result = await useCase.execute({
      itemHashes: [itemHash1],
      userUuid: '00000000-0000-0000-0000-000000000000',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: true,
      hasContentLimit: false,
      liveSyncEnabled: true,
    })

    expect(result.isFailed()).toBeFalsy()
  })

  describe('websocket sync push fast path', () => {
    const baseDto = {
      userUuid: 'user-uuid',
      apiVersion: '1',
      readOnlyAccess: false,
      sessionUuid: 'session-uuid',
      snjsVersion: '2.200.0',
      isFreeUser: false,
      hasContentLimit: false,
      liveSyncEnabled: true,
    }

    it('pushes a SYNC_ITEMS_PUSHED message with encrypted payloads and tokens when enabled and small', async () => {
      websocketSyncPushEnabled = true
      // Item saved with a newer updatedAt than the pre-save timestamp (the
      // realistic case), so the post-change token advances past the base token.
      const newerItem = Item.create({
        ...savedItem.props,
        timestamps: Timestamps.create(500, 500).getValue(),
      }).getValue()
      saveNewItem.execute = jest.fn().mockReturnValue(Result.ok(newerItem))
      const useCase = createUseCase()

      const result = await useCase.execute({ ...baseDto, itemHashes: [itemHash1] })

      expect(result.isFailed()).toBeFalsy()
      expect(itemHttpMapper.toProjection).toHaveBeenCalledWith(newerItem)
      expect(sendEventToClient.execute).toHaveBeenCalledTimes(1)
      const event = (sendEventToClient.execute as jest.Mock).mock.calls[0][0].event
      expect(event.type).toEqual('SYNC_ITEMS_PUSHED')
      expect(event.payload.syncToken).toEqual(result.getValue().syncToken)
      // base token is the pre-save server state and must differ from the
      // post-change token whenever the save advanced the latest-updated time.
      expect(event.payload.baseSyncToken).not.toEqual(event.payload.syncToken)
      expect(event.payload.items).toEqual([{ uuid: 'projected', content: 'enc' }])
    })

    it('falls back to the plain notification when the change set exceeds the size threshold', async () => {
      websocketSyncPushMaxItems = 1
      const useCase = createUseCase()

      const itemHash2 = ItemHash.create({
        ...itemHash1.props,
        uuid: '00000000-0000-0000-0000-000000000009',
      }).getValue()

      const result = await useCase.execute({ ...baseDto, itemHashes: [itemHash1, itemHash2] })

      expect(result.isFailed()).toBeFalsy()
      expect(itemHttpMapper.toProjection).not.toHaveBeenCalled()
      const event = (sendEventToClient.execute as jest.Mock).mock.calls[0][0].event
      expect(event.type).toEqual('ITEMS_CHANGED_ON_SERVER')
      expect(event.payload.items).toBeUndefined()
    })

    it('falls back to the plain notification when the push optimization is disabled', async () => {
      websocketSyncPushEnabled = false
      const useCase = createUseCase()

      const result = await useCase.execute({ ...baseDto, itemHashes: [itemHash1] })

      expect(result.isFailed()).toBeFalsy()
      expect(itemHttpMapper.toProjection).not.toHaveBeenCalled()
      const event = (sendEventToClient.execute as jest.Mock).mock.calls[0][0].event
      expect(event.type).toEqual('ITEMS_CHANGED_ON_SERVER')
    })

    it('never pushes payloads across users for shared-vault items (plain notification only)', async () => {
      savedItem = Item.create({
        ...savedItem.props,
        sharedVaultAssociation: SharedVaultAssociation.create({
          sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000001').getValue(),
          lastEditedBy: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
        }).getValue(),
      }).getValue()
      itemRepository.findByUuid = jest.fn().mockResolvedValue(savedItem)
      updateExistingItem.execute = jest.fn().mockResolvedValue(Result.ok(savedItem))

      const useCase = createUseCase()
      await useCase.execute({ ...baseDto, userUuid: '00000000-0000-0000-0000-000000000000', itemHashes: [itemHash1] })

      // shared-vault fan-out (sendEventToClients) always carries the plain notification
      const sharedEvent = (sendEventToClients.execute as jest.Mock).mock.calls[0][0].event
      expect(sharedEvent.type).toEqual('ITEMS_CHANGED_ON_SERVER')
    })

    it('leaves inlining off under the default configuration: a 1-item save publishes the plain notification', async () => {
      // WEBSOCKET_SYNC_PUSH_ENABLED unset (the shipped default, t92 decision (i)).
      websocketSyncPushEnabled = parseWebsocketSyncPushEnabled(undefined)
      const useCase = createUseCase()

      const result = await useCase.execute({ ...baseDto, itemHashes: [itemHash1] })

      expect(result.isFailed()).toBeFalsy()
      expect(sendEventToClient.execute).toHaveBeenCalledTimes(1)
      const event = (sendEventToClient.execute as jest.Mock).mock.calls[0][0].event
      expect(event.type).toEqual('ITEMS_CHANGED_ON_SERVER')
      expect(event.payload.items).toBeUndefined()
      expect(itemHttpMapper.toProjection).not.toHaveBeenCalled()
    })

    it.each<[string | undefined, boolean]>([
      ['true', true],
      ['false', false],
      ['TRUE', false],
      ['1', false],
      ['', false],
      [undefined, false],
    ])(
      'parses WEBSOCKET_SYNC_PUSH_ENABLED=%p as %p (only the exact string true enables inlining)',
      (value, expected) => {
        expect(parseWebsocketSyncPushEnabled(value)).toBe(expected)
      },
    )

    it.each<[string | undefined, number]>([
      [undefined, WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT],
      ['', WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT],
      ['0', WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT],
      ['-1', WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT],
      ['abc', WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT],
      ['1.5', WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT],
      ['4096', 4096],
    ])('parses WEBSOCKET_SYNC_PUSH_MAX_BYTES=%p as %p', (value, expected) => {
      expect(parseWebsocketSyncPushMaxBytes(value)).toBe(expected)
    })

    it('defaults the byte cap to 200 KiB and the item cap to 50, parsed with the same rules', () => {
      expect(WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT).toBe(200 * 1024)
      expect(WEBSOCKET_SYNC_PUSH_MAX_ITEMS_DEFAULT).toBe(50)
      expect(parseWebsocketSyncPushMaxItems(undefined)).toBe(50)
      expect(parseWebsocketSyncPushMaxItems('7')).toBe(7)
      expect(parseWebsocketSyncPushMaxItems('seven')).toBe(50)
      expect(parseWebsocketSyncPushMaxItems('0')).toBe(50)
    })

    it('falls back to the plain notification when the serialised projections exceed the byte cap', async () => {
      websocketSyncPushEnabled = true
      websocketSyncPushMaxBytes = 200 * 1024
      // One item whose projection alone is 200 KiB of content: under the count
      // cap, over the byte cap.
      itemHttpMapper.toProjection = jest.fn().mockReturnValue({ uuid: 'projected', content: 'x'.repeat(200 * 1024) })
      const useCase = createUseCase()

      const result = await useCase.execute({ ...baseDto, itemHashes: [itemHash1] })

      expect(result.isFailed()).toBeFalsy()
      expect(sendEventToClient.execute).toHaveBeenCalledTimes(1)
      const event = (sendEventToClient.execute as jest.Mock).mock.calls[0][0].event
      expect(event.type).toEqual('ITEMS_CHANGED_ON_SERVER')
      expect(event.payload.items).toBeUndefined()
      expect(logger.debug).toHaveBeenCalledWith(
        'Websocket sync push exceeds the byte cap; sending the plain notification instead.',
        expect.objectContaining({ userId: 'user-uuid', itemCount: 1, maxBytes: 200 * 1024 }),
      )
      const { serialisedBytes } = (logger.debug as jest.Mock).mock.calls[0][1]
      expect(serialisedBytes).toBeGreaterThan(200 * 1024)
    })

    it('still inlines payloads whose serialised size is exactly at the byte cap', async () => {
      websocketSyncPushEnabled = true
      const projection = { uuid: 'projected', content: 'enc' }
      websocketSyncPushMaxBytes = Buffer.byteLength(JSON.stringify([projection]), 'utf8')
      const useCase = createUseCase()

      await useCase.execute({ ...baseDto, itemHashes: [itemHash1] })

      const event = (sendEventToClient.execute as jest.Mock).mock.calls[0][0].event
      expect(event.type).toEqual('SYNC_ITEMS_PUSHED')
      expect(event.payload.items).toEqual([projection])
      expect(logger.debug).not.toHaveBeenCalled()
    })
  })
})
