import { TimerInterface } from '@standardnotes/time'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../../../Item/ItemTransferCalculatorInterface'
import { GetItems } from './GetItems'
import { Item } from '../../../Item/Item'
import { ContentType, Dates, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { ItemContentSizeDescriptor } from '../../../Item/ItemContentSizeDescriptor'
import { ItemQuery } from '../../../Item/ItemQuery'

describe('GetItems', () => {
  let itemRepository: ItemRepositoryInterface
  const contentSizeTransferLimit = 100
  let itemTransferCalculator: ItemTransferCalculatorInterface
  let timer: TimerInterface
  const maxItemsSyncLimit = 100
  let item: Item
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface
  const itemUuid = '11111111-1111-1111-1111-111111111111'

  const cursorToken = (timestamp: number, uuid: string) =>
    Buffer.from(`3:${timestamp}:${uuid}`, 'utf-8').toString('base64')

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
    item = Item.create(
      {
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
      },
      new UniqueEntityId(itemUuid),
    ).getValue()

    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findAll = jest.fn().mockResolvedValue([item])
    itemRepository.countAll = jest.fn().mockResolvedValue(1)
    itemRepository.findContentSizeForComputingTransferLimit = jest
      .fn()
      .mockResolvedValue([ItemContentSizeDescriptor.create(itemUuid, 20).getValue()])

    itemTransferCalculator = {} as jest.Mocked<ItemTransferCalculatorInterface>
    itemTransferCalculator.computeItemUuidsToFetch = jest
      .fn()
      .mockResolvedValue({ uuids: [itemUuid], transferLimitBreachedBeforeEndOfItems: false })

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
      cursorToken: cursorToken(123, itemUuid),
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
      cursorToken: Buffer.from('2:0.000123', 'utf-8').toString('base64'),
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      items: [item],
      cursorToken: undefined,
      lastSyncTime: 123,
    })
    const itemQuery = (itemRepository.findContentSizeForComputingTransferLimit as jest.Mock).mock.calls[0][0]
    expect(itemQuery.syncTimeComparison).toBe('>=')
    expect(itemQuery.lastSyncUuid).toBeUndefined()
  })

  it('decodes a v3 composite cursor into an exclusive timestamp and UUID keyset', async () => {
    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: cursorToken(123, itemUuid),
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeFalsy()
    const itemQuery = (itemRepository.findContentSizeForComputingTransferLimit as jest.Mock).mock.calls[0][0]
    expect(itemQuery).toEqual(
      expect.objectContaining({
        lastSyncTime: 123,
        lastSyncUuid: itemUuid,
        syncTimeComparison: '>',
        sortBy: 'updated_at_timestamp',
        sortOrder: 'ASC',
      }),
    )
  })

  it('rejects a malformed v3 cursor', async () => {
    const malformed = Buffer.from('3:123:not-a-uuid', 'utf-8').toString('base64')

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      cursorToken: malformed,
      contentType: undefined,
      limit: undefined,
    })

    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toBe('Sync cursor is malformed')
    expect(itemRepository.findContentSizeForComputingTransferLimit).not.toHaveBeenCalled()
  })

  it('terminates and returns every item once when more than 150 items share one timestamp', async () => {
    const timestamp = 9_876_543
    const items = Array.from({ length: 301 }, (_, index) => {
      const uuid = `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`
      return Item.create(
        {
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
          timestamps: Timestamps.create(123, timestamp).getValue(),
        },
        new UniqueEntityId(uuid),
      ).getValue()
    })

    const matchingItems = (query: ItemQuery, applyLimit: boolean): Item[] => {
      const filtered = items.filter((candidate) => {
        if (query.lastSyncTime === undefined) {
          return true
        }
        const updatedAt = candidate.props.timestamps.updatedAt
        if (query.lastSyncUuid !== undefined) {
          return (
            updatedAt > query.lastSyncTime ||
            (updatedAt === query.lastSyncTime && candidate.id.toString() > query.lastSyncUuid)
          )
        }
        return query.syncTimeComparison === '>=' ? updatedAt >= query.lastSyncTime : updatedAt > query.lastSyncTime
      })
      filtered.sort(
        (left, right) =>
          left.props.timestamps.updatedAt - right.props.timestamps.updatedAt ||
          left.id.toString().localeCompare(right.id.toString()),
      )
      return applyLimit && query.limit !== undefined ? filtered.slice(0, query.limit) : filtered
    }

    const boundaryRepository = {
      findContentSizeForComputingTransferLimit: jest.fn(async (query: ItemQuery) =>
        matchingItems(query, true).map((candidate) =>
          ItemContentSizeDescriptor.create(candidate.id.toString(), 1).getValue(),
        ),
      ),
      findAll: jest.fn(async (query: ItemQuery) => {
        const requested = new Set(query.uuids ?? [])
        return items
          .filter((candidate) => requested.has(candidate.id.toString()))
          .sort(
            (left, right) =>
              left.props.timestamps.updatedAt - right.props.timestamps.updatedAt ||
              left.id.toString().localeCompare(right.id.toString()),
          )
      }),
      countAll: jest.fn(async (query: ItemQuery) => matchingItems(query, false).length),
    } as unknown as ItemRepositoryInterface
    const noByteLimitCalculator = {
      computeItemUuidsToFetch: jest.fn(async (descriptors: ItemContentSizeDescriptor[]) => ({
        uuids: descriptors.map((descriptor) => descriptor.props.uuid.value),
        transferLimitBreachedBeforeEndOfItems: false,
      })),
    } as unknown as ItemTransferCalculatorInterface
    const useCase = new GetItems(
      boundaryRepository,
      sharedVaultUserRepository,
      Number.MAX_SAFE_INTEGER,
      noByteLimitCalculator,
      timer,
      150,
    )

    const received: string[] = []
    let nextCursor: string | undefined
    let pageCount = 0
    do {
      const result = await useCase.execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        cursorToken: nextCursor,
        contentType: undefined,
        limit: 150,
      })
      expect(result.isFailed()).toBeFalsy()
      const page = result.getValue()
      received.push(...page.items.map((candidate) => candidate.id.toString()))
      nextCursor = page.cursorToken
      pageCount += 1
      expect(pageCount).toBeLessThanOrEqual(3)
    } while (nextCursor)

    expect(pageCount).toBe(3)
    expect(received).toHaveLength(301)
    expect(new Set(received).size).toBe(301)
    expect(received).toEqual(items.map((candidate) => candidate.id.toString()))
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
      // shadowBannedMaxItemsSyncLimit
      2,
      // shadowBannedContentSizeTransferLimit
      30,
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
