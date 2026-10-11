import { Uuid } from '@standardnotes/domain-core'

import { GetUsersStorageUsage } from './GetUsersStorageUsage'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemStorageUsage } from '../../../Item/ItemStorageUsage'

describe('GetUsersStorageUsage', () => {
  let itemRepository: jest.Mocked<ItemRepositoryInterface>

  const ALICE = '00000000-0000-0000-0000-0000000000a1'
  const BOB = '00000000-0000-0000-0000-0000000000b2'
  const CAROL = '00000000-0000-0000-0000-0000000000c3'

  const createUseCase = () => new GetUsersStorageUsage(itemRepository)

  beforeEach(() => {
    itemRepository = {
      getStorageUsageForUsers: jest.fn().mockResolvedValue(new Map<string, ItemStorageUsage>()),
    } as unknown as jest.Mocked<ItemRepositoryInterface>
  })

  /**
   * *** THE REGRESSION PIN. *** Three accounts, three different figures, each
   * attached to the account it measures. The report this use case replaced could
   * only answer about the caller, so it could not have produced this.
   */
  it('answers every requested account its own figure, in the order asked', async () => {
    itemRepository.getStorageUsageForUsers.mockResolvedValue(
      new Map([
        [ALICE, { sizedBytes: 3_000_000, sizedItems: 1, unsizedItems: 0 }],
        [BOB, { sizedBytes: 7_000_000, sizedItems: 2, unsizedItems: 0 }],
        [CAROL, { sizedBytes: 11_000_000, sizedItems: 1, unsizedItems: 0 }],
      ]),
    )

    const result = await createUseCase().execute({ userUuids: [ALICE, BOB, CAROL] })

    expect(result.getValue()).toEqual([
      { userUuid: ALICE, sizedBytes: 3_000_000, sizedItems: 1, unsizedItems: 0 },
      { userUuid: BOB, sizedBytes: 7_000_000, sizedItems: 2, unsizedItems: 0 },
      { userUuid: CAROL, sizedBytes: 11_000_000, sizedItems: 1, unsizedItems: 0 },
    ])
  })

  it('passes every requested uuid to the repository as a single batch', async () => {
    await createUseCase().execute({ userUuids: [ALICE, BOB, CAROL] })

    expect(itemRepository.getStorageUsageForUsers).toHaveBeenCalledTimes(1)
    const passed = itemRepository.getStorageUsageForUsers.mock.calls[0][0] as Uuid[]
    expect(passed.map((uuid) => uuid.value)).toEqual([ALICE, BOB, CAROL])
  })

  /**
   * `GROUP BY` emits nothing for an account with no rows, and a caller handed a
   * short list would have to guess which of its subjects were dropped and why. On
   * this server an absent group has exactly one meaning, and `{0, 0, 0}` is the one
   * case in which zero is a complete, true answer — `sizedItems === 0 &&
   * unsizedItems === 0` is what says so.
   */
  it('fills in a complete zero for an account the repository reported nothing for', async () => {
    itemRepository.getStorageUsageForUsers.mockResolvedValue(
      new Map([[BOB, { sizedBytes: 7_000_000, sizedItems: 2, unsizedItems: 0 }]]),
    )

    const result = await createUseCase().execute({ userUuids: [ALICE, BOB] })

    expect(result.getValue()).toEqual([
      { userUuid: ALICE, sizedBytes: 0, sizedItems: 0, unsizedItems: 0 },
      { userUuid: BOB, sizedBytes: 7_000_000, sizedItems: 2, unsizedItems: 0 },
    ])
  })

  it('carries the unsized-item count through, so a bound stays a bound', async () => {
    itemRepository.getStorageUsageForUsers.mockResolvedValue(
      new Map([[ALICE, { sizedBytes: 1_024, sizedItems: 1, unsizedItems: 12 }]]),
    )

    const result = await createUseCase().execute({ userUuids: [ALICE] })

    expect(result.getValue()[0].unsizedItems).toBe(12)
  })

  /**
   * Dropping a malformed uuid would answer with a list shorter than the one asked
   * for and no indication of which subject went missing — the flattering direction,
   * and the one that lets a caller mis-key a whole report without being told.
   */
  it('fails the whole call on a malformed uuid rather than silently dropping it', async () => {
    const result = await createUseCase().execute({ userUuids: [ALICE, 'not-a-uuid'] })

    expect(result.isFailed()).toBe(true)
    expect(itemRepository.getStorageUsageForUsers).not.toHaveBeenCalled()
  })

  it('asks the repository nothing for an empty request', async () => {
    const result = await createUseCase().execute({ userUuids: [] })

    expect(result.getValue()).toEqual([])
    // The repository guards an empty IN(...) itself; this keeps the use case from
    // relying on that guard for an input it can see is empty.
    expect(itemRepository.getStorageUsageForUsers).toHaveBeenCalledWith([])
  })
})
