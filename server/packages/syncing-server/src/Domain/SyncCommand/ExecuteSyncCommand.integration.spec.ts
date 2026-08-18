import { MapperInterface, Uuid } from '@standardnotes/domain-core'
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm'
import { Logger } from 'winston'

import { Metric } from '../Metrics/Metric'
import { MetricsStoreInterface } from '../Metrics/MetricsStoreInterface'
import { Notification } from '../Notifications/Notification'
import { TransactionAwareMetricsStore } from '../../Infra/Metrics/TransactionAwareMetricsStore'
import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { TransactionAwareDomainEventPublisher } from '../../Infra/TypeORM/TransactionAwareDomainEventPublisher'
import { transactionAwareORMRepository } from '../../Infra/TypeORM/TransactionAwareORMRepository'
import { TypeORMNotification } from '../../Infra/TypeORM/TypeORMNotification'
import { TypeORMNotificationRepository } from '../../Infra/TypeORM/TypeORMNotificationRepository'
import { TypeORMSyncCommand } from '../../Infra/TypeORM/TypeORMSyncCommand'
import { TypeORMSyncCommandOutbox } from '../../Infra/TypeORM/TypeORMSyncCommandOutbox'
import { TypeORMSyncCommandOutboxRepository } from '../../Infra/TypeORM/TypeORMSyncCommandOutboxRepository'
import { TypeORMSyncCommandRepository } from '../../Infra/TypeORM/TypeORMSyncCommandRepository'
import { CleanupSyncCommands } from './CleanupSyncCommands'
import { ExecuteSyncCommand } from './ExecuteSyncCommand'
import { GetSyncCommandStatus } from './GetSyncCommandStatus'
import { SyncCommandOutboxDispatcher } from './SyncCommandOutboxDispatcher'
import { computeSyncCommandDigest, SyncCommandProtocolError } from './SyncCommandTypes'

@Entity({ name: 'sync_command_test_mutations' })
class SyncCommandTestMutation {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  declare uuid: string

  @Column({ type: 'varchar', length: 255 })
  declare value: string
}

