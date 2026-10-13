import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'

import { SharedVaultUserRepositoryInterface } from '../../SharedVault/SharedVaultUserRepositoryInterface'
import { UpdateSharedVaultUserPermission } from './UpdateSharedVaultUserPermission'

const VAULT_UUID = 'b3f1c4e2-5d6a-4b8c-9f10-2a3b4c5d6e7f'
const MEMBER_UUID = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081'
const MEMBERSHIP_ROW_UUID = '11112222-3333-4444-8555-666677778888'

/**
 * Auth's MIRROR of a shared-vault membership. The row identity matters more than it looks:
 * `CreateCrossServiceToken` projects this table as `belongs_to_shared_vaults`, and both
 * file authorizers refuse an upload when the permission there reads `read`. Two rows for
 * one membership therefore means a permission that depends on which row the query returns
 * first -- so these tests pin that the row is UPDATED, never duplicated.
 */
describe('auth UpdateSharedVaultUserPermission (membership mirror)', () => {
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface
  let existing: SharedVaultUser

  const createUseCase = () => new UpdateSharedVaultUserPermission(sharedVaultUserRepository)

  beforeEach(() => {
    existing = SharedVaultUser.create(
      {
        userUuid: Uuid.create(MEMBER_UUID).getValue(),
        sharedVaultUuid: Uuid.create(VAULT_UUID).getValue(),
        permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Read).getValue(),
        timestamps: Timestamps.create(900, 1_000).getValue(),
        isDesignatedSurvivor: false,
      },
      new UniqueEntityId(MEMBERSHIP_ROW_UUID),
    ).getValue()

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(existing)
    sharedVaultUserRepository.save = jest.fn()
  })

  it('updates the mirrored permission in place, keeping the row uuid so the repository UPDATEs', async () => {
    const result = await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      updatedAt: 5_000,
    })

    expect(result.isFailed()).toBe(false)
    expect(sharedVaultUserRepository.save).toHaveBeenCalledTimes(1)

    const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
    expect(saved.props.permission.value).toEqual('write')
    expect(saved.props.timestamps.updatedAt).toEqual(5_000)
    // The createdAt comes from the EXISTING row, not from the event: an event-supplied
    // createdAt would rewrite when the membership began every time it is edited.
    expect(saved.props.timestamps.createdAt).toEqual(900)
    // The whole point: same primary key, so this is an UPDATE and not a second row.
    expect(saved.id.toString()).toEqual(MEMBERSHIP_ROW_UUID)
  })

  it('mirrors a demotion back to read just as readily', async () => {
    existing.props.permission = SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Write).getValue()

    await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Read,
      updatedAt: 5_000,
    })

    const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
    expect(saved.props.permission.value).toEqual('read')
  })

  // The syncing-server publishes this only after changing a membership row it HAS,
  // so a missing mirror row means the add event was lost. Refusing kept the member
  // out of `belongs_to_shared_vaults` for good.
  it('creates the mirror row when the add event never arrived', async () => {
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      updatedAt: 5_000,
    })

    expect(result.isFailed()).toBe(false)
    expect(sharedVaultUserRepository.save).toHaveBeenCalledTimes(1)
    const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
    expect(saved.props.userUuid.value).toEqual(MEMBER_UUID)
    expect(saved.props.sharedVaultUuid.value).toEqual(VAULT_UUID)
    expect(saved.props.permission.value).toEqual('write')
    expect(saved.props.timestamps.createdAt).toEqual(5_000)
    expect(saved.props.timestamps.updatedAt).toEqual(5_000)
    expect(saved.props.isDesignatedSurvivor).toBe(false)
  })

  it('keeps a later change when an earlier one is delivered after it', async () => {
    const result = await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      updatedAt: 999,
    })

    expect(result.isFailed()).toBe(false)
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it.each([
    ['timestamps', () => jest.spyOn(Timestamps, 'create').mockReturnValue(Result.fail('bad timestamps'))],
    ['membership', () => jest.spyOn(SharedVaultUser, 'create').mockReturnValue(Result.fail('bad membership'))],
  ])('refuses to create a mirror row from invalid %s', async (_label, breakIt) => {
    sharedVaultUserRepository.findByUserUuidAndSharedVaultUuid = jest.fn().mockResolvedValue(null)
    const spy = breakIt()

    const result = await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      updatedAt: 5_000,
    })

    spy.mockRestore()
    expect(result.isFailed()).toBe(true)
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it('refuses to update from invalid timestamps', async () => {
    const spy = jest.spyOn(Timestamps, 'create').mockReturnValue(Result.fail('bad timestamps'))

    const result = await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      updatedAt: 5_000,
    })

    spy.mockRestore()
    expect(result.isFailed()).toBe(true)
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })

  it.each([
    ['permission', { permission: 'superuser' }],
    ['userUuid', { userUuid: 'not-a-uuid' }],
    ['sharedVaultUuid', { sharedVaultUuid: 'not-a-uuid' }],
  ])('refuses a malformed %s instead of writing it to the mirror', async (_label, override) => {
    const result = await createUseCase().execute({
      sharedVaultUuid: VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: SharedVaultUserPermission.PERMISSIONS.Write,
      updatedAt: 5_000,
      ...override,
    })

    expect(result.isFailed()).toBe(true)
    expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
  })
})
