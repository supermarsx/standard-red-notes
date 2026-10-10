import { Result, SharedVaultUser, SharedVaultUserPermission, Timestamps, Uuid } from '@standardnotes/domain-core'
import {
  DomainEventInterface,
  DomainEventPublisherInterface,
  InviteRealtimeInvalidationRequestedEvent,
  isInviteRealtimeInvalidationRequestedEventPayload,
} from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { UpdateSharedVaultUserPermission } from './UpdateSharedVaultUserPermission'
import { SharedVault } from '../../../SharedVault/SharedVault'
import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { InviteMutationTransactionRunner } from '../../../Invite/InviteMutationTransactionRunner'
import { InviteRealtimeDomainEventProducer } from '../../../Invite/InviteRealtimeDomainEventProducer'
import { SyncCommandOutboxRepositoryInterface } from '../../../SyncCommand/SyncCommandOutboxRepositoryInterface'

/**
 * Real v4 uuids, not `0000...0000`: the realtime producer and the domain-events payload
 * validator both enforce the RFC variant/version nibbles, so a spec built on the
 * placeholder uuids used elsewhere in this folder would fail for the wrong reason -- or,
 * worse, pass while never reaching the producer.
 */
const VAULT_UUID = 'b3f1c4e2-5d6a-4b8c-9f10-2a3b4c5d6e7f'
const OWNER_UUID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const ADMIN_UUID = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70'
const MEMBER_UUID = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081'
const STRANGER_UUID = 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708192'

const uuid = (value: string): Uuid => Uuid.create(value).getValue()

const membership = (userUuid: string, permission: string, updatedAt = 1_000): SharedVaultUser =>
  SharedVaultUser.create({
    userUuid: uuid(userUuid),
    sharedVaultUuid: uuid(VAULT_UUID),
    permission: SharedVaultUserPermission.create(permission).getValue(),
    timestamps: Timestamps.create(900, updatedAt).getValue(),
    isDesignatedSurvivor: false,
  }).getValue()

