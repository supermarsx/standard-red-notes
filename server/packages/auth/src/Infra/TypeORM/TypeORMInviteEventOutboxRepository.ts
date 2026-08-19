import { createHash } from 'node:crypto'

import {
  DomainEventService,
  InviteRealtimeInvalidationRequestedEvent,
  isInviteRealtimeInvalidationRequestedEventPayload,
} from '@standardnotes/domain-events'
import { Brackets, Repository } from 'typeorm'

import {
  ClaimedInviteEventOutboxRecord,
  InviteEventOutboxRepositoryInterface,
} from '../../Domain/Invite/InviteEventOutboxRepositoryInterface'
import { AuthInviteEventTransactionContext } from './AuthInviteEventTransactionContext'
import { runAuthTypeORMTransaction } from './AuthTypeORMTransactionCoordinator'
import { TypeORMInviteEventOutbox } from './TypeORMInviteEventOutbox'

export class TypeORMInviteEventOutboxRepository implements InviteEventOutboxRepositoryInterface {
  constructor(
    private readonly ormRepository: Repository<TypeORMInviteEventOutbox>,
    private readonly transactionContext: AuthInviteEventTransactionContext,
    private readonly clock: () => number = Date.now,
  ) {}

  async enqueue(event: InviteRealtimeInvalidationRequestedEvent): Promise<'inserted' | 'duplicate'> {
    const canonical = canonicalEvent(event)
    const eventJson = JSON.stringify(canonical)
    const affectedUserUuidsJson = JSON.stringify(canonical.payload.affectedUserUuids)
    const now = this.clock()
    const row = {
      uuid: canonical.eventId,
      eventJson,
      affectedUserUuidsJson,
      fanoutHash: fanoutHash(canonical.payload.affectedUserUuids),
      status: 'pending' as const,
      attempts: 0,
      availableAtTimestamp: now,
      lockedAtTimestamp: null,
      lockToken: null,
      lastAttemptAtTimestamp: null,
      lastErrorCode: null,
      createdAtTimestamp: now,
      updatedAtTimestamp: now,
      publishedAtTimestamp: null,
    }

    try {
      await this.repository.insert(row)
      return 'inserted'
    } catch (error) {
      const existing = await this.repository.findOne({ where: { uuid: canonical.eventId } })
      if (!existing) {
        throw error
      }
      if (existing.eventJson !== eventJson || existing.affectedUserUuidsJson !== affectedUserUuidsJson) {
        throw new Error('Invite event outbox identity conflicts with a different payload.')
      }
      return 'duplicate'
    }
  }

  async claimNext(
    nowTimestamp: number,
    staleBeforeTimestamp: number,
    lockToken: string,
    maximumAttempts: number,
  ): Promise<ClaimedInviteEventOutboxRecord | null> {
    assertLeaseArguments(nowTimestamp, staleBeforeTimestamp, lockToken, maximumAttempts)
    // The attempt-limit sweep and the claim must see one connection's view of the
    // table, which a raw `createQueryRunner('master')` used to provide. Route it
    // through the shared coordinator instead: same single-connection guarantee,
    // plus the SQLite serialization every other auth transaction relies on, and it
    // satisfies the transaction entry-point contract. Database work only in here —
    // `drain()` publishes strictly outside the claim.
    return runAuthTypeORMTransaction(this.ormRepository.manager.dataSource, async (manager) => {
      const repository = manager.getRepository(TypeORMInviteEventOutbox)

      await repository
        .createQueryBuilder()
        .update(TypeORMInviteEventOutbox)
        .set({
          status: 'failed',
          lockToken: null,
          lockedAtTimestamp: null,
          lastAttemptAtTimestamp: nowTimestamp,
          lastErrorCode: 'ATTEMPT_LIMIT_REACHED',
          updatedAtTimestamp: nowTimestamp,
        })
        .where('attempts >= :maximumAttempts', { maximumAttempts })
        .andWhere(
          new Brackets((query) => {
            query
              .where('status = :pending', { pending: 'pending' })
              .orWhere('status = :dispatching AND locked_at_timestamp < :staleBeforeTimestamp', {
                dispatching: 'dispatching',
                staleBeforeTimestamp,
              })
          }),
        )
        .execute()

      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = await repository
          .createQueryBuilder('outbox')
          .where('outbox.attempts < :maximumAttempts', { maximumAttempts })
          .andWhere(
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

        const update = await repository
          .createQueryBuilder()
          .update(TypeORMInviteEventOutbox)
          .set({
            status: 'dispatching',
            lockToken,
            lockedAtTimestamp: nowTimestamp,
            lastAttemptAtTimestamp: nowTimestamp,
            lastErrorCode: null,
            updatedAtTimestamp: nowTimestamp,
            attempts: () => 'attempts + 1',
          })
          .where('uuid = :uuid AND attempts < :maximumAttempts', { uuid: candidate.uuid, maximumAttempts })
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
        if (update.affected !== 1) {
          continue
        }

        const claimed = await repository.findOne({ where: { uuid: candidate.uuid, lockToken, status: 'dispatching' } })
        if (!claimed) {
          continue
        }
        const event = parseStoredEvent(claimed.eventJson)
        return { uuid: claimed.uuid, event, lockToken, attempts: claimed.attempts }
      }
      return null
    })
  }

