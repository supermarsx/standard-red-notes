import { ContentType } from '@standardnotes/domain-core'
import { ItemContentSizeDescriptor } from '../../../Item/ItemContentSizeDescriptor'
import { ItemHash } from '../../../Item/ItemHash'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { CheckForContentLimit } from './CheckForContentLimit'

describe('CheckForContentLimit', () => {
  let itemRepository: ItemRepositoryInterface
  let freeUserContentLimitInBytes: number
  let itemHash: ItemHash

  const createUseCase = () => new CheckForContentLimit(itemRepository, freeUserContentLimitInBytes)

  beforeEach(() => {
    itemRepository = {} as ItemRepositoryInterface
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(0)
    itemRepository.findContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue([])

    itemHash = ItemHash.create({
      uuid: '00000000-0000-0000-0000-000000000000',
      content: 'test content',
      content_type: ContentType.TYPES.Note,
      user_uuid: '00000000-0000-0000-0000-000000000000',
      key_system_identifier: null,
      shared_vault_uuid: null,
    }).getValue()

    freeUserContentLimitInBytes = 100
  })

  it('should return a failure result if user uuid is invalid', async () => {
    const useCase = createUseCase()
    const result = await useCase.execute({ userUuid: 'invalid-uuid', itemsBeingModified: [itemHash] })

    expect(result.isFailed()).toBe(true)
  })

  it('never reports an increase when no items are being modified', async () => {
    // A sync batch with no item hashes cannot grow the account, so the repository
    // must not even be consulted for pre-modification sizes.
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(1_000_000)

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [],
    })

    expect(result.isFailed()).toBe(false)
    expect(itemRepository.findContentSizeForComputingTransferLimit).not.toHaveBeenCalled()
  })

  it('should return a failure result if user has exceeded their content limit', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(101)
    itemRepository.findContentSizeForComputingTransferLimit = jest
      .fn()
      .mockResolvedValue([ItemContentSizeDescriptor.create('00000000-0000-0000-0000-000000000000', 101).getValue()])

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(result.isFailed()).toBe(true)
  })

  it('should return a success result if user has not exceeded their content limit', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(99)

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(result.isFailed()).toBe(false)
  })

  it('should not perform a per-item lookup when the content limit is not exceeded', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(99)

    const useCase = createUseCase()
    await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(itemRepository.findContentSizeForComputingTransferLimit).not.toHaveBeenCalled()
  })

  it('should treat the limit boundary identically (equal total is not exceeded)', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(100)

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(result.isFailed()).toBe(false)
  })

  it('should use the summed total returned by the repository to make the quota decision', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(101)
    itemRepository.findContentSizeForComputingTransferLimit = jest
      .fn()
      .mockResolvedValue([ItemContentSizeDescriptor.create('00000000-0000-0000-0000-000000000000', 1).getValue()])

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    // The summed total (101) exceeds the limit even though the individual modified
    // item descriptor is tiny (1), and the modification increases its size, so it fails.
    expect(itemRepository.sumContentSizeForComputingTransferLimit).toHaveBeenCalledWith({
      userUuid: '00000000-0000-0000-0000-000000000000',
      deleted: false,
    })
    expect(result.isFailed()).toBe(true)
  })

  it('should only fetch descriptors for the items being modified', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(101)
    itemRepository.findContentSizeForComputingTransferLimit = jest
      .fn()
      .mockResolvedValue([ItemContentSizeDescriptor.create('00000000-0000-0000-0000-000000000000', 101).getValue()])

    const useCase = createUseCase()
    await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(itemRepository.findContentSizeForComputingTransferLimit).toHaveBeenCalledWith({
      userUuid: '00000000-0000-0000-0000-000000000000',
      deleted: false,
      uuids: ['00000000-0000-0000-0000-000000000000'],
    })
  })

  it('should return a success result if user has exceeded their content limit but user modifications are not increasing content size', async () => {
    itemHash.calculateContentSize = jest.fn().mockReturnValue(99)

    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(101)
    itemRepository.findContentSizeForComputingTransferLimit = jest
      .fn()
      .mockResolvedValue([ItemContentSizeDescriptor.create('00000000-0000-0000-0000-000000000000', 101).getValue()])

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(result.isFailed()).toBe(false)
  })

  it('should treat items with no content size defined as 0', async () => {
    itemHash.calculateContentSize = jest.fn().mockReturnValue(99)

    // The whole account sums to 0 (all content sizes null/absent), so the limit is not exceeded.
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(0)

    const useCase = createUseCase()
    const result = await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(result.isFailed()).toBe(false)
  })

  it('should ignore deleted items when computing total content size', async () => {
    itemRepository.sumContentSizeForComputingTransferLimit = jest.fn().mockResolvedValue(0)

    const useCase = createUseCase()
    await useCase.execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      itemsBeingModified: [itemHash],
    })

    expect(itemRepository.sumContentSizeForComputingTransferLimit).toHaveBeenCalledWith({
      userUuid: '00000000-0000-0000-0000-000000000000',
      deleted: false,
    })
  })
})
