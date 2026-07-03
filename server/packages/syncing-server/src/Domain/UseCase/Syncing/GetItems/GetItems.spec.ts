import { TimerInterface } from '@standardnotes/time'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../../../Item/ItemTransferCalculatorInterface'
import { GetItems } from './GetItems'
import { Item } from '../../../Item/Item'
import { ContentType, Dates, Timestamps, Uuid } from '@standardnotes/domain-core'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { ItemContentSizeDescriptor } from '../../../Item/ItemContentSizeDescriptor'

describe('GetItems', () => {
  let itemRepository: ItemRepositoryInterface
  const contentSizeTransferLimit = 100
  let itemTransferCalculator: ItemTransferCalculatorInterface
  let timer: TimerInterface
  const maxItemsSyncLimit = 100
  let item: Item
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface

  const createUseCase = () =>
    new GetItems(
      itemRepository,
      sharedVaultUserRepository,
      contentSizeTransferLimit,
      itemTransferCalculator,
      timer,
      maxItemsSyncLimit,
    )

  beforeEach(() => {
    item = Item.create({
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

    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findAll = jest.fn().mockResolvedValue([item])
    itemRepository.countAll = jest.fn().mockResolvedValue(1)
    itemRepository.findContentSizeForComputingTransferLimit = jest
      .fn()
      .mockResolvedValue([ItemContentSizeDescriptor.create('00000000-0000-0000-0000-000000000000', 20).getValue()])

    itemTransferCalculator = {} as jest.Mocked<ItemTransferCalculatorInterface>
    itemTransferCalculator.computeItemUuidsToFetch = jest
      .fn()
      .mockResolvedValue({ uuids: ['item-uuid'], transferLimitBreachedBeforeEndOfItems: false })

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(123)
    timer.convertStringDateToMicroseconds = jest.fn().mockReturnValue(123)

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuid = jest.fn().mockResolvedValue([])
  })

  it('returns items', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: 10,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: undefined,
      lastSyncTime: null,
    })
  })

  it('should return cursor token if there are more items to fetch', async () => {
    itemRepository.countAll = jest.fn().mockResolvedValue(101)

    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: 'MjowLjAwMDEyMw==',
      lastSyncTime: null,
    })
  })

  it('does not dereference an empty result set when the more-items flag is set', async () => {
    // Reachable when descriptor rows are hard-deleted between the transfer-limit
    // computation and findAll: uuids resolve to nothing, yet countAll still
    // reports more items. The old code did items[items.length - 1].props and
    // threw, failing the whole sync. Now it must return no cursor and not throw.
    itemTransferCalculator.computeItemUuidsToFetch = jest
      .fn()
      .mockResolvedValue({ uuids: [], transferLimitBreachedBeforeEndOfItems: true })
    itemRepository.findAll = jest.fn().mockResolvedValue([])
    itemRepository.countAll = jest.fn().mockResolvedValue(101)

    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [],
      cursorToken: undefined,
      lastSyncTime: null,
    })
  })

  it('should return items based on the cursort token passed', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: 'MjowLjAwMDEyMw==',
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: undefined,
      lastSyncTime: 123.00000000000001,
    })
  })

  it('should return items based on a sync token containing string date', async () => {
    const useCase = createUseCase()

    const syncTokenData = '1:2021-01-01T00:00:00.000Z'
    const syncToken = Buffer.from(syncTokenData, 'utf-8').toString('base64')

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      syncToken,
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: undefined,
      lastSyncTime: 123,
    })
  })

  it('should return error if the sync token is invalid', async () => {
    const useCase = createUseCase()

    const syncTokenData = 'invalid'
    const syncToken = Buffer.from(syncTokenData, 'utf-8').toString('base64')

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      syncToken,
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toEqual('Sync token is missing version part')
  })

  it('should guard the upper bound limit of items to fetch', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: 200,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: undefined,
      lastSyncTime: null,
    })
  })

  it('silently reduces page size and content-transfer allowance for a shadow-banned user', async () => {
    // Shadow caps smaller than the normal limits (100 / 100).
    const useCase = new GetItems(
      itemRepository,
      sharedVaultUserRepository,
      contentSizeTransferLimit,
      itemTransferCalculator,
      timer,
      maxItemsSyncLimit,
      2, // shadowBannedMaxItemsSyncLimit
      30, // shadowBannedContentSizeTransferLimit
    )

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: 50,
      shadowBanned: true,
    })

    expect(result.isFailed()).toBeFalsy()
    // Page size clamped to the shadow cap (2), not the requested 50.
    const itemQuery = (itemRepository.findContentSizeForComputingTransferLimit as jest.Mock).mock.calls[0][0]
    expect(itemQuery.limit).toBe(2)
    // Content-transfer allowance clamped to the shadow cap (30), not 100.
    expect((itemTransferCalculator.computeItemUuidsToFetch as jest.Mock).mock.calls[0][1]).toBe(30)
  })

  it('does NOT reduce limits for a normal (non-shadow-banned) user', async () => {
    const useCase = new GetItems(
      itemRepository,
      sharedVaultUserRepository,
      contentSizeTransferLimit,
      itemTransferCalculator,
      timer,
      maxItemsSyncLimit,
      2,
      30,
    )

    await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: 50,
      shadowBanned: false,
    })

    const itemQuery = (itemRepository.findContentSizeForComputingTransferLimit as jest.Mock).mock.calls[0][0]
    expect(itemQuery.limit).toBe(50)
    expect((itemTransferCalculator.computeItemUuidsToFetch as jest.Mock).mock.calls[0][1]).toBe(100)
  })

  it('should return error for invalid user uuid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: 'invalid',
      cursorToken: undefined,
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toEqual('User uuid is invalid: Given value is not a valid uuid: invalid')
  })

  it('should filter shared vault uuids user wants to sync with the ones it has access to', async () => {
    sharedVaultUserRepository.findByUserUuid = jest.fn().mockResolvedValue([
      {
        props: {
          sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
        },
      },
    ])

    const useCase = createUseCase()

    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: undefined,
      contentType: undefined,
      limit: undefined,
      sharedVaultUuids: ['00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111'],
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: undefined,
      lastSyncTime: null,
    })
  })
})