describe('UpdateSharedVaultUserPermission', () => {
  let sharedVault: SharedVault
  let sharedVaultRepository: SharedVaultRepositoryInterface
  let sharedVaultUserRepository: SharedVaultUserRepositoryInterface
  let timer: TimerInterface
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let transactionRunner: InviteMutationTransactionRunner
  let outboxRepository: SyncCommandOutboxRepositoryInterface
  let enqueued: InviteRealtimeInvalidationRequestedEvent[]
  let members: SharedVaultUser[]

  /**
   * The REAL producer over a capturing outbox, deliberately. A jest.fn() double would
   * accept any object at all, including an action the four payload validators reject --
   * which is precisely the contract this feature had to extend, so a double would have
   * tested nothing about it.
   */
  const createUseCase = () =>
    new UpdateSharedVaultUserPermission(
      sharedVaultUserRepository,
      sharedVaultRepository,
      timer,
      domainEventFactory,
      domainEventPublisher,
      transactionRunner,
      new InviteRealtimeDomainEventProducer(
        outboxRepository,
        () => 1_700_000_000_000,
        () => 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      ),
    )

  beforeEach(() => {
    sharedVault = SharedVault.create({
      userUuid: uuid(OWNER_UUID),
      timestamps: Timestamps.create(900, 900).getValue(),
      fileUploadBytesUsed: 0,
    }).getValue()

    members = [
      membership(OWNER_UUID, SharedVaultUserPermission.PERMISSIONS.Admin),
      membership(ADMIN_UUID, SharedVaultUserPermission.PERMISSIONS.Admin),
      membership(MEMBER_UUID, SharedVaultUserPermission.PERMISSIONS.Read),
    ]

    sharedVaultRepository = {} as jest.Mocked<SharedVaultRepositoryInterface>
    sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(sharedVault)

    sharedVaultUserRepository = {} as jest.Mocked<SharedVaultUserRepositoryInterface>
    sharedVaultUserRepository.findBySharedVaultUuid = jest.fn().mockImplementation(async () => members)
    sharedVaultUserRepository.save = jest.fn()

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(5_000)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createUserPermissionChangedInSharedVaultEvent = jest
      .fn()
      .mockReturnValue({ type: 'USER_PERMISSION_CHANGED_IN_SHARED_VAULT' } as unknown as DomainEventInterface)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    enqueued = []
    outboxRepository = {} as jest.Mocked<SyncCommandOutboxRepositoryInterface>
    outboxRepository.enqueue = jest.fn().mockImplementation(async (event: InviteRealtimeInvalidationRequestedEvent) => {
      enqueued.push(event)
    })

    // Pass-through: the production runner wraps the mutation in one transaction, and every
    // assertion below is about the mutation, not the transaction boundary. The
    // `execute`/`executeMutation` split is still exercised, so a use case that forgot to
    // call the runner at all would never reach these assertions.
    transactionRunner = {} as jest.Mocked<InviteMutationTransactionRunner>
    transactionRunner.execute = jest.fn().mockImplementation(<T>(operation: () => Promise<Result<T>>) => operation())
  })

  describe('the change itself', () => {
    it('promotes a read-only member to write, persists it, and reports the new membership', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(result.isFailed()).toBe(false)
      expect(sharedVaultUserRepository.save).toHaveBeenCalledTimes(1)

      const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
      expect(saved.props.userUuid.value).toEqual(MEMBER_UUID)
      expect(saved.props.permission.value).toEqual('write')
      // The row that was saved is the row that was READ, so the membership keeps its uuid
      // and the repository issues an UPDATE rather than inserting a second row.
      expect(saved.id.toString()).toEqual(members[2].id.toString())
      expect(result.getValue().props.permission.value).toEqual('write')
    })

    it('demotes a write member back to read', async () => {
      members[2] = membership(MEMBER_UUID, SharedVaultUserPermission.PERMISSIONS.Write)

      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Read,
      })

      expect(result.isFailed()).toBe(false)
      const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
      expect(saved.props.permission.value).toEqual('read')
    })

    it('runs inside the invite mutation transaction so the row write and the outbox commit together', async () => {
      await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(transactionRunner.execute).toHaveBeenCalledTimes(1)
    })

    it('is a no-op when the permission already matches: no write, no event, no invalidation', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Read,
      })

      expect(result.isFailed()).toBe(false)
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
      expect(domainEventPublisher.publish).not.toHaveBeenCalled()
      expect(enqueued).toHaveLength(0)
    })

    it('moves the membership timestamp strictly forward even when the clock is behind the row', async () => {
      members[2] = membership(MEMBER_UUID, SharedVaultUserPermission.PERMISSIONS.Read, 9_999)
      timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(5_000)

      await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
      expect(saved.props.timestamps.updatedAt).toEqual(10_000)
      // And the client-visible revision agrees with the row, or the member's own app would
      // fence the invalidation away as "already seen".
      expect(enqueued[0].payload.event).toMatchObject({ revision: '10000' })
    })
  })

  describe('authorization', () => {
    it('lets a non-owner ADMIN move a member between read and write', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: ADMIN_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(result.isFailed()).toBe(false)
      expect(sharedVaultUserRepository.save).toHaveBeenCalledTimes(1)
    })

    it('refuses a write member trying to promote someone', async () => {
      members.push(membership(STRANGER_UUID, SharedVaultUserPermission.PERMISSIONS.Write))

      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: STRANGER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Only the owner or an admin can change a shared vault member permission')
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it('refuses a complete outsider', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: STRANGER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(result.isFailed()).toBe(true)
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it('refuses a member promoting THEMSELVES, which is the whole point of the guard', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: MEMBER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Admin,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Cannot change your own permission in a shared vault')
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it('refuses an ADMIN promoting themselves, not merely a read member', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: ADMIN_UUID,
        originatorUuid: ADMIN_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Admin,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Cannot change your own permission in a shared vault')
    })

    it('refuses an admin demoting the vault OWNER', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: OWNER_UUID,
        originatorUuid: ADMIN_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Read,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Cannot change the permission of the shared vault owner')
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it('refuses an admin GRANTING admin -- only the owner may create another admin', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: ADMIN_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Admin,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Only the owner can grant admin permission in a shared vault')
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it('lets the OWNER grant admin', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Admin,
      })

      expect(result.isFailed()).toBe(false)
      const saved = (sharedVaultUserRepository.save as jest.Mock).mock.calls[0][0] as SharedVaultUser
      expect(saved.props.permission.value).toEqual('admin')
    })

    it('refuses an unknown permission string rather than storing it', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: 'owner',
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Invalid shared vault user permission owner')
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it('refuses a change against a vault that does not exist', async () => {
      sharedVaultRepository.findByUuid = jest.fn().mockResolvedValue(null)

      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('Shared vault not found')
    })

    it('refuses a target who is not a member: this use case cannot grant access', async () => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: STRANGER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toEqual('User is not a member of the shared vault')
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })

    it.each([
      ['sharedVaultUuid', { sharedVaultUuid: 'not-a-uuid' }],
      ['originatorUuid', { originatorUuid: 'not-a-uuid' }],
      ['userUuid', { userUuid: 'not-a-uuid' }],
    ])('refuses a malformed %s', async (_label, override) => {
      const result = await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
        ...override,
      })

      expect(result.isFailed()).toBe(true)
      expect(sharedVaultUserRepository.save).not.toHaveBeenCalled()
    })
  })

  describe('propagation -- the parts a permission flip alone would miss', () => {
    it("publishes the cross-service event that keeps auth's mirror (and file uploads) in step", async () => {
      await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(domainEventFactory.createUserPermissionChangedInSharedVaultEvent).toHaveBeenCalledWith({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        permission: 'write',
        previousPermission: 'read',
        originatorUuid: OWNER_UUID,
        updatedAt: 5_000,
      })
      expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
    })

    it('enqueues a role-changed membership invalidation that the strict payload validator accepts', async () => {
      await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: OWNER_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(enqueued).toHaveLength(1)
      expect(enqueued[0].type).toEqual('INVITE_REALTIME_INVALIDATION_REQUESTED')
      expect(enqueued[0].payload.event).toMatchObject({
        kind: 'shared-vault-membership',
        action: 'role-changed',
        sharedVaultUuid: VAULT_UUID,
        memberUserUuid: MEMBER_UUID,
        role: 'write',
        revision: '5000',
      })
      // No invite is involved in an in-place change, and the membership validators require
      // `inviteUuid` to be ABSENT for every action other than invited/accepted.
      expect(enqueued[0].payload.event).not.toHaveProperty('inviteUuid')

      // The real gate: the same predicate the websocket gateway mirrors. An action the
      // allowlist does not know makes this false, and the gateway would then refuse the
      // message forever on SQS.
      expect(isInviteRealtimeInvalidationRequestedEventPayload(enqueued[0].payload)).toBe(true)
    })

    it('invalidates for every member AND the actor, so no vault list on screen stays stale', async () => {
      await createUseCase().execute({
        sharedVaultUuid: VAULT_UUID,
        userUuid: MEMBER_UUID,
        originatorUuid: ADMIN_UUID,
        permission: SharedVaultUserPermission.PERMISSIONS.Write,
      })

      expect(enqueued[0].payload.affectedUserUuids.sort()).toEqual([OWNER_UUID, ADMIN_UUID, MEMBER_UUID].sort())
    })
  })
})
