import { randomUUID } from 'crypto'
import { Brackets, Repository } from 'typeorm'
import { DomainEventInterface } from '@standardnotes/domain-events'

import {
  ClaimedSyncCommandOutboxEvent,
  SyncCommandOutboxRepositoryInterface,
} from '../../Domain/SyncCommand/SyncCommandOutboxRepositoryInterface'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { TypeORMSyncCommandOutbox } from './TypeORMSyncCommandOutbox'

export class TypeORMSyncCommandOutboxRepository implements SyncCommandOutboxRepositoryInterface {
  constructor(
    private readonly ormRepository: Repository<TypeORMSyncCommandOutbox>,
    private readonly transactionContext: SyncCommandTransactionContext,
  ) {}

  async enqueue(event: DomainEventInterface): Promise<void> {
    const now = Date.now()
    const uuid = event.eventId ?? randomUUID()
    const durableEvent: DomainEventInterface = { ...event, eventId: uuid }

    await this.repository.insert({
      uuid,
      eventJson: JSON.stringify(durableEvent),
      status: 'pending',
      attempts: 0,
      availableAtTimestamp: now,
      lockedAtTimestamp: null,
      lockToken: null,
      createdAtTimestamp: now,
      updatedAtTimestamp: now,
      publishedAtTimestamp: null,
    })
  }

  async claimNext(
    nowTimestamp: number,
    staleBeforeTimestamp: number,
    lockToken: string,
  ): Promise<ClaimedSyncCommandOutboxEvent | null> {
    const queryRunner = this.ormRepository.manager.dataSource.createQueryRunner('master')

    try {
      await queryRunner.connect()
      const repository = queryRunner.manager.getRepository(TypeORMSyncCommandOutbox)

      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = await repository
          .createQueryBuilder('outbox')
          .where(
            new Brackets((query) => {
              query
                .where('outbox.status = :pending AND outbox.available_at_timestamp <= :nowTimestamp', {
                  pending: 'pending',
                  nowTimestamp,
                })
                .orWhere('outbox.status = :dispatching AND outbox.locked_at_timestamp < :staleBeforeTimestamp', {
                  dispatching: 'dispatching',
                  staleBeforeTimestamp,
                })
            }),
          )
          .orderBy('outbox.created_at_timestamp', 'ASC')
          .getOne()

        if (!candidate) {
          return null
        }

        const result = await repository
          .createQueryBuilder()
          .update(TypeORMSyncCommandOutbox)
          .set({
            status: 'dispatching',
            lockToken,
            lockedAtTimestamp: nowTimestamp,
            updatedAtTimestamp: nowTimestamp,
            attempts: () => 'attempts + 1',
          })
          .where('uuid = :uuid', { uuid: candidate.uuid })
          .andWhere(
            new Brackets((query) => {
              query
                .where('status = :pending AND available_at_timestamp <= :nowTimestamp', {
                  pending: 'pending',
                  nowTimestamp,
                })
                .orWhere('status = :dispatching AND locked_at_timestamp < :staleBeforeTimestamp', {
                  dispatching: 'dispatching',
                  staleBeforeTimestamp,
                })
            }),
          )
          .execute()

        if (result.affected !== 1) {
          continue
        }

        const claimed = await repository.findOne({ where: { uuid: candidate.uuid, lockToken } })
        if (!claimed) {
          continue
        }

        const event = JSON.parse(claimed.eventJson) as DomainEventInterface
        if (typeof event.createdAt === 'string') {
          event.createdAt = new Date(event.createdAt)
        }

        return { uuid: claimed.uuid, event, lockToken }
      }

      return null
    } finally {
      await queryRunner.release()
    }
  }

  async markPublished(uuid: string, lockToken: string, publishedAtTimestamp: number): Promise<void> {
    const result = await this.repository.update(
      { uuid, status: 'dispatching', lockToken },
      {
        status: 'published',
        lockToken: null,
        lockedAtTimestamp: null,
        publishedAtTimestamp,
        updatedAtTimestamp: publishedAtTimestamp,
      },
    )

    if (result.affected !== 1) {
      throw new Error('Sync command outbox event lost its dispatch claim.')
    }
  }

  async releaseForRetry(uuid: string, lockToken: string, availableAtTimestamp: number): Promise<void> {
    await this.repository.update(
      { uuid, status: 'dispatching', lockToken },
      {
        status: 'pending',
        lockToken: null,
        lockedAtTimestamp: null,
        availableAtTimestamp,
        updatedAtTimestamp: Date.now(),
      },
    )
  }

  async deletePublishedBefore(timestamp: number): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .from(TypeORMSyncCommandOutbox)
      .where('status = :status', { status: 'published' })
      .andWhere('published_at_timestamp < :timestamp', { timestamp })
      .execute()

    return result.affected ?? 0
  }

  private get repository(): Repository<TypeORMSyncCommandOutbox> {
    return this.transactionContext.manager?.getRepository(TypeORMSyncCommandOutbox) ?? this.ormRepository
  }
}
