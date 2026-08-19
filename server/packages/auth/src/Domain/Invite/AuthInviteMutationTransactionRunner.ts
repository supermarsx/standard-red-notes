import { DataSource } from 'typeorm'

import { runAuthTypeORMTransaction } from '../../Infra/TypeORM/AuthTypeORMTransactionCoordinator'
import { AuthInviteEventTransactionContext } from '../../Infra/TypeORM/AuthInviteEventTransactionContext'

type OutboxWakeup = { wake(): void }

class AuthInviteMutationRejected<T> extends Error {
  constructor(readonly result: T) {
    super('Auth invite mutation returned an unsuccessful result.')
  }
}

export class AuthInviteMutationTransactionRunner {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactionContext: AuthInviteEventTransactionContext,
    private readonly outboxWakeup: OutboxWakeup,
  ) {}

  async execute<T>(operation: () => Promise<T>, succeeded: (result: T) => boolean): Promise<T> {
    let afterCommitOperations: Array<() => Promise<void>> = []
    let result: T
    try {
      result = await runAuthTypeORMTransaction(this.dataSource, (manager) =>
        this.transactionContext.run(manager, async () => {
          const operationResult = await operation()
          if (!succeeded(operationResult)) {
            throw new AuthInviteMutationRejected(operationResult)
          }
          afterCommitOperations = this.transactionContext.takeAfterCommitOperations()
          return operationResult
        }),
      )
    } catch (error) {
      if (error instanceof AuthInviteMutationRejected) {
        return error.result as T
      }
      throw error
    }

    await Promise.allSettled(afterCommitOperations.map((operation) => operation()))
    this.outboxWakeup.wake()
    return result
  }
}
