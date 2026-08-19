import {
  Result,
  SharedVaultUser,
  SharedVaultUserPermission,
  Timestamps,
  UniqueEntityId,
  Uuid,
} from '@standardnotes/domain-core'
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { AddUserToSharedVault } from '../UseCase/SharedVaults/AddUserToSharedVault/AddUserToSharedVault'
import { AcceptInviteToSharedVault } from '../UseCase/SharedVaults/AcceptInviteToSharedVault/AcceptInviteToSharedVault'
import { CancelInviteToSharedVault } from '../UseCase/SharedVaults/CancelInviteToSharedVault/CancelInviteToSharedVault'
import { InviteUserToSharedVault } from '../UseCase/SharedVaults/InviteUserToSharedVault/InviteUserToSharedVault'
import { RemoveUserFromSharedVault } from '../UseCase/SharedVaults/RemoveUserFromSharedVault/RemoveUserFromSharedVault'
import { UpdateSharedVaultInvite } from '../UseCase/SharedVaults/UpdateSharedVaultInvite/UpdateSharedVaultInvite'
import { SharedVaultInvitePersistenceMapper } from '../../Mapping/Persistence/SharedVaultInvitePersistenceMapper'
import { SharedVaultPersistenceMapper } from '../../Mapping/Persistence/SharedVaultPersistenceMapper'
import { SharedVaultUserPersistenceMapper } from '../../Mapping/Persistence/SharedVaultUserPersistenceMapper'
import { SyncCommandOutboxRepositoryInterface } from '../SyncCommand/SyncCommandOutboxRepositoryInterface'
import { transactionAwareORMRepository } from '../../Infra/TypeORM/TransactionAwareORMRepository'
import { TransactionAwareDomainEventPublisher } from '../../Infra/TypeORM/TransactionAwareDomainEventPublisher'
import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { TypeORMSharedVault } from '../../Infra/TypeORM/TypeORMSharedVault'
import { TypeORMSharedVaultInvite } from '../../Infra/TypeORM/TypeORMSharedVaultInvite'
import { TypeORMSharedVaultInviteRepository } from '../../Infra/TypeORM/TypeORMSharedVaultInviteRepository'
import { TypeORMSharedVaultRepository } from '../../Infra/TypeORM/TypeORMSharedVaultRepository'
import { TypeORMSharedVaultUser } from '../../Infra/TypeORM/TypeORMSharedVaultUser'
import { TypeORMSharedVaultUserRepository } from '../../Infra/TypeORM/TypeORMSharedVaultUserRepository'
import { TypeORMSyncCommandOutbox } from '../../Infra/TypeORM/TypeORMSyncCommandOutbox'
import { TypeORMSyncCommandOutboxRepository } from '../../Infra/TypeORM/TypeORMSyncCommandOutboxRepository'
import { InviteMutationTransactionRunner } from './InviteMutationTransactionRunner'
import { InviteRealtimeDomainEventProducer } from './InviteRealtimeDomainEventProducer'

const ownerUuid = '00000000-0000-4000-8000-000000000001'
const memberUuid = '00000000-0000-4000-8000-000000000002'
const vaultUuid = '10000000-0000-4000-8000-000000000001'
const inviteUuid = '20000000-0000-4000-8000-000000000001'
const membershipUuid = '30000000-0000-4000-8000-000000000001'
const realtimeEventIds = ['70000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002']
type Lifecycle = 'create' | 'update' | 'accept' | 'cancel' | 'remove'

