import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'
import { SharedVaultInviteRepositoryInterface } from '../../../SharedVault/User/Invite/SharedVaultInviteRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { InviteRealtimeDomainEventProducer } from '../../../Invite/InviteRealtimeDomainEventProducer'
import { AddUserToSharedVault } from '../AddUserToSharedVault/AddUserToSharedVault'
import { AcceptInviteToSharedVault } from './AcceptInviteToSharedVault'
import { SharedVaultInvite } from '../../../SharedVault/User/Invite/SharedVaultInvite'

describe('AcceptInviteToSharedVault', () => {
  let addUserToSharedVault: AddUserToSharedVault
  let sharedVaultInviteRepository: SharedVaultInviteRepositoryInterface
  let invite: SharedVaultInvite

  const createUseCase = () => new AcceptInviteToSharedVault(addUserToSharedVault, sharedVaultInviteRepository)

  beforeEach(() => {
    invite = SharedVaultInvite.create({
      sharedVaultUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      userUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      senderUuid: Uuid.create('00000000-0000-0000-0000-000000000000').getValue(),
      encryptedMessage: 'encrypted-message',
      permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Read).getValue(),
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

    addUserToSharedVault = {} as jest.Mocked<AddUserToSharedVault>
    addUserToSharedVault.execute = jest.fn().mockReturnValue(Result.ok())

    sharedVaultInviteRepository = {} as jest.Mocked<SharedVaultInviteRepositoryInterface>
    sharedVaultInviteRepository.findByUuid = jest.fn().mockResolvedValue(invite)
    sharedVaultInviteRepository.remove = jest.fn()
  })

  it('should fail if invite uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      inviteUuid: 'invalid',
      originatorUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid')
  })

  it('should fail if originator uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      inviteUuid: '00000000-0000-0000-0000-000000000000',
      originatorUuid: 'invalid',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Given value is not a valid uuid: invalid')
  })

  it('should fail if invite is not found', async () => {
    sharedVaultInviteRepository.findByUuid = jest.fn().mockResolvedValue(null)

    const useCase = createUseCase()

    const result = await useCase.execute({
      inviteUuid: '00000000-0000-0000-0000-000000000000',
      originatorUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Invite not found')
  })

  it('should fail if originator is not the recipient of the invite', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      inviteUuid: '00000000-0000-0000-0000-000000000000',
      originatorUuid: '00000000-0000-0000-0000-000000000001',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Only the recipient of the invite can accept it')
  })

  it('should fail if adding user to shared vault fails', async () => {
    addUserToSharedVault.execute = jest.fn().mockReturnValue(Result.fail('Failed to add user to shared vault'))

    const useCase = createUseCase()

    const result = await useCase.execute({
      inviteUuid: '00000000-0000-0000-0000-000000000000',
      originatorUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Failed to add user to shared vault')
  })

  it('should delete invite after adding user to shared vault', async () => {
    const useCase = createUseCase()

    await useCase.execute({
      inviteUuid: '00000000-0000-0000-0000-000000000000',
      originatorUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(sharedVaultInviteRepository.remove).toHaveBeenCalled()
  })

  /**
   * Membership revision contract (t92 C12): on accept the revision is the new
   * membership row's `updatedAt` in microseconds as a decimal string. The
   * literal fixture `{ revision: '1789150108395094', membershipUuid }` is shared
   * with the client fence spec.
   */
  it('emits the membership row updatedAt as the revision in the canonical shape', async () => {
    const MEMBERSHIP_UUID = '30000000-0000-4000-8000-000000000011'
    const membership = SharedVaultUser.create(
      {
        permission: SharedVaultUserPermission.create(SharedVaultUserPermission.PERMISSIONS.Read).getValue(),
        sharedVaultUuid: invite.props.sharedVaultUuid,
        userUuid: invite.props.userUuid,
        // createdAt deliberately differs so the assertion pins updatedAt specifically.
        timestamps: Timestamps.create(1789150108395000, 1789150108395094).getValue(),
        isDesignatedSurvivor: false,
      },
      new UniqueEntityId(MEMBERSHIP_UUID),
    ).getValue()
    addUserToSharedVault.execute = jest.fn().mockResolvedValue(Result.ok(membership))
    const sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findBySharedVaultUuid = jest.fn().mockResolvedValue([membership])
    const producer = {} as jest.Mocked<InviteRealtimeDomainEventProducer>
    producer.recordSharedVaultInvite = jest.fn().mockResolvedValue(undefined)
    producer.recordSharedVaultMembership = jest.fn().mockResolvedValue(undefined)
    const useCase = new AcceptInviteToSharedVault(
      addUserToSharedVault,
      sharedVaultInviteRepository,
      sharedVaultUserRepository,
      undefined,
      producer,
    )

    const result = await useCase.execute({
      inviteUuid: '00000000-0000-0000-0000-000000000000',
      originatorUuid: '00000000-0000-0000-0000-000000000000',
    })

    expect(result.isFailed()).toBe(false)
    expect(producer.recordSharedVaultMembership).toHaveBeenCalledTimes(1)
    expect(producer.recordSharedVaultMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'accepted',
        membershipUuid: MEMBERSHIP_UUID,
        revision: '1789150108395094',
        role: 'read',
        inviteUuid: invite.id.toString(),
      }),
    )
    const { revision } = (producer.recordSharedVaultMembership as jest.Mock).mock.calls[0][0] as { revision: string }
    expect(revision).toMatch(/^[1-9]\d{0,31}$/)
    expect(revision).toBe(String(membership.props.timestamps.updatedAt))
  })
})
