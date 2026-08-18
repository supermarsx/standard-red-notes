import { Repository } from 'typeorm'

import {
  StoredSyncCommand,
  SyncCommandRepositoryInterface,
} from '../../Domain/SyncCommand/SyncCommandRepositoryInterface'
import { TypeORMSyncCommand } from './TypeORMSyncCommand'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'

export class TypeORMSyncCommandRepository implements SyncCommandRepositoryInterface {
  constructor(
    private readonly ormRepository: Repository<TypeORMSyncCommand>,
    private readonly transactionContext: SyncCommandTransactionContext,
  ) {}

  async insertAcceptedIfAbsent(command: StoredSyncCommand): Promise<void> {
    const now = Date.now()
    await this.repository
      .createQueryBuilder()
      .insert()
      .into(TypeORMSyncCommand)
      .values({
        ...command,
        responseJson: null,
        executionToken: null,
        createdAtTimestamp: now,
        updatedAtTimestamp: now,
      })
      .orIgnore()
      .execute()
  }

  async find(userUuid: string, sessionUuid: string, commandId: string): Promise<StoredSyncCommand | null> {
    const transactionManager = this.transactionContext.manager
    if (transactionManager) {
      const command = await transactionManager
        .getRepository(TypeORMSyncCommand)
        .findOne({ where: { userUuid, sessionUuid, commandId } })

      return command ? this.toDomain(command) : null
    }

    const queryRunner = this.ormRepository.manager.dataSource.createQueryRunner('master')

    try {
      await queryRunner.connect()
      const command = await queryRunner.manager
        .getRepository(TypeORMSyncCommand)
        .findOne({ where: { userUuid, sessionUuid, commandId } })

      return command ? this.toDomain(command) : null
    } finally {
      await queryRunner.release()
    }
  }

  async claimAccepted(uuid: string, executionToken: string): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(TypeORMSyncCommand)
      .set({ executionToken, updatedAtTimestamp: Date.now() })
      .where('uuid = :uuid', { uuid })
      .andWhere('status = :status', { status: 'accepted' })
      .andWhere('execution_token IS NULL')
      .execute()

    return result.affected === 1
  }

  async commit(uuid: string, executionToken: string, responseJson: string, expiresAtTimestamp: number): Promise<void> {
    const result = await this.repository
      .createQueryBuilder()
      .update(TypeORMSyncCommand)
      .set({
        status: 'committed',
        responseJson,
        executionToken: null,
        updatedAtTimestamp: Date.now(),
        expiresAtTimestamp,
      })
      .where('uuid = :uuid', { uuid })
      .andWhere('status = :status', { status: 'accepted' })
      .andWhere('execution_token = :executionToken', { executionToken })
      .execute()

    if (result.affected !== 1) {
      throw new Error('Sync command lost its execution claim before commit.')
    }
  }

  async deleteExpired(nowTimestamp: number): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .from(TypeORMSyncCommand)
      .where('expires_at_timestamp < :nowTimestamp', { nowTimestamp })
      .execute()

    return result.affected ?? 0
  }

  private get repository(): Repository<TypeORMSyncCommand> {
    return this.transactionContext.manager?.getRepository(TypeORMSyncCommand) ?? this.ormRepository
  }

  private toDomain(command: TypeORMSyncCommand): StoredSyncCommand {
    return {
      uuid: command.uuid,
      userUuid: command.userUuid,
      sessionUuid: command.sessionUuid,
      commandId: command.commandId,
      requestDigest: command.requestDigest,
      status: command.status,
      responseJson: command.responseJson,
      expiresAtTimestamp: Number(command.expiresAtTimestamp),
    }
  }
}
