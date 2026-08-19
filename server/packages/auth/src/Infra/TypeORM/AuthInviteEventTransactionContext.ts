import { AsyncLocalStorage } from 'node:async_hooks'
import { EntityManager } from 'typeorm'

type TransactionState = {
  manager: EntityManager
  afterCommitOperations: Array<() => Promise<void>>
}

export class AuthInviteEventTransactionContext {
  private readonly storage = new AsyncLocalStorage<TransactionState>()

  run<T>(manager: EntityManager, operation: () => Promise<T>): Promise<T> {
    return this.storage.run({ manager, afterCommitOperations: [] }, operation)
  }

  get manager(): EntityManager | undefined {
    return this.storage.getStore()?.manager
  }

  deferUntilCommit(operation: () => Promise<void>): void {
    const state = this.storage.getStore()
    if (!state) {
      throw new Error('Cannot defer an auth invite operation without an active transaction.')
    }
    state.afterCommitOperations.push(operation)
  }

  takeAfterCommitOperations(): Array<() => Promise<void>> {
    return this.storage.getStore()?.afterCommitOperations.splice(0) ?? []
  }
}
