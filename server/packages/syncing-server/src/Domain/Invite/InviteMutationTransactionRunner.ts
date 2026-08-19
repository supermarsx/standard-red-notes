import { Result } from '@standardnotes/domain-core'
import { DataSource } from 'typeorm'

import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'

type OutboxWakeup = { wake(): void }

class InviteMutationRejected<T> extends Error {
  constructor(readonly result: Result<T>) {
    super('Invite mutation returned a failed result.')
  }
}

/**
 * Reuses the syncing command transaction context so repository writes and
 * domain-event outbox inserts share one EntityManager and one commit boundary.
 */
export class InviteMutationTransactionRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactionContext: SyncCommandTransactionContext,
    private readonly outboxWakeup: OutboxWakeup,
  ) {}

  async execute<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    let afterCommitOperations: Array<() => Promise<void>> = []
    let result: Result<T>

    try {
      result = await this.dataSource.transaction((manager) =>
        this.transactionContext.runInviteMutation(manager, async () => {
          const operationResult = await operation()
          if (operationResult.isFailed()) {
            throw new InviteMutationRejected(operationResult)
          }
          this.transactionContext.assertOutboxHealthy()
          afterCommitOperations = this.transactionContext.takeAfterCommitOperations()
          return operationResult
        }),
      )
    } catch (error) {
      if (error instanceof InviteMutationRejected) {
        return error.result as Result<T>
      }
      throw error
    }

    await Promise.allSettled(afterCommitOperations.map((operation) => operation()))
    this.outboxWakeup.wake()
    return result
  }
}