describe('shared-vault invite lifecycle transaction integration', () => {
  let dataSource: DataSource
  let transactionContext: SyncCommandTransactionContext
  let outboxRepository: TypeORMSyncCommandOutboxRepository
  let inviteRepository: TypeORMSharedVaultInviteRepository
  let userRepository: TypeORMSharedVaultUserRepository
  let vaultRepository: TypeORMSharedVaultRepository
  let failOutbox: boolean
  let failPrimary: boolean
  let eventIdIndex: number
  let runner: InviteMutationTransactionRunner
  let producer: InviteRealtimeDomainEventProducer
  let publisher: TransactionAwareDomainEventPublisher

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSharedVault, TypeORMSharedVaultInvite, TypeORMSharedVaultUser, TypeORMSyncCommandOutbox],
      synchronize: true,
    })
    await dataSource.initialize()
    transactionContext = new SyncCommandTransactionContext()
    outboxRepository = new TypeORMSyncCommandOutboxRepository(
      dataSource.getRepository(TypeORMSyncCommandOutbox),
      transactionContext,
    )
    inviteRepository = new TypeORMSharedVaultInviteRepository(
      transactionAwareORMRepository(
        dataSource.getRepository(TypeORMSharedVaultInvite),
        TypeORMSharedVaultInvite,
        transactionContext,
      ),
      new SharedVaultInvitePersistenceMapper(),
    )
    userRepository = new TypeORMSharedVaultUserRepository(
      transactionAwareORMRepository(
        dataSource.getRepository(TypeORMSharedVaultUser),
        TypeORMSharedVaultUser,
        transactionContext,
      ),
      new SharedVaultUserPersistenceMapper(),
    )
    vaultRepository = new TypeORMSharedVaultRepository(
      transactionAwareORMRepository(
        dataSource.getRepository(TypeORMSharedVault),
        TypeORMSharedVault,
        transactionContext,
      ),
      new SharedVaultPersistenceMapper(),
    )
    failOutbox = false
    failPrimary = false
    eventIdIndex = 0
    const controlledOutbox = new Proxy(outboxRepository, {
      get: (target, property) => {
        if (property === 'enqueue') {
          return async (event: DomainEventInterface) => {
            if (failOutbox && event.type === 'INVITE_REALTIME_INVALIDATION_REQUESTED') {
              throw new Error('forced realtime outbox failure')
            }
            return target.enqueue(event)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SyncCommandOutboxRepositoryInterface
    const rawPublisher: DomainEventPublisherInterface = { publish: jest.fn().mockResolvedValue(undefined) }
    publisher = new TransactionAwareDomainEventPublisher(rawPublisher, outboxRepository, transactionContext)
    runner = new InviteMutationTransactionRunner(dataSource, transactionContext, { wake: jest.fn() })
    producer = new InviteRealtimeDomainEventProducer(
      controlledOutbox,
      () => 1_787_097_600_000,
      () => realtimeEventIds[eventIdIndex++] as string,
    )
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it.each<Lifecycle>(['create', 'update', 'accept', 'cancel', 'remove'])(
    '%s rolls back its primary writes when realtime outbox enqueue fails, then retries with stable event identities',
    async (lifecycle) => {
      const fixture = await buildLifecycle(lifecycle)
      const before = await fixture.snapshot()
      failOutbox = true

      await expect(fixture.execute()).rejects.toThrow('forced realtime outbox failure')

      expect(await fixture.snapshot()).toEqual(before)
      expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(0)

      failOutbox = false
      eventIdIndex = 0
      const result = await fixture.execute()
      expect(result.isFailed()).toBe(false)
      const events = await dataSource.getRepository(TypeORMSyncCommandOutbox).find({ order: { uuid: 'ASC' } })
      expect(events).toHaveLength(lifecycle === 'accept' ? 2 : 1)
      expect(events.map((event) => event.uuid)).toEqual(realtimeEventIds.slice(0, events.length))
      expect(new Set(events.map((event) => event.uuid)).size).toBe(events.length)
      expect(events.every((event) => !event.eventJson.includes('encrypted-message'))).toBe(true)
    },
  )

  it.each<Lifecycle>(['create', 'update', 'accept', 'cancel', 'remove'])(
    '%s leaves no outbox event when its primary write fails',
    async (lifecycle) => {
      const fixture = await buildLifecycle(lifecycle)
      const before = await fixture.snapshot()
      failPrimary = true

      await expect(fixture.execute()).rejects.toThrow('forced primary write failure')

      expect(await fixture.snapshot()).toEqual(before)
      expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(0)
    },
  )

  async function buildLifecycle(lifecycle: Lifecycle): Promise<{
    execute: () => Promise<Result<unknown>>
    snapshot: () => Promise<unknown>
  }> {
    const inviteRepo = failOnMethod(
      inviteRepository,
      lifecycle === 'create' || lifecycle === 'update' ? 'save' : 'remove',
    )
    const usersRepo = failOnMethod(userRepository, 'remove')
    const timer = { getTimestampInMicroseconds: () => 200 } as TimerInterface
    const factory = {
      createUserInvitedToSharedVaultEvent: ({ invite }: { invite: unknown }) => legacyEvent('USER_INVITED', invite),
      createUserRemovedFromSharedVaultEvent: (payload: unknown) => legacyEvent('USER_REMOVED', payload),
    } as unknown as DomainEventFactoryInterface
    const logger = { error: jest.fn() } as unknown as Logger
    const notification = { execute: jest.fn().mockResolvedValue(Result.ok()) }

    if (lifecycle === 'create') {
      await seedVault()
      const useCase = new InviteUserToSharedVault(
        vaultRepository,
        inviteRepo,
        userRepository,
        timer,
        factory,
        publisher,
        { execute: jest.fn().mockResolvedValue(Result.ok()) } as never,
        logger,
        runner,
        producer,
      )
      return {
        execute: () =>
          useCase.execute({
            sharedVaultUuid: vaultUuid,
            senderUuid: ownerUuid,
            recipientUuid: memberUuid,
            encryptedMessage: 'encrypted-message',
            permission: 'write',
          }),
        snapshot: () => dataSource.getRepository(TypeORMSharedVaultInvite).find(),
      }
    }

    await seedInvite()
    if (lifecycle === 'update') {
      const useCase = new UpdateSharedVaultInvite(inviteRepo, timer, runner, producer)
      return {
        execute: () =>
          useCase.execute({
            inviteUuid,
            senderUuid: ownerUuid,
            encryptedMessage: 'updated-encrypted-message',
            permission: 'read',
          }),
        snapshot: () => dataSource.getRepository(TypeORMSharedVaultInvite).find(),
      }
    }

    if (lifecycle === 'accept') {
      const addUser = {
        execute: async () => {
          const membership = sharedVaultUser(membershipUuid, memberUuid)
          await userRepository.save(membership)
          return Result.ok(membership)
        },
      } as AddUserToSharedVault
      const useCase = new AcceptInviteToSharedVault(addUser, inviteRepo, userRepository, runner, producer)
      return {
        execute: () => useCase.execute({ inviteUuid, originatorUuid: memberUuid }),
        snapshot: async () => ({
          invites: await dataSource.getRepository(TypeORMSharedVaultInvite).find(),
          users: await dataSource.getRepository(TypeORMSharedVaultUser).find(),
        }),
      }
    }

    if (lifecycle === 'cancel') {
      const useCase = new CancelInviteToSharedVault(inviteRepo, notification as never, runner, producer)
      return {
        execute: () => useCase.execute({ inviteUuid, userUuid: ownerUuid }),
        snapshot: () => dataSource.getRepository(TypeORMSharedVaultInvite).find(),
      }
    }

    await seedVault()
    await userRepository.save(sharedVaultUser('30000000-0000-4000-8000-000000000010', ownerUuid))
    await userRepository.save(sharedVaultUser(membershipUuid, memberUuid))
    const useCase = new RemoveUserFromSharedVault(
      usersRepo,
      vaultRepository,
      notification as never,
      notification as never,
      factory,
      publisher,
      runner,
      producer,
    )
    return {
      execute: () => useCase.execute({ sharedVaultUuid: vaultUuid, userUuid: memberUuid, originatorUuid: ownerUuid }),
      snapshot: () => dataSource.getRepository(TypeORMSharedVaultUser).find({ order: { uuid: 'ASC' } }),
    }
  }

  function failOnMethod<T extends object>(target: T, method: string): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value = Reflect.get(object, property, object)
        if (property === method && typeof value === 'function') {
          return async (...args: unknown[]) => {
            if (failPrimary) {
              throw new Error('forced primary write failure')
            }
            return value.apply(object, args)
          }
        }
        return typeof value === 'function' ? value.bind(object) : value
      },
    })
  }

  async function seedVault(): Promise<void> {
    await dataSource.getRepository(TypeORMSharedVault).insert({
      uuid: vaultUuid,
      userUuid: ownerUuid,
      fileUploadBytesUsed: 0,
      createdAtTimestamp: 100,
      updatedAtTimestamp: 100,
    })
  }

  async function seedInvite(): Promise<void> {
    await dataSource.getRepository(TypeORMSharedVaultInvite).insert({
      uuid: inviteUuid,
      sharedVaultUuid: vaultUuid,
      userUuid: memberUuid,
      senderUuid: ownerUuid,
      encryptedMessage: 'encrypted-message',
      permission: 'write',
      createdAtTimestamp: 100,
      updatedAtTimestamp: 100,
    })
  }

  function sharedVaultUser(uuid: string, userUuid: string): SharedVaultUser {
    return SharedVaultUser.create(
      {
        userUuid: Uuid.create(userUuid).getValue(),
        sharedVaultUuid: Uuid.create(vaultUuid).getValue(),
        permission: SharedVaultUserPermission.create('write').getValue(),
        timestamps: Timestamps.create(100, 100).getValue(),
        isDesignatedSurvivor: false,
      },
      new UniqueEntityId(uuid),
    ).getValue()
  }

  function legacyEvent(type: string, payload: unknown): DomainEventInterface {
    return {
      type,
      createdAt: new Date(1_787_097_600_000),
      payload,
      meta: {
        correlation: { userIdentifier: ownerUuid, userIdentifierType: 'uuid' },
        origin: 'syncing-server',
      },
    } as DomainEventInterface
  }
})