describe('durable sync command transaction integration', () => {
  let dataSource: DataSource
  let transactionContext: SyncCommandTransactionContext
  let commandRepository: TypeORMSyncCommandRepository
  let outboxRepository: TypeORMSyncCommandOutboxRepository
  let rawPublisher: jest.Mocked<DomainEventPublisherInterface>
  let dispatcher: SyncCommandOutboxDispatcher
  let executeSyncCommand: ExecuteSyncCommand
  let transactionalPublisher: TransactionAwareDomainEventPublisher

  const payload = {
    api: '20200115',
    items: [{ uuid: 'note-1', content: 'ciphertext', content_type: 'Note', deleted: false }],
    sync_token: 'token',
  }
  const metadata = { id: 'command-1', digest: computeSyncCommandDigest(payload) }
  const event = {
    type: 'SYNC_COMMAND_TEST_EVENT',
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    meta: {},
  } as unknown as DomainEventInterface

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSyncCommand, TypeORMSyncCommandOutbox, SyncCommandTestMutation],
      synchronize: true,
    })
    await dataSource.initialize()
    transactionContext = new SyncCommandTransactionContext()
    commandRepository = new TypeORMSyncCommandRepository(
      dataSource.getRepository(TypeORMSyncCommand),
      transactionContext,
    )
    outboxRepository = new TypeORMSyncCommandOutboxRepository(
      dataSource.getRepository(TypeORMSyncCommandOutbox),
      transactionContext,
    )
    rawPublisher = { publish: jest.fn().mockResolvedValue(undefined) }
    dispatcher = new SyncCommandOutboxDispatcher(
      outboxRepository,
      rawPublisher,
      { error: jest.fn() } as unknown as Logger,
      1_000,
    )
    executeSyncCommand = new ExecuteSyncCommand(dataSource, transactionContext, commandRepository, dispatcher, 60_000)
    transactionalPublisher = new TransactionAwareDomainEventPublisher(
      rawPublisher,
      outboxRepository,
      transactionContext,
    )
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('rolls item work and outbox back together, then commits and replays the exact stored response', async () => {
    await expect(
      executeSyncCommand.execute({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        metadata,
        canonicalPayload: payload,
        execute: async () => {
          await transactionContext.manager?.getRepository(SyncCommandTestMutation).insert({
            uuid: 'mutation-1',
            value: 'must-rollback',
          })
          await transactionalPublisher.publish(event)
          throw new Error('simulated process failure')
        },
      }),
    ).rejects.toThrow('simulated process failure')

    expect(await dataSource.getRepository(SyncCommandTestMutation).count()).toBe(0)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(0)
    expect(transactionContext.manager).toBeUndefined()
    expect(
      await dataSource.getRepository(TypeORMSyncCommand).findOneByOrFail({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        commandId: metadata.id,
      }),
    ).toMatchObject({ status: 'accepted', responseJson: null, executionToken: null })

    rawPublisher.publish.mockImplementation(async () => {
      expect(await dataSource.getRepository(SyncCommandTestMutation).count()).toBe(1)
      expect(
        await dataSource.getRepository(TypeORMSyncCommand).findOneByOrFail({
          userUuid: 'user-1',
          sessionUuid: 'session-1',
          commandId: metadata.id,
        }),
      ).toMatchObject({ status: 'committed' })
    })

    const first = await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute: async () => {
        await transactionContext.manager?.getRepository(SyncCommandTestMutation).insert({
          uuid: 'mutation-1',
          value: 'committed',
        })
        await transactionalPublisher.publish(event)
        return { retrieved_items: [], sync_token: 'next-token' }
      },
    })
    await dispatcher.waitForIdle()

    const stored = await dataSource.getRepository(TypeORMSyncCommand).findOneByOrFail({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: metadata.id,
    })
    expect(stored.responseJson).toBe(JSON.stringify(first.response))
    expect(rawPublisher.publish).toHaveBeenCalledTimes(1)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).findOneByOrFail({})).toMatchObject({
      status: 'published',
      attempts: 1,
    })

    const replayCallback = jest.fn(async () => ({ should_not_execute: true }))
    const replay = await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute: replayCallback,
    })

    expect(replay.replayed).toBe(true)
    expect(JSON.stringify(replay.response)).toBe(stored.responseJson)
    expect(replayCallback).not.toHaveBeenCalled()
    expect(rawPublisher.publish).toHaveBeenCalledTimes(1)
    expect(transactionContext.manager).toBeUndefined()
  })

  it('rolls back transaction-aware notification writes and discards metrics when outbox enqueue fails', async () => {
    await dataSource.destroy()
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSyncCommand, TypeORMSyncCommandOutbox, TypeORMNotification],
      synchronize: true,
    })
    await dataSource.initialize()
    transactionContext = new SyncCommandTransactionContext()
    commandRepository = new TypeORMSyncCommandRepository(
      dataSource.getRepository(TypeORMSyncCommand),
      transactionContext,
    )
    outboxRepository = new TypeORMSyncCommandOutboxRepository(
      dataSource.getRepository(TypeORMSyncCommandOutbox),
      transactionContext,
    )

    const notificationMapper = {
      toProjection: jest.fn((_notification: Notification): TypeORMNotification => ({
        uuid: '00000000-0000-4000-8000-000000000101',
        userUuid: '00000000-0000-4000-8000-000000000102',
        type: 'shared-vault-invite',
        payload: '{}',
        createdAtTimestamp: 1,
        updatedAtTimestamp: 1,
      })),
      toDomain: jest.fn(),
    } as unknown as MapperInterface<Notification, TypeORMNotification>
    const notificationRepository = new TypeORMNotificationRepository(
      transactionAwareORMRepository(
        dataSource.getRepository(TypeORMNotification),
        TypeORMNotification,
        transactionContext,
      ),
      notificationMapper,
    )

    const metricDelegate: jest.Mocked<MetricsStoreInterface> = {
      storeMetric: jest.fn().mockResolvedValue(undefined),
      storeUserBasedMetric: jest.fn().mockResolvedValue(undefined),
      getUserBasedMetricsSummaryWithinTimeRange: jest.fn(),
      getUserBasedMetricsSummary: jest.fn(),
      getMetricsSummary: jest.fn(),
    }
    const logger = { error: jest.fn() } as unknown as Logger
    const metricsStore = new TransactionAwareMetricsStore(metricDelegate, transactionContext, logger)

    let failNextEnqueue = true
    const failOnceOutbox = {
      enqueue: jest.fn(async (publishedEvent: DomainEventInterface) => {
        if (failNextEnqueue) {
          failNextEnqueue = false
          throw new Error('forced outbox failure')
        }
        await outboxRepository.enqueue(publishedEvent)
      }),
      claimNext: outboxRepository.claimNext.bind(outboxRepository),
      markPublished: outboxRepository.markPublished.bind(outboxRepository),
      releaseForRetry: outboxRepository.releaseForRetry.bind(outboxRepository),
      deletePublishedBefore: outboxRepository.deletePublishedBefore.bind(outboxRepository),
    }
    transactionalPublisher = new TransactionAwareDomainEventPublisher(rawPublisher, failOnceOutbox, transactionContext)
    dispatcher = new SyncCommandOutboxDispatcher(outboxRepository, rawPublisher, logger)
    executeSyncCommand = new ExecuteSyncCommand(dataSource, transactionContext, commandRepository, dispatcher, 60_000)

    const metric = Metric.create({ name: Metric.NAMES.ItemCreated, timestamp: 1 }).getValue()
    const userUuid = Uuid.create('00000000-0000-4000-8000-000000000102').getValue()
    const executeMutation = jest.fn(async () => {
      await notificationRepository.save({} as Notification)
      await metricsStore.storeMetric(metric)
      await metricsStore.storeUserBasedMetric(metric, 1, userUuid)
      try {
        await transactionalPublisher.publish(event)
      } catch {
        // SyncItems historically treats notification/event publication as best effort.
        // ExecuteSyncCommand must still observe the poisoned outbox context and roll back.
      }
      return { saved_items: [] }
    })

    await expect(
      executeSyncCommand.execute({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        metadata,
        canonicalPayload: payload,
        execute: executeMutation,
      }),
    ).rejects.toThrow('forced outbox failure')

    expect(await dataSource.getRepository(TypeORMNotification).count()).toBe(0)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(0)
    expect(metricDelegate.storeMetric).not.toHaveBeenCalled()
    expect(metricDelegate.storeUserBasedMetric).not.toHaveBeenCalled()
    expect(
      await dataSource.getRepository(TypeORMSyncCommand).findOneByOrFail({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        commandId: metadata.id,
      }),
    ).toMatchObject({ status: 'accepted', responseJson: null, executionToken: null })

    const committed = await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute: executeMutation,
    })
    await dispatcher.waitForIdle()

    expect(committed.replayed).toBe(false)
    expect(await dataSource.getRepository(TypeORMNotification).count()).toBe(1)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(1)
    expect(metricDelegate.storeMetric).toHaveBeenCalledTimes(1)
    expect(metricDelegate.storeUserBasedMetric).toHaveBeenCalledTimes(1)
    expect(rawPublisher.publish).toHaveBeenCalledTimes(1)

    const replayExecute = jest.fn(async () => ({ saved_items: [] }))
    const replay = await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute: replayExecute,
    })

    expect(replay.replayed).toBe(true)
    expect(replayExecute).not.toHaveBeenCalled()
    expect(await dataSource.getRepository(TypeORMNotification).count()).toBe(1)
    expect(metricDelegate.storeMetric).toHaveBeenCalledTimes(1)
    expect(metricDelegate.storeUserBasedMetric).toHaveBeenCalledTimes(1)
    expect(rawPublisher.publish).toHaveBeenCalledTimes(1)
  })

  it('returns the committed command without awaiting an unrelated global outbox drain', async () => {
    let releasePublish: (() => void) | undefined
    let signalPublishStarted: (() => void) | undefined
    const publishStarted = new Promise<void>((resolve) => {
      signalPublishStarted = resolve
    })
    rawPublisher.publish.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePublish = resolve
          signalPublishStarted?.()
        }),
    )

    const result = await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute: async () => {
        await transactionalPublisher.publish(event)
        return { saved_items: [] }
      },
    })
    await publishStarted

    expect(result.replayed).toBe(false)
    expect(result.response.command.status).toBe('committed')
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).findOneByOrFail({})).toMatchObject({
      status: 'dispatching',
    })

    releasePublish?.()
    await dispatcher.waitForIdle()
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).findOneByOrFail({})).toMatchObject({
      status: 'published',
    })
  })

  it('keeps the same opaque command id isolated by both user and session and rejects digest changes', async () => {
    const execute = async () => ({ saved_items: [] })
    await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute,
    })
    await executeSyncCommand.execute({
      userUuid: 'user-2',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute,
    })
    await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-2',
      metadata,
      canonicalPayload: payload,
      execute,
    })

    expect(await dataSource.getRepository(TypeORMSyncCommand).count()).toBe(3)
    await expect(
      executeSyncCommand.execute({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        metadata: { id: metadata.id, digest: computeSyncCommandDigest({ ...payload, sync_token: 'changed' }) },
        canonicalPayload: { ...payload, sync_token: 'changed' },
        execute,
      }),
    ).rejects.toMatchObject<Partial<SyncCommandProtocolError>>({
      code: 'sync_command_digest_mismatch',
      httpStatus: 409,
    })
  })

  it('reports accepted, committed, and scope-opaque unknown status and removes expired records', async () => {
    await dataSource.getRepository(TypeORMSyncCommand).insert({
      uuid: 'accepted-1',
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      commandId: metadata.id,
      requestDigest: metadata.digest,
      status: 'accepted',
      responseJson: null,
      executionToken: null,
      createdAtTimestamp: 1,
      updatedAtTimestamp: 1,
      expiresAtTimestamp: Date.now() + 60_000,
    })
    const getStatus = new GetSyncCommandStatus(commandRepository)

    expect(
      await getStatus.execute({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        commandId: metadata.id,
        requestDigest: metadata.digest,
      }),
    ).toEqual({ command: { id: metadata.id, digest: metadata.digest, status: 'accepted' }, result: undefined })
    expect(
      await getStatus.execute({
        userUuid: 'different-user',
        sessionUuid: 'session-1',
        commandId: metadata.id,
      }),
    ).toEqual({ command: { id: metadata.id, status: 'unknown' } })

    await dataSource
      .getRepository(TypeORMSyncCommand)
      .update(
        { uuid: 'accepted-1' },
        { status: 'committed', responseJson: JSON.stringify({ saved_items: [] }), expiresAtTimestamp: 1 },
      )
    expect(
      await getStatus.execute({
        userUuid: 'user-1',
        sessionUuid: 'session-1',
        commandId: metadata.id,
        requestDigest: metadata.digest,
      }),
    ).toEqual({
      command: { id: metadata.id, digest: metadata.digest, status: 'committed' },
      result: { saved_items: [] },
    })
    const retainedReplayExecute = jest.fn(async () => ({ should_not_execute: true }))
    const retainedReplay = await executeSyncCommand.execute({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata,
      canonicalPayload: payload,
      execute: retainedReplayExecute,
    })
    expect(retainedReplay.replayed).toBe(true)
    expect(retainedReplayExecute).not.toHaveBeenCalled()

    await dataSource.getRepository(TypeORMSyncCommandOutbox).insert({
      uuid: 'published-1',
      eventJson: JSON.stringify(event),
      status: 'published',
      attempts: 1,
      availableAtTimestamp: 1,
      lockedAtTimestamp: null,
      lockToken: null,
      createdAtTimestamp: 1,
      updatedAtTimestamp: 1,
      publishedAtTimestamp: 1,
    })

    const cleanup = new CleanupSyncCommands(commandRepository, outboxRepository, 100)
    expect(await cleanup.execute(1_000)).toEqual({ commands: 1, outboxEvents: 1 })
    expect(await dataSource.getRepository(TypeORMSyncCommand).count()).toBe(0)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(0)
  })

  it('retries a failed outbox publish with the same stable event id and does not double-claim concurrently', async () => {
    await dataSource.transaction((manager) =>
      transactionContext.run(manager, async () => {
        await transactionalPublisher.publish(event)
      }),
    )

    rawPublisher.publish.mockRejectedValueOnce(new Error('temporary broker failure')).mockResolvedValue(undefined)
    expect(await dispatcher.dispatchAvailable()).toBe(0)
    const firstAttempt = rawPublisher.publish.mock.calls[0][0] as DomainEventInterface & { eventId?: string }
    expect(firstAttempt.eventId).toEqual(expect.any(String))
    await dataSource
      .getRepository(TypeORMSyncCommandOutbox)
      .update({ status: 'pending' }, { availableAtTimestamp: Date.now() - 1 })

    const secondDispatcher = new SyncCommandOutboxDispatcher(
      outboxRepository,
      rawPublisher,
      { error: jest.fn() } as unknown as Logger,
      1_000,
    )
    const counts = await Promise.all([dispatcher.dispatchAvailable(), secondDispatcher.dispatchAvailable()])
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1)
    const secondAttempt = rawPublisher.publish.mock.calls[1][0] as DomainEventInterface & { eventId?: string }
    expect(secondAttempt.eventId).toBe(firstAttempt.eventId)
    expect(rawPublisher.publish).toHaveBeenCalledTimes(2)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).findOneByOrFail({})).toMatchObject({
      status: 'published',
      attempts: 2,
    })
  })
})
