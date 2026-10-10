import { Result } from '@standardnotes/domain-core'
import { SharedVaultListingInterface } from '@standardnotes/models'
import { HttpResponse } from '@standardnotes/responses'
import { SharedVaultUsersServerInterface } from '@standardnotes/api'

import { ChangeVaultMemberPermission } from './UseCase/ChangeVaultMemberPermission'
import { VaultUserService } from './VaultUserService'
import { VaultUserServiceEvent } from './VaultUserServiceEvent'

const SHARED_VAULT_UUID = 'shared-vault-1'
const MEMBER_UUID = 'member-1'

const sharedVault = {
  isSharedVaultListing: () => true,
  sharing: { sharedVaultUuid: SHARED_VAULT_UUID, ownerUserUuid: 'owner-1' },
} as unknown as SharedVaultListingInterface

describe('ChangeVaultMemberPermission', () => {
  let server: SharedVaultUsersServerInterface

  beforeEach(() => {
    server = {} as jest.Mocked<SharedVaultUsersServerInterface>
    server.updateSharedVaultUserPermission = jest.fn().mockResolvedValue({ status: 200, data: { user: {} } })
  })

  it('PATCHes the member with the requested permission', async () => {
    const result = await new ChangeVaultMemberPermission(server).execute({
      sharedVaultUuid: SHARED_VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: 'write',
    })

    expect(result.isFailed()).toBe(false)
    expect(server.updateSharedVaultUserPermission).toHaveBeenCalledWith({
      sharedVaultUuid: SHARED_VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: 'write',
    })
  })

  /**
   * The server's refusals are the only thing that distinguishes "you may not grant admin"
   * from "you cannot change your own permission". Collapsing them into a generic failure
   * would leave the person who clicked with no idea which rule they hit.
   */
  it('surfaces the server message rather than a generic failure', async () => {
    server.updateSharedVaultUserPermission = jest.fn().mockResolvedValue({
      status: 400,
      data: { error: { message: 'Only the owner can grant admin permission in a shared vault' } },
    } as unknown as HttpResponse<never>)

    const result = await new ChangeVaultMemberPermission(server).execute({
      sharedVaultUuid: SHARED_VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: 'admin',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Only the owner can grant admin permission in a shared vault')
  })
})

/**
 * `VaultUserService.changeMemberPermission` has two jobs beyond calling the server: it
 * refuses when the signed-in user is not an admin (so the UI cannot offer an action that
 * can only fail), and it REFRESHES the local member cache. That cache is what
 * `IsReadonlyVaultMember` and `IsVaultAdmin` read; without the refresh the actor's own
 * screen keeps showing the old permission until something else happens to invalidate it.
 *
 * It deliberately does NOT rotate the vault key, unlike removal: the member keeps their
 * membership and therefore keeps legitimate possession of the key throughout.
 */
describe('VaultUserService.changeMemberPermission', () => {
  let changeVaultMemberPermission: ChangeVaultMemberPermission
  let getVaultUsers: { execute: jest.Mock }
  let isVaultAdmin: { execute: jest.Mock }
  let vaults: { rotateVaultRootKey: jest.Mock; getVaults: jest.Mock }
  let notified: VaultUserServiceEvent[]

  const createService = () => {
    const service = new VaultUserService(
      vaults as never,
      {} as never,
      getVaultUsers as never,
      {} as never,
      {} as never,
      isVaultAdmin as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      changeVaultMemberPermission,
      { addEventHandler: () => undefined } as never,
    )
    // `notifyEvent` is protected on AbstractService; capture it rather than reaching into
    // an event bus double, so the assertion is about this service's own announcement.
    ;(service as unknown as { notifyEvent: (event: VaultUserServiceEvent) => Promise<void> }).notifyEvent = async (
      event,
    ) => {
      notified.push(event)
    }
    return service
  }

  beforeEach(() => {
    notified = []
    changeVaultMemberPermission = {} as jest.Mocked<ChangeVaultMemberPermission>
    changeVaultMemberPermission.execute = jest.fn().mockResolvedValue(Result.ok())

    getVaultUsers = { execute: jest.fn().mockResolvedValue(Result.ok([])) }
    isVaultAdmin = { execute: jest.fn().mockReturnValue(Result.ok(true)) }
    vaults = { rotateVaultRootKey: jest.fn(), getVaults: jest.fn().mockReturnValue([]) }
  })

  it('changes the permission, refetches the member list from the server, and announces it', async () => {
    const result = await createService().changeMemberPermission(sharedVault, MEMBER_UUID, 'write')

    expect(result.isFailed()).toBe(false)
    expect(changeVaultMemberPermission.execute).toHaveBeenCalledWith({
      sharedVaultUuid: SHARED_VAULT_UUID,
      userUuid: MEMBER_UUID,
      permission: 'write',
    })
    // readFromCache: false -- a cached list is exactly what must not be trusted here.
    expect(getVaultUsers.execute).toHaveBeenCalledWith({ sharedVaultUuid: SHARED_VAULT_UUID, readFromCache: false })
    expect(notified).toContain(VaultUserServiceEvent.UsersChanged)
    expect(notified).toContain(VaultUserServiceEvent.InvalidatedUserCacheForVault)
  })

  it('does NOT rotate the vault key: the member keeps their membership and their key', async () => {
    await createService().changeMemberPermission(sharedVault, MEMBER_UUID, 'read')

    expect(vaults.rotateVaultRootKey).not.toHaveBeenCalled()
  })

  it('refuses when the signed-in user is not a vault admin, and never calls the server', async () => {
    isVaultAdmin.execute = jest.fn().mockReturnValue(Result.ok(false))

    const result = await createService().changeMemberPermission(sharedVault, MEMBER_UUID, 'write')

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Only vault admins can change member permissions')
    expect(changeVaultMemberPermission.execute).not.toHaveBeenCalled()
  })

  it('leaves the cache alone when the server refused, so the UI keeps showing the truth', async () => {
    changeVaultMemberPermission.execute = jest.fn().mockResolvedValue(Result.fail('Shared vault not found'))

    const result = await createService().changeMemberPermission(sharedVault, MEMBER_UUID, 'write')

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Shared vault not found')
    expect(getVaultUsers.execute).not.toHaveBeenCalled()
    expect(notified).toHaveLength(0)
  })
})
