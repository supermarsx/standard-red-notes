import { DataSource, EntityManager } from 'typeorm'

import { AuthInviteEventTransactionContext } from '../../Infra/TypeORM/AuthInviteEventTransactionContext'
import { AuthInviteMutationTransactionRunner } from './AuthInviteMutationTransactionRunner'

/**
 * This is the production path for every shared-subscription invite mutation: the
 * use cases resolve the runner from the container and route through it. Its whole
 * job is deciding what commits — an unsuccessful result must roll the transaction
 * back while still reaching the caller as a value, not as an exception.
 */
describe('AuthInviteMutationTransactionRunner', () => {
  let dataSource: DataSource
  let transactionContext: AuthInviteEventTransactionContext
  let outboxWakeup: { wake: jest.Mock }
  let committed: boolean

  const manager = {} as EntityManager

  beforeEach(() => {
    committed = false
    // Mirrors TypeORM: the callback's rejection aborts the transaction, so a throw
    // that escapes the callback is exactly "this did not commit".
    dataSource = {
      transaction: jest.fn(async (runInTransaction: (entityManager: EntityManager) => Promise<unknown>) => {
        const result = await runInTransaction(manager)
        committed = true
        return result
      }),
      options: { type: 'mysql' },
    } as unknown as DataSource
    transactionContext = new AuthInviteEventTransactionContext()
    outboxWakeup = { wake: jest.fn() }
  })

  const runner = () => new AuthInviteMutationTransactionRunner(dataSource, transactionContext, outboxWakeup)

  it('commits a successful mutation, then flushes deferred work and wakes the outbox', async () => {
    const afterCommit = jest.fn().mockResolvedValue(undefined)

    const result = await runner().execute(
      async () => {
        expect(transactionContext.manager).toBe(manager)
        transactionContext.deferUntilCommit(afterCommit)
        // Deferred work must not have run while the transaction was still open.
        expect(afterCommit).not.toHaveBeenCalled()
        return { success: true, value: 'accepted' }
      },
      (result) => result.success,
    )

    expect(result).toEqual({ success: true, value: 'accepted' })
    expect(committed).toBe(true)
    expect(afterCommit).toHaveBeenCalledTimes(1)
    expect(outboxWakeup.wake).toHaveBeenCalledTimes(1)
  })

  it('rolls back an unsuccessful mutation but still returns its result to the caller', async () => {
    const afterCommit = jest.fn().mockResolvedValue(undefined)

    const result = await runner().execute(
      async () => {
        transactionContext.deferUntilCommit(afterCommit)
        return { success: false, error: 'invitation already accepted' }
      },
      (result) => result.success,
    )

    // The rejection is an internal signal, not an error the caller has to handle.
    expect(result).toEqual({ success: false, error: 'invitation already accepted' })
    expect(committed).toBe(false)
    // Nothing committed, so nothing deferred may run and the outbox has nothing new.
    expect(afterCommit).not.toHaveBeenCalled()
    expect(outboxWakeup.wake).not.toHaveBeenCalled()
  })

  it('propagates a genuine failure rather than passing it off as a mutation result', async () => {
    const failure = new Error('deadlock found when trying to get lock')

    await expect(
      runner().execute(
        async () => {
          throw failure
        },
        () => true,
      ),
    ).rejects.toBe(failure)

    expect(committed).toBe(false)
    expect(outboxWakeup.wake).not.toHaveBeenCalled()
  })

  it('does not let one failing deferred operation suppress the others or the wake', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('realtime fanout unavailable'))
    const succeeding = jest.fn().mockResolvedValue(undefined)

    const result = await runner().execute(
      async () => {
        transactionContext.deferUntilCommit(failing)
        transactionContext.deferUntilCommit(succeeding)
        return { success: true }
      },
      (result) => result.success,
    )

    expect(result).toEqual({ success: true })
    expect(failing).toHaveBeenCalledTimes(1)
    expect(succeeding).toHaveBeenCalledTimes(1)
    expect(outboxWakeup.wake).toHaveBeenCalledTimes(1)
  })

  it('rejects deferring work with no transaction in scope', () => {
    expect(() => transactionContext.deferUntilCommit(jest.fn())).toThrow(
      'Cannot defer an auth invite operation without an active transaction.',
    )
  })
})
