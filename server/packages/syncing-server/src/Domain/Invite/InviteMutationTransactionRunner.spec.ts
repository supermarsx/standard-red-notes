import { Result } from '@standardnotes/domain-core'
import { DataSource } from 'typeorm'

import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { TypeORMSyncCommandOutbox } from '../../Infra/TypeORM/TypeORMSyncCommandOutbox'
import { InviteMutationTransactionRunner } from './InviteMutationTransactionRunner'

/**
 * A failed `Result` is an ordinary outcome, not an exception — but the write it
 * was part of still has to be undone. The runner bridges those two worlds by
 * throwing across the transaction boundary and converting back on the far side,
 * so these cover what the caller and the database each end up seeing.
 */
describe('InviteMutationTransactionRunner', () => {
  let dataSource: DataSource
  let transactionContext: SyncCommandTransactionContext
  let wake: jest.Mock
  let runner: InviteMutationTransactionRunner

  const outboxRow = (uuid: string) => ({
    uuid,
    eventJson: '{}',
    status: 'pending' as const,
    attempts: 0,
    availableAtTimestamp: 1,
    lockedAtTimestamp: null,
    lockToken: null,
    createdAtTimestamp: 1,
    updatedAtTimestamp: 1,
    publishedAtTimestamp: null,
  })

  const countRows = () => dataSource.getRepository(TypeORMSyncCommandOutbox).count()

  /** Writes through the transaction's own manager, so it shares its fate. */
  const writeInsideTransaction = async (uuid: string) => {
    await transactionContext.manager?.getRepository(TypeORMSyncCommandOutbox).save(outboxRow(uuid))
  }

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSyncCommandOutbox],
      synchronize: true,
    })
    await dataSource.initialize()
    transactionContext = new SyncCommandTransactionContext()
    wake = jest.fn()
    runner = new InviteMutationTransactionRunner(dataSource, transactionContext, { wake })
  })

  afterEach(async () => {
    await dataSource.destroy()
  })

  it('returns a failed result to the caller instead of throwing it', async () => {
    const failure = Result.fail<string>('invite already accepted')

    const result = await runner.execute(async () => failure)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('invite already accepted')
  })

  it('rolls back everything the failed operation had already written', async () => {
    const result = await runner.execute(async () => {
      await writeInsideTransaction('10000000-0000-4000-8000-000000000001')
      // The write above succeeded; the mutation is refused for a domain reason.
      return Result.fail<string>('not a member of this vault')
    })

    expect(result.isFailed()).toBe(true)
    // A refused invite must leave no trace, or a retry collides with its own leftovers.
    expect(await countRows()).toBe(0)
  })

  it('does not wake the outbox dispatcher for a mutation that was refused', async () => {
    await runner.execute(async () => Result.fail<string>('refused'))

    // Nothing was committed, so there is nothing to dispatch; waking would send
    // the dispatcher to an empty outbox on every rejected invite.
    expect(wake).not.toHaveBeenCalled()
  })

  it('does not run after-commit work for a mutation that was refused', async () => {
    const afterCommit = jest.fn().mockResolvedValue(undefined)

    await runner.execute(async () => {
      transactionContext.deferUntilCommit(afterCommit)
      return Result.fail<string>('refused')
    })

    expect(afterCommit).not.toHaveBeenCalled()
  })

  it('commits, then runs after-commit work, then wakes the dispatcher', async () => {
    const order: string[] = []
    const afterCommit = jest.fn().mockImplementation(async () => {
      order.push('after-commit')
    })
    wake.mockImplementation(() => order.push('wake'))

    const result = await runner.execute(async () => {
      await writeInsideTransaction('20000000-0000-4000-8000-000000000001')
      transactionContext.deferUntilCommit(afterCommit)
      return Result.ok<string>('invited')
    })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe('invited')
    expect(await countRows()).toBe(1)
    // The dispatcher must not be woken before the work it depends on has run.
    expect(order).toEqual(['after-commit', 'wake'])
  })

  it('propagates a thrown error and rolls back with it', async () => {
    const failure = new Error('connection reset')

    await expect(
      runner.execute(async () => {
        await writeInsideTransaction('30000000-0000-4000-8000-000000000001')
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(await countRows()).toBe(0)
    expect(wake).not.toHaveBeenCalled()
  })

  it('refuses the mutation when the outbox failed inside the transaction', async () => {
    const outboxFailure = new Error('outbox enqueue failed')

    await expect(
      runner.execute(async () => {
        await writeInsideTransaction('40000000-0000-4000-8000-000000000001')
        transactionContext.markOutboxFailure(outboxFailure)
        // The operation itself is happy, but its event never reached the outbox.
        return Result.ok<string>('invited')
      }),
    ).rejects.toBe(outboxFailure)

    // Committing here would publish an invite whose realtime event is lost.
    expect(await countRows()).toBe(0)
    expect(wake).not.toHaveBeenCalled()
  })

  it('still commits when after-commit work fails, and still wakes the dispatcher', async () => {
    const afterCommit = jest.fn().mockRejectedValue(new Error('realtime notify failed'))

    const result = await runner.execute(async () => {
      await writeInsideTransaction('50000000-0000-4000-8000-000000000001')
      transactionContext.deferUntilCommit(afterCommit)
      return Result.ok<string>('invited')
    })

    // After-commit work is best-effort by design: the transaction is already
    // durable, so a failure there must not be reported as a failed mutation.
    expect(result.isFailed()).toBe(false)
    expect(await countRows()).toBe(1)
    expect(afterCommit).toHaveBeenCalled()
    expect(wake).toHaveBeenCalledTimes(1)
  })
})
