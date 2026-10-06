import 'reflect-metadata'
import { Uuid } from '@standardnotes/domain-core'

import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { ItemStorageUsage } from '../../../Item/ItemStorageUsage'
import { GetUserStorageUsage } from './GetUserStorageUsage'

describe('GetUserStorageUsage', () => {
  let itemRepository: ItemRepositoryInterface

  const USER_UUID = '00000000-0000-4000-8000-00000000aaaa'

  const usage = (overrides: Partial<ItemStorageUsage> = {}): ItemStorageUsage => ({
    sizedBytes: 0,
    sizedItems: 0,
    unsizedItems: 0,
    ...overrides,
  })

  const createUseCase = () => new GetUserStorageUsage(itemRepository)

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.getStorageUsageForUser = jest.fn().mockResolvedValue(usage())
  })

  it('refuses a user uuid that is not one, rather than querying with it', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid' })

    expect(result.isFailed()).toBeTruthy()
    expect(itemRepository.getStorageUsageForUser).not.toHaveBeenCalled()
  })

  it('asks the repository for the requesting account and for nothing else', async () => {
    await createUseCase().execute({ userUuid: USER_UUID })

    const asked = (itemRepository.getStorageUsageForUser as jest.Mock).mock.calls[0][0] as Uuid

    expect(asked.value).toEqual(USER_UUID)
    expect((itemRepository.getStorageUsageForUser as jest.Mock).mock.calls.length).toEqual(1)
  })

  /**
   * *** THE ZERO THAT IS A FIGURE. *** An account with no items at all really is
   * holding nothing, and that must come back as a measured zero rather than as an
   * absence — the Space block renders the two completely differently and the whole
   * point of the field is that it can tell them apart.
   */
  it('reports an account with no items as a measured zero', async () => {
    itemRepository.getStorageUsageForUser = jest.fn().mockResolvedValue(usage())

    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.getValue()).toEqual({ sizedBytes: 0, sizedItems: 0, unsizedItems: 0 })
  })

  /**
   * *** AND THE ZERO THAT IS NOT. *** Items present and every one of them carrying
   * no recorded size is a floor, not a total, and the use case must carry the
   * unsized count out rather than collapsing it into the same shape as above.
   */
  it('carries the unsized-item count out rather than reporting a flattering zero', async () => {
    itemRepository.getStorageUsageForUser = jest
      .fn()
      .mockResolvedValue(usage({ sizedBytes: 0, sizedItems: 0, unsizedItems: 12 }))

    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.getValue()).toEqual({ sizedBytes: 0, sizedItems: 0, unsizedItems: 12 })
  })

  it('passes a measured total through unchanged, deriving nothing of its own', async () => {
    itemRepository.getStorageUsageForUser = jest
      .fn()
      .mockResolvedValue(usage({ sizedBytes: 7_340_032, sizedItems: 9, unsizedItems: 0 }))

    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({ sizedBytes: 7_340_032, sizedItems: 9, unsizedItems: 0 })
  })
})