  async markPublished(uuid: string, lockToken: string, publishedAtTimestamp: number): Promise<void> {
    const update = await this.repository.update(
      { uuid, status: 'dispatching', lockToken },
      {
        status: 'published',
        lockToken: null,
        lockedAtTimestamp: null,
        publishedAtTimestamp,
        updatedAtTimestamp: publishedAtTimestamp,
        lastErrorCode: null,
      },
    )
    assertClaimUpdated(update.affected)
  }

  async releaseForRetry(
    uuid: string,
    lockToken: string,
    availableAtTimestamp: number,
    errorCode: string,
    attemptedAtTimestamp: number,
  ): Promise<void> {
    const update = await this.repository.update(
      { uuid, status: 'dispatching', lockToken },
      {
        status: 'pending',
        lockToken: null,
        lockedAtTimestamp: null,
        availableAtTimestamp,
        lastAttemptAtTimestamp: attemptedAtTimestamp,
        lastErrorCode: sanitizeErrorCode(errorCode),
        updatedAtTimestamp: attemptedAtTimestamp,
      },
    )
    assertClaimUpdated(update.affected)
  }

  async markFailed(uuid: string, lockToken: string, errorCode: string, attemptedAtTimestamp: number): Promise<void> {
    const update = await this.repository.update(
      { uuid, status: 'dispatching', lockToken },
      {
        status: 'failed',
        lockToken: null,
        lockedAtTimestamp: null,
        lastAttemptAtTimestamp: attemptedAtTimestamp,
        lastErrorCode: sanitizeErrorCode(errorCode),
        updatedAtTimestamp: attemptedAtTimestamp,
      },
    )
    assertClaimUpdated(update.affected)
  }

  async requeueFailed(uuid: string, availableAtTimestamp: number): Promise<boolean> {
    const update = await this.repository.update(
      { uuid, status: 'failed' },
      {
        status: 'pending',
        attempts: 0,
        availableAtTimestamp,
        lockToken: null,
        lockedAtTimestamp: null,
        updatedAtTimestamp: availableAtTimestamp,
      },
    )
    return update.affected === 1
  }

  async deletePublishedBefore(timestamp: number): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .from(TypeORMInviteEventOutbox)
      .where('status = :status', { status: 'published' })
      .andWhere('published_at_timestamp < :timestamp', { timestamp })
      .execute()
    return result.affected ?? 0
  }

  private get repository(): Repository<TypeORMInviteEventOutbox> {
    return this.transactionContext.manager?.getRepository(TypeORMInviteEventOutbox) ?? this.ormRepository
  }
}

function canonicalEvent(event: InviteRealtimeInvalidationRequestedEvent): InviteRealtimeInvalidationRequestedEvent {
  if (
    event.type !== 'INVITE_REALTIME_INVALIDATION_REQUESTED' ||
    event.eventId !== event.payload?.recordId ||
    !isInviteRealtimeInvalidationRequestedEventPayload(event.payload)
  ) {
    throw new Error('Invite event outbox accepts metadata-only realtime invalidations.')
  }
  return {
    eventId: event.eventId,
    type: event.type,
    createdAt: new Date(event.payload.event.occurredAt),
    meta: {
      correlation: {
        userIdentifier: event.payload.affectedUserUuids[0],
        userIdentifierType: 'uuid',
      },
      origin: DomainEventService.Auth,
    },
    payload: {
      version: 1,
      recordId: event.payload.recordId,
      affectedUserUuids: [...event.payload.affectedUserUuids],
      event: { ...event.payload.event },
    },
  }
}

function parseStoredEvent(value: string): InviteRealtimeInvalidationRequestedEvent {
  const parsed = JSON.parse(value) as InviteRealtimeInvalidationRequestedEvent
  if (
    !isInviteRealtimeInvalidationRequestedEventPayload(parsed.payload) ||
    parsed.eventId !== parsed.payload.recordId
  ) {
    throw new Error('Invite event outbox record is malformed.')
  }
  parsed.createdAt = new Date(parsed.createdAt)
  return parsed
}

function fanoutHash(affectedUserUuids: readonly string[]): string {
  return createHash('sha256')
    .update([...affectedUserUuids].sort().join('\n'))
    .digest('hex')
}

function sanitizeErrorCode(value: string): string {
  const safe = value
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, '_')
    .slice(0, 64)
  return safe || 'UNKNOWN'
}

function assertLeaseArguments(now: number, staleBefore: number, token: string, maximumAttempts: number): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(staleBefore) || !Number.isInteger(maximumAttempts)) {
    throw new Error('Invite event outbox lease arguments are invalid.')
  }
  if (maximumAttempts < 1 || token.length !== 36) {
    throw new Error('Invite event outbox lease arguments are invalid.')
  }
}

function assertClaimUpdated(affected: number | null | undefined): void {
  if (affected !== 1) {
    throw new Error('Invite event outbox record lost its dispatch lease.')
  }
}
