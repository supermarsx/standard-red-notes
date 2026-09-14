import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { DomainEventInterface } from '@standardnotes/domain-events'

import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { TypeORMSyncCommandOutbox } from './TypeORMSyncCommandOutbox'
import { TypeORMSyncCommandOutboxRepository } from './TypeORMSyncCommandOutboxRepository'

describe('TypeORMSyncCommandOutboxRepository', () => {
  let dataSource: DataSource
  let repository: TypeORMSyncCommandOutboxRepository

  const event = (): DomainEventInterface =>
    ({
      type: 'SYNC_ITEMS_PUSHED',
      createdAt: new Date(1),
      payload: {},
      meta: { correlation: { userIdentifier: 'user-uuid', userIdentifierType: 'uuid' }, origin: 'syncing-server' },
    }) as unknown as DomainEventInterface

  const row = (uuid: string) => dataSource.getRepository(TypeORMSyncCommandOutbox).findOneByOrFail({ uuid })

  // `enqueue` stamps `available_at_timestamp` with the wall clock, so claims
  // are made relative to a "now" just after enqueueing.
  let now: number

  beforeEach(async () => {
    now = Date.now() + 1_000
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSyncCommandOutbox],
      synchronize: true,
    })
    await dataSource.initialize()
    repository = new TypeORMSyncCommandOutboxRepository(
      dataSource.getRepository(TypeORMSyncCommandOutbox),
      new SyncCommandTransactionContext(),
    )
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('reports the attempt count with each claim, counting the claim itself', async () => {
    await repository.enqueue(event())

    const first = await repository.claimNext(now, 0, 'lock-1')
    expect(first?.attempts).toBe(1)

    await repository.releaseForRetry(first!.uuid, 'lock-1', now + 500)
    const second = await repository.claimNext(now + 1_000, 0, 'lock-2')
    expect(second?.uuid).toBe(first!.uuid)
    expect(second?.attempts).toBe(2)
  })

  it('marks a claimed event dead so it is never claimed again, and retention cleanup removes it', async () => {
    await repository.enqueue(event())
    const claimed = await repository.claimNext(now, 0, 'lock-1')

    await repository.markDead(claimed!.uuid, 'lock-1', now + 5_000)

    // Neither the pending branch nor the stale-dispatching branch may pick it up.
    expect(await repository.claimNext(now + 60_000, now + 60_000, 'lock-2')).toBeNull()
    const dead = await row(claimed!.uuid)
    expect(dead.status).toBe('dead')
    expect(dead.lockToken).toBeNull()
    expect(dead.lockedAtTimestamp).toBeNull()
    expect(Number(dead.updatedAtTimestamp)).toBe(now + 5_000)
    expect(Number(dead.attempts)).toBe(1)

    expect(await repository.deletePublishedBefore(now + 5_000)).toBe(0)
    expect(await repository.deletePublishedBefore(now + 5_001)).toBe(1)
  })

  it('ignores markDead from a lock token that no longer holds the claim', async () => {
    await repository.enqueue(event())
    const claimed = await repository.claimNext(now, 0, 'lock-1')

    await repository.markDead(claimed!.uuid, 'someone-else', now + 5_000)

    expect((await row(claimed!.uuid)).status).toBe('dispatching')
    // The still-dispatching row is reclaimable once its lease goes stale.
    const reclaimed = await repository.claimNext(now + 50_000, now + 20_000, 'lock-2')
    expect(reclaimed?.uuid).toBe(claimed!.uuid)
    expect(reclaimed?.attempts).toBe(2)
  })

  it('still deletes published rows by publish time and leaves pending rows alone', async () => {
    await repository.enqueue(event())
    await repository.enqueue(event())
    const claimed = await repository.claimNext(now, 0, 'lock-1')
    await repository.markPublished(claimed!.uuid, 'lock-1', now + 3_000)

    expect(await repository.deletePublishedBefore(now + 3_000)).toBe(0)
    expect(await repository.deletePublishedBefore(now + 3_001)).toBe(1)
    expect(await dataSource.getRepository(TypeORMSyncCommandOutbox).count()).toBe(1)
    expect((await repository.claimNext(now + 4_000, 0, 'lock-2'))?.attempts).toBe(1)
  })
})
