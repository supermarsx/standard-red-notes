import 'reflect-metadata'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { TimerInterface } from '@standardnotes/time'
import { DataSource } from 'typeorm'

import { AUTH_TYPEORM_ENTITIES } from '../../Bootstrap/DataSource'
import {
  EmailBackupDeliveryState,
  PendingEmailBackupBatch,
  emptyEmailBackupDeliveryState,
  recordPendingEmailBackupBatch,
} from '../../Domain/Email/EmailBackupDeliveryState'
import { applyEmailBackupStatePatch } from '../../Domain/Email/EmailBackupStatePatch'
import { SettingCrypterInterface } from '../../Domain/Setting/SettingCrypterInterface'
import { User } from '../../Domain/User/User'
import { SettingPersistenceMapper } from '../../Mapping/Persistence/SettingPersistenceMapper'
import { TypeORMEmailBackupStateRepository } from './TypeORMEmailBackupStateRepository'

describe('TypeORMEmailBackupStateRepository concurrency', () => {
  const userUuid = '00000000-0000-0000-0000-000000000001'
  let temporaryDirectory: string
  let databasePath: string
  let firstDataSource: DataSource
  let secondDataSource: DataSource
  let timestamp = 1_700_000_000_000_000

  const createDataSource = (synchronize: boolean, database = databasePath) =>
    new DataSource({
      type: 'better-sqlite3',
      database,
      entities: AUTH_TYPEORM_ENTITIES,
      synchronize,
      enableWAL: true,
      prepareDatabase: (database) => database.pragma('busy_timeout = 5000'),
      logging: false,
    })

  const timer = {
    getTimestampInMicroseconds: jest.fn(() => ++timestamp),
  } as unknown as TimerInterface
  const crypter = {
    encryptValue: jest.fn(async (value: string | null) => value),
    decryptSettingValue: jest.fn(async (setting) => setting.props.value),
  } as unknown as SettingCrypterInterface
  const createRepository = (dataSource: DataSource) =>
    new TypeORMEmailBackupStateRepository(dataSource, timer, new SettingPersistenceMapper(), crypter)

  const batch = (id: string): PendingEmailBackupBatch => ({
    batchId: id,
    outcome: 'backup',
    queuedAt: 1_000,
    deliveries: [
      {
        deliveryId: `backup-${id.repeat(64).slice(0, 64)}`,
        queueAccepted: false,
        reference: {
          fileName: `${id}.json`,
          filePath: 'protected-backup-bucket',
          attachmentFileName: `${id}.txt`,
          attachmentContentType: 'application/json',
        },
      },
    ],
  })

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'srn-email-backup-state-'))
    databasePath = join(temporaryDirectory, 'auth.sqlite')
    firstDataSource = createDataSource(true)
    await firstDataSource.initialize()
    await firstDataSource.getRepository(User).insert({
      uuid: userUuid,
      encryptedPassword: 'test-password-hash',
      createdAt: new Date(1_700_000_000_000),
      updatedAt: new Date(1_700_000_000_000),
    })
    secondDataSource = createDataSource(false, relative(process.cwd(), databasePath))
    await secondDataSource.initialize()
  })

  afterEach(async () => {
    if (secondDataSource.isInitialized) {
      await secondDataSource.destroy()
    }
    if (firstDataSource.isInitialized) {
      await firstDataSource.destroy()
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('preserves two stale-snapshot batch plans racing across independent database connections', async () => {
    const firstRepository = createRepository(firstDataSource)
    const secondRepository = createRepository(secondDataSource)
    const firstSnapshot = emptyEmailBackupDeliveryState()
    const secondSnapshot = emptyEmailBackupDeliveryState()
    const firstNext = recordPendingEmailBackupBatch(firstSnapshot, batch('a'))
    const secondNext = recordPendingEmailBackupBatch(secondSnapshot, batch('b'))

    await Promise.all([
      firstRepository.runExclusive(userUuid, (current) => ({
        result: undefined,
        deliveryState: applyEmailBackupStatePatch(current, firstSnapshot, firstNext),
      })),
      secondRepository.runExclusive(userUuid, (current) => ({
        result: undefined,
        deliveryState: applyEmailBackupStatePatch(current, secondSnapshot, secondNext),
      })),
    ])

    const result = await firstRepository.runExclusive(userUuid, (state) => ({ result: state }))
    expect(result.status).toBe('available')
    const state = (result as { status: 'available'; value: EmailBackupDeliveryState }).value
    expect(state.pending.map((entry) => entry.batchId).sort()).toEqual(['a', 'b'])
  })

  it('merges monotonic queue receipts and completion without removing another batch', async () => {
    const repository = createRepository(firstDataSource)
    const initial = recordPendingEmailBackupBatch(
      recordPendingEmailBackupBatch(emptyEmailBackupDeliveryState(), batch('a')),
      batch('b'),
    )
    await repository.runExclusive(userUuid, () => ({ result: undefined, deliveryState: initial }))

    const acceptedA = {
      ...initial,
      pending: initial.pending.map((entry) => {
        return entry.batchId === 'a'
          ? { ...entry, deliveries: entry.deliveries.map((delivery) => ({ ...delivery, queueAccepted: true })) }
          : entry
      }),
    }
    await repository.runExclusive(userUuid, (current) => ({
      result: undefined,
      deliveryState: applyEmailBackupStatePatch(current, initial, acceptedA),
    }))

    const completedA = {
      pending: acceptedA.pending.filter((entry) => entry.batchId !== 'a'),
      completed: [{ batchId: 'a', deliveredAt: 2_000 }],
    }
    await repository.runExclusive(userUuid, (current) => ({
      result: undefined,
      deliveryState: applyEmailBackupStatePatch(current, acceptedA, completedA),
      lastSentAt: 2_000,
    }))

    const result = await repository.runExclusive(userUuid, (state) => ({ result: state }))
    const state = (result as { status: 'available'; value: EmailBackupDeliveryState }).value
    expect(state.pending.map((entry) => entry.batchId)).toEqual(['b'])
    expect(state.completed).toEqual([{ batchId: 'a', deliveredAt: 2_000 }])
  })
})
