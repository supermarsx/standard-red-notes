import {
  DomainEventPublisherInterface,
  DomainEventService,
  InviteRealtimeInvalidationRequestedEvent,
} from '@standardnotes/domain-events'
import { DataSource } from 'typeorm'

import { InviteEventOutboxDispatcher } from '../../Domain/Invite/InviteEventOutboxDispatcher'
import { AuthInviteEventTransactionContext } from './AuthInviteEventTransactionContext'
import { TypeORMInviteEventOutbox } from './TypeORMInviteEventOutbox'
import { TypeORMInviteEventOutboxRepository } from './TypeORMInviteEventOutboxRepository'

const firstUser = '00000000-0000-4000-8000-000000000001'
const secondUser = '00000000-0000-4000-8000-000000000002'
const inviteUuid = '20000000-0000-4000-8000-000000000001'
const firstEventId = '70000000-0000-4000-8000-000000000001'
const secondEventId = '70000000-0000-4000-8000-000000000002'
const firstLease = '80000000-0000-4000-8000-000000000001'
const secondLease = '80000000-0000-4000-8000-000000000002'

describe('TypeORMInviteEventOutboxRepository integration', () => {
  let dataSource: DataSource
  let repository: TypeORMInviteEventOutboxRepository
  let repositoryNow: number

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMInviteEventOutbox],
      synchronize: true,
    })
    await dataSource.initialize()
    repositoryNow = 1_000
    repository = new TypeORMInviteEventOutboxRepository(
      dataSource.getRepository(TypeORMInviteEventOutbox),
      new AuthInviteEventTransactionContext(),
      () => repositoryNow,
    )
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('enqueues idempotently, rejects identity conflicts and hashes fanout independently of order', async () => {
    expect(await repository.enqueue(event(firstEventId, [firstUser, secondUser]))).toBe('inserted')
    expect(await repository.enqueue(event(firstEventId, [firstUser, secondUser]))).toBe('duplicate')
    await expect(repository.enqueue(event(firstEventId, [firstUser, secondUser], 'declined'))).rejects.toThrow(
      'identity conflicts',
    )
    await repository.enqueue(event(secondEventId, [secondUser, firstUser]))

    const rows = await dataSource.getRepository(TypeORMInviteEventOutbox).find({ order: { uuid: 'ASC' } })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.fanoutHash).toBe(rows[1]?.fanoutHash)
    expect(rows[0]?.eventJson).not.toMatch(/email|token|body|encrypted/i)
  })

  it('gives a pending event to only one concurrent claimant', async () => {
    await repository.enqueue(event(firstEventId, [firstUser]))

    const claims = await Promise.all([
      repository.claimNext(1_000, 500, firstLease, 3),
      repository.claimNext(1_000, 500, secondLease, 3),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.find(Boolean)).toMatchObject({ uuid: firstEventId, attempts: 1 })
  })

  it('reclaims an expired lease and fences the old token', async () => {
    await repository.enqueue(event(firstEventId, [firstUser]))
    const first = await repository.claimNext(1_000, 500, firstLease, 3)
    expect(first).not.toBeNull()

    const reclaimed = await repository.claimNext(2_000, 1_500, secondLease, 3)
    expect(reclaimed).toMatchObject({ uuid: firstEventId, lockToken: secondLease, attempts: 2 })
    await expect(repository.markPublished(firstEventId, firstLease, 2_001)).rejects.toThrow('lost its dispatch lease')
    await repository.markPublished(firstEventId, secondLease, 2_002)
  })

  it('isolates poison records, bounds attempts, redacts errors, and supports fenced requeue', async () => {
    await repository.enqueue(event(firstEventId, [firstUser]))
    await repository.enqueue(event(secondEventId, [secondUser]))
    let now = 1_000
    const publisher: DomainEventPublisherInterface = {
      publish: jest.fn(async (published) => {
        if (published.eventId === firstEventId) {
          throw new Error('secret@example.com bearer-token encrypted-body')
        }
      }),
    }
    const dispatcher = new InviteEventOutboxDispatcher(repository, publisher, {
      maximumAttempts: 2,
      retryBaseMilliseconds: 10,
      clock: () => now,
    })

    expect(await dispatcher.drain()).toEqual({ published: 1, failed: 0, retried: 1 })
    now = 1_011
    expect(await dispatcher.drain()).toEqual({ published: 0, failed: 1, retried: 0 })

    const poisoned = await dataSource.getRepository(TypeORMInviteEventOutbox).findOneByOrFail({ uuid: firstEventId })
    const healthy = await dataSource.getRepository(TypeORMInviteEventOutbox).findOneByOrFail({ uuid: secondEventId })
    expect(poisoned).toMatchObject({ status: 'failed', attempts: 2, lastErrorCode: 'ERROR' })
    expect(JSON.stringify(poisoned)).not.toContain('secret@example.com')
    expect(JSON.stringify(poisoned)).not.toContain('bearer-token')
    expect(healthy.status).toBe('published')

    expect(await repository.requeueFailed(firstEventId, 2_000)).toBe(true)
    const requeued = await repository.claimNext(2_000, 1_500, secondLease, 2)
    expect(requeued).toMatchObject({ uuid: firstEventId, lockToken: secondLease, attempts: 1 })
    await expect(repository.markPublished(firstEventId, firstLease, 2_001)).rejects.toThrow('lost its dispatch lease')
    await repository.markPublished(firstEventId, secondLease, 2_002)
  })

  it('cleans up only published records older than the retention cutoff', async () => {
    await repository.enqueue(event(firstEventId, [firstUser]))
    await repository.enqueue(event(secondEventId, [secondUser]))
    const claimed = await repository.claimNext(1_000, 500, firstLease, 3)
    await repository.markPublished(claimed?.uuid as string, claimed?.lockToken as string, 1_001)

    expect(await repository.deletePublishedBefore(1_002)).toBe(1)
    expect(await dataSource.getRepository(TypeORMInviteEventOutbox).find()).toMatchObject([
      { uuid: secondEventId, status: 'pending' },
    ])
  })

  it('rejects payload fields outside the metadata-only contract', async () => {
    const unsafe = event(firstEventId, [firstUser]) as InviteRealtimeInvalidationRequestedEvent & {
      payload: { encryptedMessage: string }
    }
    unsafe.payload.encryptedMessage = 'ciphertext'

    await expect(repository.enqueue(unsafe)).rejects.toThrow('metadata-only')
    expect(await dataSource.getRepository(TypeORMInviteEventOutbox).count()).toBe(0)
  })
})

function event(
  eventId: string,
  affectedUserUuids: string[],
  action: 'created' | 'declined' = 'created',
): InviteRealtimeInvalidationRequestedEvent {
  return {
    eventId,
    type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
    createdAt: new Date(1_000),
    meta: {
      correlation: { userIdentifier: affectedUserUuids[0] as string, userIdentifierType: 'uuid' },
      origin: DomainEventService.Auth,
    },
    payload: {
      version: 1,
      recordId: eventId,
      affectedUserUuids,
      event: {
        version: 1,
        eventId,
        kind: 'subscription-invite',
        action,
        inviteUuid,
        occurredAt: 1_000,
      },
    },
  }
}
