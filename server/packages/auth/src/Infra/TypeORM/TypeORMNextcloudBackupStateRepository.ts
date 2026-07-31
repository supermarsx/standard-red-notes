import { SettingName } from '@standardnotes/domain-core'
import { DataSource, EntityManager, In } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { TimerInterface } from '@standardnotes/time'

import {
  NextcloudBackupStateRepositoryInterface,
  NextcloudBackupStateRepositoryResult,
  PersistedNextcloudBackupSettingValue,
  PersistedNextcloudBackupState,
} from '../../Domain/Setting/NextcloudBackupStateRepositoryInterface'
import { User } from '../../Domain/User/User'
import { TypeORMNextcloudBackupUserLock } from './TypeORMNextcloudBackupUserLock'
import { TypeORMSetting } from './TypeORMSetting'
import { runAuthTypeORMTransaction } from './AuthTypeORMTransactionCoordinator'

type InProcessQueue = Map<string, Promise<void>>
const inProcessQueues = new WeakMap<DataSource, InProcessQueue>()
let activeInProcessQueueKeyCount = 0

export function nextcloudBackupInProcessQueueCountForTesting(): number {
  return activeInProcessQueueKeyCount
}

/**
 * Serializes backup lifecycle transitions across auth processes.
 *
 * A no-op user-row update is deliberately first: it proves the user exists and
 * serializes against deletion. The lock-row upsert follows and serializes the
 * lifecycle, including when two processes race to create its first row. All
 * reads and writes use the same EntityManager, so a replica or injected global
 * repository can never escape the transaction boundary.
 */
export class TypeORMNextcloudBackupStateRepository implements NextcloudBackupStateRepositoryInterface {
  constructor(
    private dataSource: DataSource,
    private timer: TimerInterface,
  ) {}

  async runExclusive<T>(
    userUuid: string,
    transition: (state: PersistedNextcloudBackupState) => {
      result: T
      deliveryStateValue?: string
      lastSuccessAtValue?: string
    },
  ): Promise<NextcloudBackupStateRepositoryResult<T>> {
    return this.runInProcessQueue(userUuid, async () => this.runDatabaseTransaction(userUuid, transition))
  }

  private async runDatabaseTransaction<T>(
    userUuid: string,
    transition: (state: PersistedNextcloudBackupState) => {
      result: T
      deliveryStateValue?: string
      lastSuccessAtValue?: string
    },
  ): Promise<NextcloudBackupStateRepositoryResult<T>> {
    return runAuthTypeORMTransaction(this.dataSource, async (manager) => {
      // A no-op update both proves the parent user still exists and locks that
      // row against deletion. If deletion won the race, no lifecycle row is
      // recreated and the caller receives a terminal user-not-found result.
      const userLock = await manager
        .createQueryBuilder()
        .update(User)
        .set({ uuid: userUuid })
        .where('uuid = :userUuid', { userUuid })
        .execute()
      if (userLock.affected !== 1) {
        return { status: 'user-not-found' }
      }

      await manager.getRepository(TypeORMNextcloudBackupUserLock).upsert(
        {
          userUuid,
          updatedAt: this.timer.getTimestampInMicroseconds(),
        },
        ['userUuid'],
      )

      const state = await this.readState(manager, userUuid)
      const mutation = transition(state)

      if (mutation.deliveryStateValue !== undefined) {
        await this.writeSetting(
          manager,
          userUuid,
          SettingName.NAMES.NextcloudBackupDeliveryState,
          mutation.deliveryStateValue,
          true,
          state.deliveryState,
        )
      }
      if (mutation.lastSuccessAtValue !== undefined) {
        await this.writeSetting(
          manager,
          userUuid,
          SettingName.NAMES.NextcloudBackupLastRun,
          mutation.lastSuccessAtValue,
          false,
          state.lastSuccessAt,
        )
      }

      return { status: 'available', value: mutation.result }
    })
  }

  private async runInProcessQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const queue = inProcessQueues.get(this.dataSource) ?? new Map<string, Promise<void>>()
    inProcessQueues.set(this.dataSource, queue)
    const previous = queue.get(key) ?? Promise.resolve()
    if (!queue.has(key)) {
      activeInProcessQueueKeyCount++
    }

    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    queue.set(key, current)

    await previous
    try {
      return await operation()
    } finally {
      release()
      if (queue.get(key) === current) {
        queue.delete(key)
        activeInProcessQueueKeyCount--
      }
      if (queue.size === 0) {
        inProcessQueues.delete(this.dataSource)
      }
    }
  }

  private async readState(manager: EntityManager, userUuid: string): Promise<PersistedNextcloudBackupState> {
    const names = [SettingName.NAMES.NextcloudBackupDeliveryState, SettingName.NAMES.NextcloudBackupLastRun]
    const rows = await manager.getRepository(TypeORMSetting).find({
      where: {
        userUuid,
        name: In(names),
      },
      order: {
        updatedAt: 'DESC',
        createdAt: 'DESC',
        uuid: 'DESC',
      },
    })

    const deliveryState = rows.find((row) => row.name === SettingName.NAMES.NextcloudBackupDeliveryState)
    const lastSuccessAt = rows.find((row) => row.name === SettingName.NAMES.NextcloudBackupLastRun)

    return {
      deliveryState: this.toPersistedValue(deliveryState),
      lastSuccessAt: this.toPersistedValue(lastSuccessAt),
    }
  }

  private toPersistedValue(row: TypeORMSetting | undefined): PersistedNextcloudBackupSettingValue {
    return row ? { exists: true, value: row.value } : { exists: false, value: null }
  }

  private async writeSetting(
    manager: EntityManager,
    userUuid: string,
    name: string,
    value: string,
    sensitive: boolean,
    current: PersistedNextcloudBackupSettingValue,
  ): Promise<void> {
    const repository = manager.getRepository(TypeORMSetting)
    // Settings timestamps are microseconds throughout auth. Milliseconds here
    // would make a freshly updated row sort behind legacy duplicate rows.
    const now = this.timer.getTimestampInMicroseconds()

    if (current.exists) {
      const latest = await repository.findOne({
        where: { userUuid, name },
        order: { updatedAt: 'DESC', createdAt: 'DESC', uuid: 'DESC' },
      })
      if (latest) {
        await repository.update(latest.uuid, {
          value,
          updatedAt: now,
          sensitive,
          serverEncryptionVersion: 0,
        })

        return
      }
    }

    await repository.insert({
      uuid: uuidv4(),
      name,
      value,
      serverEncryptionVersion: 0,
      createdAt: now,
      updatedAt: now,
      userUuid,
      sensitive,
    })
  }
}
