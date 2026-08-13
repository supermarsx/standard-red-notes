import { MapperInterface, SettingName, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { DataSource, EntityManager } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'

import {
  EmailBackupStateRepositoryInterface,
  EmailBackupStateRepositoryResult,
  EmailBackupStateMutation,
} from '../../Domain/Email/EmailBackupStateRepositoryInterface'
import {
  EmailBackupDeliveryState,
  emptyEmailBackupDeliveryState,
  parseEmailBackupDeliveryState,
  serializeEmailBackupDeliveryState,
} from '../../Domain/Email/EmailBackupDeliveryState'
import { EncryptionVersion } from '../../Domain/Encryption/EncryptionVersion'
import { Setting } from '../../Domain/Setting/Setting'
import { SettingCrypterInterface } from '../../Domain/Setting/SettingCrypterInterface'
import { User } from '../../Domain/User/User'
import { runAuthTypeORMTransaction } from './AuthTypeORMTransactionCoordinator'
import { TypeORMNextcloudBackupUserLock } from './TypeORMNextcloudBackupUserLock'
import { TypeORMSetting } from './TypeORMSetting'

type InProcessQueue = Map<string, Promise<void>>
const inProcessQueues = new WeakMap<DataSource, InProcessQueue>()

/**
 * Uses the existing per-user backup lock row so email and Nextcloud lifecycle
 * transitions cannot race user deletion or one another. All setting I/O stays
 * on the transaction-bound EntityManager.
 */
export class TypeORMEmailBackupStateRepository implements EmailBackupStateRepositoryInterface {
  constructor(
    private readonly dataSource: DataSource,
    private readonly timer: TimerInterface,
    private readonly settingMapper: MapperInterface<Setting, TypeORMSetting>,
    private readonly settingCrypter: SettingCrypterInterface,
  ) {}

  async runExclusive<T>(
    userUuid: string,
    transition: (state: EmailBackupDeliveryState) => EmailBackupStateMutation<T> | Promise<EmailBackupStateMutation<T>>,
  ): Promise<EmailBackupStateRepositoryResult<T>> {
    return this.runInProcessQueue(userUuid, async () =>
      runAuthTypeORMTransaction(this.dataSource, async (manager) => {
        const userLock = await manager
          .createQueryBuilder()
          .update(User)
          .set({ uuid: userUuid })
          .where('uuid = :userUuid', { userUuid })
          .execute()
        if (userLock.affected !== 1) {
          return { status: 'user-not-found' } as const
        }

        await manager
          .getRepository(TypeORMNextcloudBackupUserLock)
          .upsert({ userUuid, updatedAt: this.timer.getTimestampInMicroseconds() }, ['userUuid'])

        const currentRow = await this.findLatestSetting(manager, userUuid, SettingName.NAMES.EmailBackupDeliveryState)
        const currentState = await this.decryptState(currentRow, userUuid)
        const mutation = await transition(currentState)

        if (mutation.deliveryState) {
          const serialized = serializeEmailBackupDeliveryState(mutation.deliveryState)
          const encrypted = await this.settingCrypter.encryptValue(serialized, Uuid.create(userUuid).getValue())
          await this.writeSetting(
            manager,
            userUuid,
            SettingName.NAMES.EmailBackupDeliveryState,
            encrypted,
            true,
            EncryptionVersion.Default,
            currentRow,
          )
        }
        if (mutation.lastSentAt !== undefined) {
          const currentLastSent = await this.findLatestSetting(manager, userUuid, SettingName.NAMES.EmailBackupLastSent)
          await this.writeSetting(
            manager,
            userUuid,
            SettingName.NAMES.EmailBackupLastSent,
            String(mutation.lastSentAt),
            false,
            EncryptionVersion.Unencrypted,
            currentLastSent,
          )
        }

        return { status: 'available', value: mutation.result } as const
      }),
    )
  }

  private async decryptState(row: TypeORMSetting | null, userUuid: string): Promise<EmailBackupDeliveryState> {
    if (!row) {
      return emptyEmailBackupDeliveryState()
    }

    const decrypted = await this.settingCrypter.decryptSettingValue(this.settingMapper.toDomain(row), userUuid)
    return parseEmailBackupDeliveryState(decrypted ?? '')
  }

  private async findLatestSetting(
    manager: EntityManager,
    userUuid: string,
    name: string,
  ): Promise<TypeORMSetting | null> {
    return manager.getRepository(TypeORMSetting).findOne({
      where: { userUuid, name },
      order: { updatedAt: 'DESC', createdAt: 'DESC', uuid: 'DESC' },
    })
  }

  private async writeSetting(
    manager: EntityManager,
    userUuid: string,
    name: string,
    value: string | null,
    sensitive: boolean,
    serverEncryptionVersion: EncryptionVersion,
    current: TypeORMSetting | null,
  ): Promise<void> {
    const repository = manager.getRepository(TypeORMSetting)
    const now = this.timer.getTimestampInMicroseconds()
    if (current) {
      await repository.update(current.uuid, { value, updatedAt: now, sensitive, serverEncryptionVersion })
      return
    }

    await repository.insert({
      uuid: uuidv4(),
      name,
      value,
      serverEncryptionVersion,
      createdAt: now,
      updatedAt: now,
      userUuid,
      sensitive,
    })
  }

  private async runInProcessQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const queue = inProcessQueues.get(this.dataSource) ?? new Map<string, Promise<void>>()
    inProcessQueues.set(this.dataSource, queue)
    const previous = queue.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    queue.set(key, current)

    await previous
    try {
      return await operation()
    } finally {
      release()
      if (queue.get(key) === current) {
        queue.delete(key)
      }
      if (queue.size === 0) {
        inProcessQueues.delete(this.dataSource)
      }
    }
  }
}
