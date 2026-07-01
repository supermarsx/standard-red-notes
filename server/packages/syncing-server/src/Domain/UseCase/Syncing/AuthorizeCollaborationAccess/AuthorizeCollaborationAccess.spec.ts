import 'reflect-metadata'
import { Uuid } from '@standardnotes/domain-core'

import { Item } from '../../../Item/Item'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'

import { AuthorizeCollaborationAccess } from './AuthorizeCollaborationAccess'

const USER = '00000000-0000-0000-0000-0000000000aa'
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb'
const ITEM = '00000000-0000-0000-0000-0000000000c1'
const VAULT = '00000000-0000-0000-0000-0000000000d1'

describe('AuthorizeCollaborationAccess', () => {
  let itemRepository: jest.Mocked<ItemRepositoryInterface>
  let sharedVaultUserRepository: jest.Mocked<SharedVaultUserRepositoryInterface>

  const createUseCase = () => new AuthorizeCollaborationAccess(itemRepository, sharedVaultUserRepository)

  // Build a fake Item: owner = ownerUuid, optionally in a shared vault.
  const fakeItem = (ownerUuid: string, sharedVaultUuid: string | null): Item =>
    ({
      props: { userUuid: Uuid.create(ownerUuid).getValue() },
      sharedVaultUuid: sharedVaultUuid === null ? null : Uuid.create(sharedVaultUuid).getValue(),
    }) as unknown as Item

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findByUuid = jest.fn().mockResolvedValue(null)

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)
  })

  it('ALLOWS the note OWNER', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, null))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
  })

  it('ALLOWS a SHARED-VAULT MEMBER of the note vault', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, VAULT))
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue({} as never)

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM })

    expect(result.getValue()).toBe(true)
    expect(sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid).toHaveBeenCalled()
  })

  it('DENIES a non-member of the note vault', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, VAULT))
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM })

    expect(result.getValue()).toBe(false)
  })

  it('DENIES a non-owner on a NON-shared note', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, null))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM })

    expect(result.getValue()).toBe(false)
    expect(sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid).not.toHaveBeenCalled()
  })

  it('DENIES when the item does not exist', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM })

    expect(result.getValue()).toBe(false)
  })

  it('FAILS (caller denies) when the item lookup THROWS', async () => {
    itemRepository.findByUuid = jest.fn().mockRejectedValue(new Error('db down'))

    await expect(createUseCase().execute({ userUuid: USER, itemUuid: ITEM })).rejects.toThrow('db down')
  })

  it('FAILS for a malformed user uuid', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid', itemUuid: ITEM })
    expect(result.isFailed()).toBe(true)
  })

  it('FAILS for a malformed item uuid', async () => {
    const result = await createUseCase().execute({ userUuid: USER, itemUuid: 'not-a-uuid' })
    expect(result.isFailed()).toBe(true)
  })
})
