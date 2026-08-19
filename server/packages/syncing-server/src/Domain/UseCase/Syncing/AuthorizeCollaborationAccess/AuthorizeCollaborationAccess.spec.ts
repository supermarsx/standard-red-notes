import 'reflect-metadata'
import { SharedVaultUser, SharedVaultUserPermission, Uuid } from '@standardnotes/domain-core'

import { Item } from '../../../Item/Item'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'

import { AuthorizeCollaborationAccess } from './AuthorizeCollaborationAccess'

const USER = '00000000-0000-0000-0000-0000000000aa'
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb'
const ITEM = '00000000-0000-0000-0000-0000000000c1'
const VAULT = '00000000-0000-0000-0000-0000000000d1'
const SERVER_REVISION = 1_723_456_789_000_000

describe('AuthorizeCollaborationAccess', () => {
  let itemRepository: jest.Mocked<ItemRepositoryInterface>
  let sharedVaultUserRepository: jest.Mocked<SharedVaultUserRepositoryInterface>

  const createUseCase = () => new AuthorizeCollaborationAccess(itemRepository, sharedVaultUserRepository)

  // Build a fake Item: owner = ownerUuid, optionally in a shared vault.
  const fakeItem = (
    ownerUuid: string,
    sharedVaultUuid: string | null,
    deleted = false,
    itemsKeyId: string | null = 'items-key-1',
    updatedAt = SERVER_REVISION,
  ): Item =>
    ({
      props: {
        userUuid: Uuid.create(ownerUuid).getValue(),
        timestamps: { updatedAt },
        deleted,
        itemsKeyId,
        keySystemAssociation: { props: { keySystemIdentifier: 'key-system-1' } },
      },
      sharedVaultUuid: sharedVaultUuid === null ? null : Uuid.create(sharedVaultUuid).getValue(),
    }) as unknown as Item

  const fakeMembership = (permission: string, userUuid = USER, updatedAt = SERVER_REVISION): SharedVaultUser =>
    ({
      props: {
        permission: SharedVaultUserPermission.create(permission).getValue(),
        userUuid: Uuid.create(userUuid).getValue(),
        timestamps: { updatedAt },
        isDesignatedSurvivor: false,
      },
    }) as unknown as SharedVaultUser

  beforeEach(() => {
    itemRepository = {} as jest.Mocked<ItemRepositoryInterface>
    itemRepository.findByUuid = jest.fn().mockResolvedValue(null)

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)
    sharedVaultUserRepository.findBySharedVaultUuid = jest.fn().mockResolvedValue([])
  })

  it('ALLOWS the note OWNER', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, null))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual({
      authorized: true,
      serverUpdatedAtTimestamp: SERVER_REVISION,
      collaborationSecurityEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  it.each([SharedVaultUserPermission.PERMISSIONS.Write, SharedVaultUserPermission.PERMISSIONS.Admin])(
    'ALLOWS a shared-vault member with %s permission',
    async (permission) => {
      itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, VAULT))
      sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest
        .fn()
        .mockResolvedValue(fakeMembership(permission))
      sharedVaultUserRepository.findBySharedVaultUuid = jest.fn().mockResolvedValue([fakeMembership(permission)])

      const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

      expect(result.getValue()).toEqual({
        authorized: true,
        serverUpdatedAtTimestamp: SERVER_REVISION,
        collaborationSecurityEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      })
      expect(sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid).toHaveBeenCalled()
    },
  )

  it('DENIES a shared-vault member with read permission', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, VAULT))
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest
      .fn()
      .mockResolvedValue(fakeMembership(SharedVaultUserPermission.PERMISSIONS.Read))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.getValue()).toEqual({ authorized: false })
  })

  it('DENIES a shared-note creator after their vault permission is downgraded to read', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, VAULT))
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest
      .fn()
      .mockResolvedValue(fakeMembership(SharedVaultUserPermission.PERMISSIONS.Read))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.getValue()).toEqual({ authorized: false })
  })

  it('DENIES a read-only session even when the user owns the note', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, null))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: true })

    expect(result.getValue()).toEqual({ authorized: false })
    expect(itemRepository.findByUuid).not.toHaveBeenCalled()
  })

  it('DENIES a non-member of the note vault', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, VAULT))
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.getValue()).toEqual({ authorized: false })
  })

  it('DENIES a non-owner on a NON-shared note', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, null))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.getValue()).toEqual({ authorized: false })
    expect(sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid).not.toHaveBeenCalled()
  })

  it('DENIES when the item does not exist', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.getValue()).toEqual({ authorized: false })
  })

  it('DENIES a deleted note even when the user owns it', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, null, true))

    const result = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(result.getValue()).toEqual({ authorized: false })
  })

  it('FAILS (caller denies) when the item lookup THROWS', async () => {
    itemRepository.findByUuid = jest.fn().mockRejectedValue(new Error('db down'))

    await expect(createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })).rejects.toThrow(
      'db down',
    )
  })

  it('FAILS for a malformed user uuid', async () => {
    const result = await createUseCase().execute({
      userUuid: 'not-a-uuid',
      itemUuid: ITEM,
      readOnlyAccess: false,
    })
    expect(result.isFailed()).toBe(true)
  })

  it('FAILS for a malformed item uuid', async () => {
    const result = await createUseCase().execute({
      userUuid: USER,
      itemUuid: 'not-a-uuid',
      readOnlyAccess: false,
    })
    expect(result.isFailed()).toBe(true)
  })

  it('rotates the personal security epoch on a key change, but not an ordinary note revision', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, null, false, 'items-key-1'))
    const first = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    itemRepository.findByUuid = jest
      .fn()
      .mockResolvedValue(fakeItem(USER, null, false, 'items-key-1', SERVER_REVISION + 1))
    const ordinaryEdit = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(USER, null, false, 'items-key-2'))
    const rekeyed = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    expect(first.getValue()).toMatchObject({ authorized: true })
    expect(ordinaryEdit.getValue()).toMatchObject({ authorized: true })
    expect(rekeyed.getValue()).toMatchObject({ authorized: true })
    if (first.getValue().authorized && ordinaryEdit.getValue().authorized && rekeyed.getValue().authorized) {
      expect(ordinaryEdit.getValue().collaborationSecurityEpoch).toBe(first.getValue().collaborationSecurityEpoch)
      expect(rekeyed.getValue().collaborationSecurityEpoch).not.toBe(first.getValue().collaborationSecurityEpoch)
    }
  })

  it('rotates the shared-vault security epoch when membership permission changes', async () => {
    itemRepository.findByUuid = jest.fn().mockResolvedValue(fakeItem(OTHER_USER, VAULT))
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest
      .fn()
      .mockResolvedValue(fakeMembership(SharedVaultUserPermission.PERMISSIONS.Write))
    sharedVaultUserRepository.findBySharedVaultUuid = jest
      .fn()
      .mockResolvedValue([
        fakeMembership(SharedVaultUserPermission.PERMISSIONS.Write),
        fakeMembership(SharedVaultUserPermission.PERMISSIONS.Write, OTHER_USER),
      ])
    const first = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    sharedVaultUserRepository.findBySharedVaultUuid = jest
      .fn()
      .mockResolvedValue([
        fakeMembership(SharedVaultUserPermission.PERMISSIONS.Write),
        fakeMembership(SharedVaultUserPermission.PERMISSIONS.Read, OTHER_USER, SERVER_REVISION + 1),
      ])
    const changed = await createUseCase().execute({ userUuid: USER, itemUuid: ITEM, readOnlyAccess: false })

    if (first.getValue().authorized && changed.getValue().authorized) {
      expect(changed.getValue().collaborationSecurityEpoch).not.toBe(first.getValue().collaborationSecurityEpoch)
    } else {
      throw new Error('Expected both collaboration authorization checks to succeed')
    }
  })
})
