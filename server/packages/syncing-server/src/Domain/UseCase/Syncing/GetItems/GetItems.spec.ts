import { TimerInterface } from '@standardnotes/time'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemTransferCalculatorInterface } from '../../../Item/ItemTransferCalculatorInterface'
import { GetItems } from './GetItems'
import { Item } from '../../../Item/Item'
import { ContentType, Dates, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { ItemContentSizeDescriptor } from '../../../Item/ItemContentSizeDescriptor'
import { ItemQuery } from '../../../Item/ItemQuery'
import { encodeSyncToken, scopeDigestFor, SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS } from '../SyncToken'

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
      retrievalHorizonMicroseconds: 123,
      scopeDigest: undefined,
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
      retrievalHorizonMicroseconds: 123,
      scopeDigest: undefined,
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
      retrievalHorizonMicroseconds: 123,
      scopeDigest: undefined,
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
      retrievalHorizonMicroseconds: 123,
      scopeDigest: undefined,
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
      retrievalHorizonMicroseconds: 123,
      scopeDigest: undefined,
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
      retrievalHorizonMicroseconds: 123,
      scopeDigest: undefined,
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
      retrievalHorizonMicroseconds: 123,
      // The EFFECTIVE scope, which is the one vault access was granted for —
      // the digest is over ['00000000-0000-0000-0000-000000000000'] alone and
      // not over the two uuids the request asked about.
      scopeDigest: '12b9377cbe7e5c94',
    })
  })

  /**
   * Standard Red Notes (t99): a position that cannot be honoured is an ERROR.
   *
   * Each of these used to be answered `200`, `retrieved_items: []` and a FRESH
   * token — the one response shape that empties an account in one go while
   * emitting no signal at all. See GetItems.verifyPositionIsHonourable.
   */
  describe('a position that cannot be honoured', () => {
    const USER = '00000000-0000-0000-0000-000000000000'
    const VAULT = '11111111-1111-1111-1111-111111111111'

    it('refuses a cursor naming a row this account cannot see, rather than answering an empty success', async () => {
      itemRepository.countAll = jest.fn().mockResolvedValue(0)

      const result = await createUseCase().execute({
        userUuid: USER,
        cursorToken: cursorToken(100, '22222222-2222-2222-2222-222222222222'),
      })

      expect(result.isFailed()).toBeTruthy()
      expect(result.getError()).toEqual('Sync cursor refers to an item this account cannot continue from')
      // Refused BEFORE any retrieval: an unanswerable position must not look
      // like a page of nothing.
      expect(itemRepository.findContentSizeForComputingTransferLimit).not.toHaveBeenCalled()
    })

    it('checks the cursor row against the same visibility the retrieval uses', async () => {
      sharedVaultUserRepository.findByUserUuid = jest
        .fn()
        .mockResolvedValue([{ props: { sharedVaultUuid: Uuid.create(VAULT).getValue() } }])

      await createUseCase().execute({
        userUuid: USER,
        cursorToken: cursorToken(100, '22222222-2222-2222-2222-222222222222'),
      })

      // A page can legitimately end on a vault row another account owns, so the
      // check must see the vault scope too or it would reject a valid cursor.
      expect((itemRepository.countAll as jest.Mock).mock.calls[0][0]).toEqual({
        uuids: ['22222222-2222-2222-2222-222222222222'],
        userUuid: USER,
        includeSharedVaultUuids: [VAULT],
        exclusiveSharedVaultUuids: undefined,
      })
    })

    it('refuses a position ahead of the server clock', async () => {
      timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1_000_000)
      const beyond = 1_000_000 + SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS + 1

      const viaCursor = await createUseCase().execute({ userUuid: USER, cursorToken: cursorToken(beyond, itemUuid) })
      expect(viaCursor.isFailed()).toBeTruthy()
      expect(viaCursor.getError()).toEqual('Sync position is ahead of the server clock and cannot be honoured')

      const viaToken = await createUseCase().execute({
        userUuid: USER,
        syncToken: encodeSyncToken({ positionMicroseconds: beyond }),
      })
      expect(viaToken.isFailed()).toBeTruthy()
    })

    it('still honours a position inside the skew allowance', async () => {
      timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1_000_000)
      const withinSkew = 1_000_000 + SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS

      const result = await createUseCase().execute({
        userUuid: USER,
        syncToken: encodeSyncToken({ positionMicroseconds: withinSkew }),
      })

      expect(result.isFailed()).toBeFalsy()
    })

    it('refuses a vault-scoped position presented on a different scope', async () => {
      const result = await createUseCase().execute({
        userUuid: USER,
        syncToken: encodeSyncToken({ positionMicroseconds: 100, scopeDigest: scopeDigestFor([VAULT]) }),
      })

      expect(result.isFailed()).toBeTruthy()
      expect(result.getError()).toEqual('Sync token was issued for a different retrieval scope and cannot be honoured')
    })

    it('honours a vault-scoped position on the scope it was issued for', async () => {
      sharedVaultUserRepository.findByUserUuid = jest
        .fn()
        .mockResolvedValue([{ props: { sharedVaultUuid: Uuid.create(VAULT).getValue() } }])

      const result = await createUseCase().execute({
        userUuid: USER,
        sharedVaultUuids: [VAULT],
        syncToken: encodeSyncToken({ positionMicroseconds: 100, scopeDigest: scopeDigestFor([VAULT]) }),
      })

      expect(result.isFailed()).toBeFalsy()
    })

    it('honours a GLOBAL position on a vault-exclusive sync, which can only over-deliver', async () => {
      sharedVaultUserRepository.findByUserUuid = jest
        .fn()
        .mockResolvedValue([{ props: { sharedVaultUuid: Uuid.create(VAULT).getValue() } }])

      const result = await createUseCase().execute({
        userUuid: USER,
        sharedVaultUuids: [VAULT],
        syncToken: encodeSyncToken({ positionMicroseconds: 100 }),
      })

      expect(result.isFailed()).toBeFalsy()
    })
  })

  describe('a token this server cannot read at all', () => {
    const USER = '00000000-0000-0000-0000-000000000000'

    it('refuses a v2 token whose position is not a number', async () => {
      const result = await createUseCase().execute({
        userUuid: USER,
        syncToken: Buffer.from('2:not-a-number', 'utf-8').toString('base64'),
      })

      expect(result.isFailed()).toBeTruthy()
      expect(result.getError()).toEqual('Sync token contains an invalid timestamp')
    })

    it('refuses a v3 cursor that does not carry exactly a position and a uuid', async () => {
      const result = await createUseCase().execute({
        userUuid: USER,
        cursorToken: Buffer.from('3:123', 'utf-8').toString('base64'),
      })

      expect(result.isFailed()).toBeTruthy()
      expect(result.getError()).toEqual('Sync cursor is malformed')
    })
  })

  describe('the own-write skip', () => {
    const USER = '00000000-0000-0000-0000-000000000000'
    const SESSION = '00000000-0000-0000-0000-0000000000a1'

    it('threads the session and its ceiling into the retrieval query', async () => {
      await createUseCase().execute({
        userUuid: USER,
        syncToken: encodeSyncToken({
          positionMicroseconds: 100,
          ownWriteSessionUuid: SESSION,
          ownWriteCeilingMicroseconds: 200,
        }),
      })

      const itemQuery = (itemRepository.findContentSizeForComputingTransferLimit as jest.Mock).mock
        .calls[0][0] as ItemQuery
      expect(itemQuery.excludeUpdatedWithSession).toEqual(SESSION)
      expect(itemQuery.excludeUpdatedWithSessionUpToTimestamp).toEqual(200)
    })

    it('skips nothing for an ordinary token', async () => {
      await createUseCase().execute({ userUuid: USER, syncToken: encodeSyncToken({ positionMicroseconds: 100 }) })

      const itemQuery = (itemRepository.findContentSizeForComputingTransferLimit as jest.Mock).mock
        .calls[0][0] as ItemQuery
      expect(itemQuery.excludeUpdatedWithSession).toBeUndefined()
      expect(itemQuery.excludeUpdatedWithSessionUpToTimestamp).toBeUndefined()
    })
  })
})
